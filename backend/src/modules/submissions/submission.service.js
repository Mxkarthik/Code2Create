import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';
import { runInTransaction } from '../../utils/transaction.js';
import { COMPETITION_STATUSES, Competition, DEFAULT_COMPETITION_SLUG } from '../competition/competition.model.js';
import { FrozenRosterEntry } from '../competition/frozenRoster.model.js';
import { TeamRoundState } from '../competition/teamRoundState.model.js';
import { ExecutionJob } from '../execution/executionJob.model.js';
import { getDifficultyConfig, getLanguageConfig } from '../problems/language.config.js';
import { PROBLEM_STATUSES, Problem } from '../problems/problem.model.js';
import { TEST_CASE_TYPES, TestCase } from '../problems/testCase.model.js';
import {
  ACTIVE_SUBMISSION_STATUSES,
  DEFAULT_EXECUTION_CAPACITY_KEY,
  EXECUTION_JOB_STATUSES,
  SUBMISSION_MODES,
  SUBMISSION_SETTLEMENT_STATUSES,
  SUBMISSION_STATUSES,
  TERMINAL_SUBMISSION_STATUSES
} from './submission.constants.js';
import { Submission } from './submission.model.js';
import {
  countActiveQueuedSubmissions,
  findRunSampleJobsForSubmission,
  findSubmissionById,
  findSubmissionByIdempotency
} from './submission.repository.js';
import { serializeSubmissionForParticipant } from './submission.serializer.js';
import {
  computeRequestFingerprint,
  computeSourceCodeHash,
  validateAdmitSubmissionInput
} from './submission.validation.js';

function resolveExecutionLimitsForLanguage(problem, langCfg) {
  const perLangRaw =
    problem.executionLimits?.perLanguage instanceof Map
      ? problem.executionLimits.perLanguage.get(langCfg.key)
      : problem.executionLimits?.perLanguage?.[langCfg.key];

  return {
    cpuTimeLimitSeconds:
      perLangRaw?.cpuTimeLimitSeconds ?? langCfg.executionLimits.cpuTimeLimitSeconds,
    wallTimeLimitSeconds:
      perLangRaw?.wallTimeLimitSeconds ?? langCfg.executionLimits.wallTimeLimitSeconds,
    memoryLimitKb: perLangRaw?.memoryLimitKb ?? langCfg.executionLimits.memoryLimitKb,
    maxSourceCodeBytes:
      problem.executionLimits?.maxSourceCodeBytes ?? langCfg.executionLimits.maxSourceCodeBytes,
    maxOutputBytes:
      problem.executionLimits?.maxOutputBytes ?? langCfg.executionLimits.maxOutputBytes
  };
}

async function resolveIdempotentConflictOrDuplicate({
  competitionId,
  teamId,
  submittedByUserId,
  idempotencyKey,
  requestFingerprint
}) {
  const existing = await findSubmissionByIdempotency({
    competitionId,
    teamId,
    submittedByUserId,
    idempotencyKey
  });

  if (!existing) {
    return null;
  }

  if (existing.requestFingerprint !== requestFingerprint) {
    throw new AppError(
      'Idempotency-Key was already used with a different submission payload',
      {
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_CONFLICT'
      }
    );
  }

  const sampleJobs =
    existing.mode === SUBMISSION_MODES.RUN
      ? await findRunSampleJobsForSubmission({ submissionId: existing._id })
      : [];

  return {
    submission: serializeSubmissionForParticipant(existing, sampleJobs),
    deduplicated: true
  };
}

/**
 * Atomically admit a trusted server-side RUN or SUBMIT request into MongoDB's persistent queue.
 * Never opens external Judge0 connections inside the transaction.
 */
export async function admitSubmission({
  user,
  teamId,
  challengeAttemptId,
  problemId,
  problemVersion,
  mode,
  language,
  sourceCode,
  idempotencyKey,
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  maxQueuedSubmissions = 100,
  capacityKey = DEFAULT_EXECUTION_CAPACITY_KEY,
  nowFn = () => Date.now(),
  logger
}) {
  if (!user?._id || user.isActive !== true) {
    throw AppError.forbidden('Active authenticated participant is required', 'ACCOUNT_DISABLED');
  }

  const validated = validateAdmitSubmissionInput({
    challengeAttemptId,
    problemId,
    problemVersion,
    mode,
    language,
    sourceCode,
    idempotencyKey
  });

  const langCfg = getLanguageConfig(validated.language);
  const sourceCodeHash = computeSourceCodeHash(validated.sourceCode);
  const initialFingerprint = computeRequestFingerprint({
    challengeAttemptId: validated.challengeAttemptId,
    problemId: validated.problemId,
    problemVersion: validated.problemVersion,
    mode: validated.mode,
    language: langCfg.key,
    sourceCodeHash
  });

  let resolvedCompetitionId = null;
  let resolvedProblemVersion = validated.problemVersion ?? null;
  let resolvedFingerprint = initialFingerprint;

  try {
    const result = await runInTransaction(async (session) => {
      const admittedAtMs = nowFn();
      const admittedAtDate = new Date(admittedAtMs);

      const competition = await Competition.findOne({ slug: competitionSlug })
        .session(session)
        .lean();

      if (!competition) {
        throw AppError.serviceUnavailable(
          'Competition configuration has not been initialized',
          'COMPETITION_NOT_INITIALIZED'
        );
      }

      resolvedCompetitionId = competition._id;

      if (
        competition.status === COMPETITION_STATUSES.LOBBY ||
        competition.status === COMPETITION_STATUSES.LOCKED
      ) {
        throw new AppError('Competition is not live yet', {
          statusCode: 409,
          code: 'COMPETITION_NOT_LIVE'
        });
      }

      if (
        competition.status === COMPETITION_STATUSES.SETTLING ||
        competition.status === COMPETITION_STATUSES.COMPLETED ||
        !competition.endsAt ||
        admittedAtMs >= new Date(competition.endsAt).getTime()
      ) {
        throw new AppError('Competition deadline has been reached; admissions are closed', {
          statusCode: 409,
          code: 'COMPETITION_DEADLINE_REACHED'
        });
      }

      const frozenEntry = await FrozenRosterEntry.findOne({
        competitionId: competition._id,
        ...(teamId ? { teamId } : {}),
        frozenMemberIds: user._id
      })
        .session(session)
        .lean();

      if (!frozenEntry) {
        throw AppError.forbidden(
          'You are not an eligible frozen roster member for this team',
          'TEAM_NOT_ELIGIBLE'
        );
      }

      const effectiveTeamId = frozenEntry.teamId;

      const problem = await Problem.findOne({
        _id: validated.problemId,
        competitionId: competition._id,
        status: PROBLEM_STATUSES.PUBLISHED
      })
        .session(session)
        .lean();

      if (!problem) {
        throw AppError.notFound('Published problem not found', 'PROBLEM_NOT_FOUND');
      }

      if (validated.problemVersion !== undefined && problem.version !== validated.problemVersion) {
        throw new AppError('Problem version mismatch for submission admission', {
          statusCode: 409,
          code: 'PROBLEM_VERSION_CONFLICT'
        });
      }

      resolvedProblemVersion = problem.version;
      resolvedFingerprint = computeRequestFingerprint({
        challengeAttemptId: validated.challengeAttemptId,
        problemId: problem._id,
        problemVersion: problem.version,
        mode: validated.mode,
        language: langCfg.key,
        sourceCodeHash
      });

      // Check scoped idempotency BEFORE pending-submission reservation so safe retries succeed.
      const existingByKey = await findSubmissionByIdempotency({
        competitionId: competition._id,
        teamId: effectiveTeamId,
        submittedByUserId: user._id,
        idempotencyKey: validated.idempotencyKey,
        session
      });

      if (existingByKey) {
        if (existingByKey.requestFingerprint !== resolvedFingerprint) {
          throw new AppError(
            'Idempotency-Key was already used with a different submission payload',
            {
              statusCode: 409,
              code: 'IDEMPOTENCY_KEY_CONFLICT'
            }
          );
        }

        const sampleJobs =
          existingByKey.mode === SUBMISSION_MODES.RUN
            ? await findRunSampleJobsForSubmission({
                submissionId: existingByKey._id,
                session
              })
            : [];

        return {
          submission: serializeSubmissionForParticipant(existingByKey, sampleJobs),
          deduplicated: true
        };
      }

      if (!problem.allowedLanguages.includes(langCfg.key)) {
        throw new AppError(`Language ${langCfg.key} is not allowed for this problem`, {
          statusCode: 400,
          code: 'LANGUAGE_NOT_ALLOWED'
        });
      }

      const limitsForLang = resolveExecutionLimitsForLanguage(problem, langCfg);
      if (validated.sourceCodeBytes > limitsForLang.maxSourceCodeBytes) {
        throw new AppError(
          `Source code exceeds problem limit (${limitsForLang.maxSourceCodeBytes} bytes)`,
          {
            statusCode: 400,
            code: 'SOURCE_CODE_TOO_LARGE'
          }
        );
      }

      const requiredType =
        validated.mode === SUBMISSION_MODES.RUN
          ? TEST_CASE_TYPES.SAMPLE
          : TEST_CASE_TYPES.HIDDEN;

      const selectedCases = await TestCase.find({
        competitionId: competition._id,
        problemId: problem._id,
        type: requiredType
      })
        .sort({ displayOrder: 1 })
        .session(session)
        .lean();

      if (selectedCases.length === 0) {
        throw new AppError(`No ${requiredType} test cases available for execution`, {
          statusCode: 409,
          code: 'PROBLEM_TEST_CASES_MISSING'
        });
      }

      const queuedCount = await countActiveQueuedSubmissions({
        competitionId: competition._id,
        session
      });

      if (queuedCount >= maxQueuedSubmissions) {
        throw AppError.serviceUnavailable(
          'Execution queue is temporarily full; please retry shortly',
          'EXECUTION_QUEUE_FULL'
        );
      }

      const newSubmissionId = new mongoose.Types.ObjectId();

      // Atomic per-team single-pending reservation
      const reservedState = await TeamRoundState.findOneAndUpdate(
        {
          competitionId: competition._id,
          teamId: effectiveTeamId,
          pendingSubmissionId: null
        },
        {
          $set: { pendingSubmissionId: newSubmissionId },
          $inc: { stateVersion: 1 }
        },
        { session, returnDocument: 'after' }
      ).lean();

      if (!reservedState) {
        const currentRoundState = await TeamRoundState.findOne({
          competitionId: competition._id,
          teamId: effectiveTeamId
        })
          .session(session)
          .lean();

        if (!currentRoundState) {
          throw AppError.forbidden('Team round state is not initialized', 'TEAM_NOT_ELIGIBLE');
        }

        throw new AppError(
          'Your team already has a pending submission in progress',
          {
            statusCode: 409,
            code: 'EXECUTION_ALREADY_PENDING'
          }
        );
      }

      const difficultyCfg = getDifficultyConfig(problem.difficulty);
      void difficultyCfg;

      const [createdSubmission] = await Submission.create(
        [
          {
            _id: newSubmissionId,
            competitionId: competition._id,
            teamId: effectiveTeamId,
            submittedByUserId: user._id,
            challengeAttemptId: new mongoose.Types.ObjectId(validated.challengeAttemptId),
            problemId: problem._id,
            problemVersion: problem.version,
            mode: validated.mode,
            language: langCfg.key,
            sourceCode: validated.sourceCode,
            sourceCodeBytes: validated.sourceCodeBytes,
            sourceCodeHash,
            idempotencyKey: validated.idempotencyKey,
            requestFingerprint: resolvedFingerprint,
            status: SUBMISSION_STATUSES.QUEUED,
            verdict: null,
            totalCaseCount: selectedCases.length,
            completedCaseCount: 0,
            passedCaseCount: 0,
            failedCaseCount: 0,
            skippedCaseCount: 0,
            executionJobsCreated: selectedCases.length,
            executionJobsDispatched: 0,
            admittedAt: admittedAtDate,
            competitionEndsAt: competition.endsAt,
            settlementStatus: SUBMISSION_SETTLEMENT_STATUSES.NOT_READY
          }
        ],
        { session }
      );

      // Persist immutable ExecutionJob snapshots sequentially inside the transaction.
      for (const tc of selectedCases) {
        await ExecutionJob.create(
          [
            {
              competitionId: competition._id,
              submissionId: createdSubmission._id,
              teamId: effectiveTeamId,
              problemId: problem._id,
              problemVersion: problem.version,
              testCaseId: tc._id,
              testCaseOrder: tc.displayOrder,
              testCaseType: tc.type,
              testCaseInput: tc.input,
              expectedOutput: tc.expectedOutput,
              mode: validated.mode,
              language: langCfg.key,
              judge0LanguageId: langCfg.judge0LanguageId,
              executionLimits: limitsForLang,
              capacityKey,
              status: EXECUTION_JOB_STATUSES.QUEUED,
              fencingVersion: 0,
              retryCount: 0
            }
          ],
          { session }
        );
      }

      const sampleJobsForReturn =
        validated.mode === SUBMISSION_MODES.RUN
          ? selectedCases.map((tc) => ({
              testCaseType: tc.type,
              testCaseOrder: tc.displayOrder,
              status: EXECUTION_JOB_STATUSES.QUEUED,
              resultVerdict: null,
              testCaseInput: tc.input,
              expectedOutput: tc.expectedOutput,
              actualOutputSnapshot: '',
              stderrSnapshot: '',
              compileOutputSnapshot: ''
            }))
          : [];

      return {
        submission: serializeSubmissionForParticipant(createdSubmission, sampleJobsForReturn),
        deduplicated: false
      };
    });

    if (!result.deduplicated) {
      logger?.info?.(
        {
          submissionId: result.submission.id,
          teamId: result.submission.teamId,
          mode: result.submission.mode,
          language: result.submission.language,
          totalCases: result.submission.totalCaseCount
        },
        'Submission admitted to execution queue'
      );
    }

    return result;
  } catch (err) {
    // Reconcile simultaneous identical-idempotency-key race or uncertain commit outcomes cleanly.
    const isDuplicateIdempotency =
      err?.code === 11000 &&
      (err?.keyPattern?.idempotencyKey || String(err?.message || '').includes('idempotencyKey'));
    const isUnknownCommit =
      typeof err?.hasErrorLabel === 'function' && err.hasErrorLabel('UnknownTransactionCommitResult');

    if ((isDuplicateIdempotency || isUnknownCommit) && resolvedCompetitionId && teamId) {
      const recovered = await resolveIdempotentConflictOrDuplicate({
        competitionId: resolvedCompetitionId,
        teamId,
        submittedByUserId: user._id,
        idempotencyKey: validated.idempotencyKey,
        requestFingerprint: resolvedFingerprint
      });
      if (recovered) {
        return recovered;
      }
    }

    // Check also via user lookup if teamId wasn't explicitly passed when duplicate key fired.
    if ((isDuplicateIdempotency || isUnknownCommit) && resolvedCompetitionId && !teamId) {
      const frozen = await FrozenRosterEntry.findOne({
        competitionId: resolvedCompetitionId,
        frozenMemberIds: user._id
      }).lean();
      if (frozen) {
        const recovered = await resolveIdempotentConflictOrDuplicate({
          competitionId: resolvedCompetitionId,
          teamId: frozen.teamId,
          submittedByUserId: user._id,
          idempotencyKey: validated.idempotencyKey,
          requestFingerprint: resolvedFingerprint
        });
        if (recovered) {
          return recovered;
        }
      }
    }

    throw err;
  }
}

/**
 * Retrieve a participant-safe submission status & result view scoped strictly to teamId.
 */
export async function getSubmissionForTeam({ competitionId, teamId, submissionId }) {
  const submission = await findSubmissionById({ competitionId, teamId, submissionId });
  if (!submission) {
    throw AppError.notFound('Submission not found for your team', 'SUBMISSION_NOT_FOUND');
  }

  const sampleJobs =
    submission.mode === SUBMISSION_MODES.RUN
      ? await findRunSampleJobsForSubmission({ submissionId: submission._id })
      : [];

  return serializeSubmissionForParticipant(submission, sampleJobs);
}

/**
 * Atomic gameplay settlement contract for Phase 08 (and controlled Phase 07 isolated tests).
 * Never mounted on HTTP routes. Only settles a matching PENDING_SETTLEMENT submission once,
 * and clears TeamRoundState.pendingSubmissionId ONLY when it matches submissionId.
 */
export async function settleSubmissionInternal({
  competitionId,
  teamId,
  submissionId,
  applyStateUpdateFn,
  nowFn = () => Date.now(),
  logger
}) {
  const result = await runInTransaction(async (session) => {
    const settledAt = new Date(nowFn());

    const settledSubmission = await Submission.findOneAndUpdate(
      {
        _id: submissionId,
        competitionId,
        teamId,
        status: { $in: TERMINAL_SUBMISSION_STATUSES },
        settlementStatus: SUBMISSION_SETTLEMENT_STATUSES.PENDING_SETTLEMENT
      },
      {
        $set: {
          settlementStatus: SUBMISSION_SETTLEMENT_STATUSES.SETTLED,
          settledAt
        },
        $inc: { settlementVersion: 1 }
      },
      { session, returnDocument: 'after' }
    ).lean();

    if (!settledSubmission) {
      const existing = await Submission.findOne({
        _id: submissionId,
        competitionId,
        teamId
      })
        .session(session)
        .lean();

      if (!existing) {
        throw AppError.notFound('Submission not found for settlement', 'SUBMISSION_NOT_FOUND');
      }

      if (existing.settlementStatus === SUBMISSION_SETTLEMENT_STATUSES.SETTLED) {
        throw new AppError('Submission has already been settled', {
          statusCode: 409,
          code: 'SUBMISSION_ALREADY_SETTLED'
        });
      }

      if (!ACTIVE_SUBMISSION_STATUSES.includes(existing.status)) {
        throw new AppError('Submission is not in a settleable state', {
          statusCode: 409,
          code: 'SUBMISSION_NOT_READY_FOR_SETTLEMENT'
        });
      }

      throw new AppError('Submission execution is not yet complete', {
        statusCode: 409,
        code: 'SUBMISSION_NOT_READY_FOR_SETTLEMENT'
      });
    }

    // Conditionally clear TeamRoundState reservation ONLY if it matches this exact submissionId.
    const updatedRoundState = await TeamRoundState.findOneAndUpdate(
      {
        competitionId,
        teamId,
        pendingSubmissionId: settledSubmission._id
      },
      {
        $set: { pendingSubmissionId: null },
        $inc: { stateVersion: 1 }
      },
      { session, returnDocument: 'after' }
    ).lean();

    if (!updatedRoundState) {
      throw new AppError(
        'Team pending execution reservation does not match submission being settled',
        {
          statusCode: 409,
          code: 'TEAM_RESERVATION_MISMATCH'
        }
      );
    }

    if (typeof applyStateUpdateFn === 'function') {
      await applyStateUpdateFn({
        session,
        submission: settledSubmission,
        teamRoundState: updatedRoundState
      });
    }

    return {
      submission: serializeSubmissionForParticipant(settledSubmission),
      teamRoundState: {
        teamId: updatedRoundState.teamId.toString(),
        pendingSubmissionId: updatedRoundState.pendingSubmissionId,
        stateVersion: updatedRoundState.stateVersion
      }
    };
  });

  logger?.info?.(
    {
      submissionId: result.submission.id,
      teamId: result.submission.teamId,
      verdict: result.submission.verdict
    },
    'Submission settled'
  );

  return result;
}
