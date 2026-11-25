import crypto from 'node:crypto';
import { JUDGE0_ERROR_CODES, isJudge0Error } from '../../integrations/judge0/judge0.errors.js';
import { EXECUTION_STATUSES } from '../../integrations/judge0/judge0.mapper.js';
import { runInTransaction } from '../../utils/transaction.js';
import { TEST_CASE_TYPES } from '../problems/testCase.model.js';
import {
  ACTIVE_SUBMISSION_STATUSES,
  CAPACITY_OCCUPYING_JOB_STATUSES,
  DEFAULT_EXECUTION_CAPACITY_KEY,
  EXECUTION_JOB_STATUSES,
  PARTICIPANT_FAILURE_PRECEDENCE,
  SUBMISSION_MODES,
  SUBMISSION_SETTLEMENT_STATUSES,
  SUBMISSION_STATUSES,
  SUBMISSION_VERDICTS
} from '../submissions/submission.constants.js';
import { Submission } from '../submissions/submission.model.js';
import { ExecutionCapacity } from './executionCapacity.model.js';
import { ExecutionJob } from './executionJob.model.js';
import {
  ensureExecutionCapacityDoc,
  releaseCapacitySlot,
  reserveCapacitySlot,
  selectNextFairQueuedJobs
} from './executionScheduler.js';
import { evaluateTestCaseResult } from './testCaseEvaluator.js';

const RETRYABLE_PRE_ADMISSION_CODES = new Set([
  JUDGE0_ERROR_CODES.UNREACHABLE,
  JUDGE0_ERROR_CODES.QUEUE_SATURATED
]);

const RETRYABLE_POLL_ERROR_CODES = new Set([
  JUDGE0_ERROR_CODES.TIMEOUT,
  JUDGE0_ERROR_CODES.UNREACHABLE,
  JUDGE0_ERROR_CODES.QUEUE_SATURATED
]);

/**
 * Recompute submission counters and transition to terminal status at most once (idempotent).
 */
export async function reconcileSubmissionProgress({
  submissionId,
  nowFn = () => Date.now(),
  logger
}) {
  const submission = await Submission.findById(submissionId).lean();
  if (!submission) {
    return null;
  }

  const jobs = await ExecutionJob.find({ submissionId })
    .select('+compileOutputSnapshot')
    .sort({ testCaseOrder: 1 })
    .lean();

  if (jobs.length === 0) {
    return submission;
  }

  const completedJobs = jobs.filter((j) => j.status === EXECUTION_JOB_STATUSES.COMPLETED);
  const skippedJobs = jobs.filter((j) => j.status === EXECUTION_JOB_STATUSES.SKIPPED);
  const systemFailedJobs = jobs.filter((j) => j.status === EXECUTION_JOB_STATUSES.SYSTEM_FAILED);
  const uncertainJobs = jobs.filter((j) => j.status === EXECUTION_JOB_STATUSES.ADMISSION_UNCERTAIN);
  const activeOrQueuedJobs = jobs.filter(
    (j) =>
      j.status === EXECUTION_JOB_STATUSES.QUEUED ||
      j.status === EXECUTION_JOB_STATUSES.DISPATCHING ||
      j.status === EXECUTION_JOB_STATUSES.SUBMITTED ||
      j.status === EXECUTION_JOB_STATUSES.POLLING
  );

  const passedJobs = completedJobs.filter(
    (j) => j.resultVerdict === SUBMISSION_VERDICTS.ACCEPTED
  );
  const participantFailures = completedJobs.filter(
    (j) =>
      j.resultVerdict &&
      j.resultVerdict !== SUBMISSION_VERDICTS.ACCEPTED &&
      j.resultVerdict !== SUBMISSION_VERDICTS.SYSTEM_ERROR
  );

  const maxTimeSeconds = completedJobs.reduce(
    (acc, j) => (j.executionTime !== null && (acc === null || j.executionTime > acc) ? j.executionTime : acc),
    null
  );
  const maxMemoryKb = completedJobs.reduce(
    (acc, j) => (j.memoryUsage !== null && (acc === null || j.memoryUsage > acc) ? j.memoryUsage : acc),
    null
  );

  const compileFailJob = completedJobs.find(
    (j) => j.resultVerdict === SUBMISSION_VERDICTS.COMPILATION_ERROR && j.compileOutputSnapshot
  );

  const progressSet = {
    completedCaseCount: completedJobs.length,
    passedCaseCount: passedJobs.length,
    failedCaseCount: participantFailures.length + systemFailedJobs.length,
    skippedCaseCount: skippedJobs.length,
    maxTimeSeconds,
    maxMemoryKb,
    ...(compileFailJob ? { compileOutput: compileFailJob.compileOutputSnapshot } : {})
  };

  // Still awaiting in-flight work or reconciliation
  if (activeOrQueuedJobs.length > 0 || uncertainJobs.length > 0) {
    const nextActiveStatus =
      uncertainJobs.length > 0 && activeOrQueuedJobs.length === 0
        ? SUBMISSION_STATUSES.AWAITING_RECONCILIATION
        : SUBMISSION_STATUSES.PROCESSING;

    await Submission.updateOne(
      {
        _id: submissionId,
        status: { $in: ACTIVE_SUBMISSION_STATUSES }
      },
      {
        $set: {
          ...progressSet,
          ...(submission.status === SUBMISSION_STATUSES.QUEUED || uncertainJobs.length > 0
            ? { status: nextActiveStatus }
            : {})
        }
      }
    );

    return Submission.findById(submissionId).lean();
  }

  // Every job for this submission is terminal (COMPLETED, SKIPPED, SYSTEM_FAILED)
  const completedAtDate = new Date(nowFn());

  let terminalStatus = SUBMISSION_STATUSES.SYSTEM_FAILED;
  let finalVerdict = SUBMISSION_VERDICTS.SYSTEM_ERROR;
  let systemErrorCode = null;
  let systemErrorMessage = null;

  if (participantFailures.length > 0) {
    terminalStatus = SUBMISSION_STATUSES.EXECUTION_COMPLETED;
    for (const candidateVerdict of PARTICIPANT_FAILURE_PRECEDENCE) {
      if (participantFailures.some((j) => j.resultVerdict === candidateVerdict)) {
        finalVerdict = candidateVerdict;
        break;
      }
    }
  } else if (systemFailedJobs.length > 0 || passedJobs.length < submission.totalCaseCount) {
    terminalStatus = SUBMISSION_STATUSES.SYSTEM_FAILED;
    finalVerdict = SUBMISSION_VERDICTS.SYSTEM_ERROR;
    const firstSysErr = systemFailedJobs.find((j) => j.sanitizedSystemError)?.sanitizedSystemError;
    systemErrorCode = firstSysErr?.code ?? 'EXECUTION_INFRASTRUCTURE_ERROR';
    systemErrorMessage =
      firstSysErr?.message ?? 'Execution infrastructure failed before completing required cases';
  } else if (submission.totalCaseCount > 0 && passedJobs.length === submission.totalCaseCount) {
    terminalStatus = SUBMISSION_STATUSES.EXECUTION_COMPLETED;
    finalVerdict = SUBMISSION_VERDICTS.ACCEPTED;
  }

  const finalized = await Submission.findOneAndUpdate(
    {
      _id: submissionId,
      status: { $in: ACTIVE_SUBMISSION_STATUSES }
    },
    {
      $set: {
        ...progressSet,
        status: terminalStatus,
        verdict: finalVerdict,
        executionCompletedAt: completedAtDate,
        settlementStatus: SUBMISSION_SETTLEMENT_STATUSES.PENDING_SETTLEMENT,
        systemErrorCode,
        systemErrorMessage
      }
    },
    { returnDocument: 'after' }
  ).lean();

  if (finalized && terminalStatus === SUBMISSION_STATUSES.SYSTEM_FAILED) {
    logger?.warn?.(
      {
        submissionId: finalized._id.toString(),
        teamId: finalized.teamId.toString(),
        errorCode: systemErrorCode
      },
      'Submission finished with infrastructure error'
    );
  }

  return finalized ?? Submission.findById(submissionId).lean();
}

/**
 * Claim QUEUED jobs fairly and atomically persist dispatch intent + global capacity BEFORE external POST.
 */
export async function claimNextJobsForDispatch({
  workerId,
  capacityKey = DEFAULT_EXECUTION_CAPACITY_KEY,
  maxInFlight = 8,
  leaseDurationMs = 30000,
  nowFn = () => Date.now()
}) {
  const candidates = await selectNextFairQueuedJobs({
    capacityKey,
    maxInFlight,
    nowMs: nowFn()
  });

  if (candidates.length === 0) {
    return [];
  }

  const claimed = [];
  for (const candidate of candidates) {
    const claimedJob = await runInTransaction(async (session) => {
      const claimNowMs = nowFn();
      const claimNowDate = new Date(claimNowMs);
      const leaseUntil = new Date(claimNowMs + leaseDurationMs);
      const dispatchAttemptId = crypto.randomUUID();

      const slotReserved = await reserveCapacitySlot({
        capacityKey,
        jobId: candidate._id,
        maxInFlight,
        session
      });
      if (!slotReserved) {
        return null;
      }

      const jobDoc = await ExecutionJob.findOneAndUpdate(
        {
          _id: candidate._id,
          status: EXECUTION_JOB_STATUSES.QUEUED
        },
        {
          $set: {
            status: EXECUTION_JOB_STATUSES.DISPATCHING,
            dispatchAttemptId,
            dispatchStartedAt: claimNowDate,
            leaseOwner: workerId,
            leaseExpiresAt: leaseUntil,
            sanitizedSystemError: null
          },
          $inc: { fencingVersion: 1 }
        },
        { session, returnDocument: 'after' }
      )
        .select('+testCaseInput +expectedOutput')
        .lean();

      if (!jobDoc) {
        await releaseCapacitySlot({ capacityKey, jobId: candidate._id, session });
        return null;
      }

      await Submission.updateOne(
        {
          _id: jobDoc.submissionId,
          status: { $in: [SUBMISSION_STATUSES.QUEUED, SUBMISSION_STATUSES.PROCESSING] }
        },
        {
          $set: {
            status: SUBMISSION_STATUSES.PROCESSING,
            lastDispatchedAt: claimNowDate
          },
          $inc: { executionJobsDispatched: 1 }
        },
        { session }
      );

      await Submission.updateOne(
        {
          _id: jobDoc.submissionId,
          processingStartedAt: null
        },
        {
          $set: { processingStartedAt: claimNowDate }
        },
        { session }
      );

      return jobDoc;
    });

    if (claimedJob) {
      claimed.push(claimedJob);
    }
  }

  return claimed;
}

/**
 * Renew lease on an actively owned job using strict leaseOwner + fencingVersion check.
 */
export async function renewJobLease({
  jobId,
  workerId,
  fencingVersion,
  leaseDurationMs = 30000,
  nowFn = () => Date.now()
}) {
  const leaseExpiresAt = new Date(nowFn() + leaseDurationMs);
  const updated = await ExecutionJob.findOneAndUpdate(
    {
      _id: jobId,
      leaseOwner: workerId,
      fencingVersion
    },
    {
      $set: { leaseExpiresAt }
    },
    { returnDocument: 'after' }
  ).lean();

  return Boolean(updated);
}

/**
 * Send external Judge0 POST /submissions for an already-fenced DISPATCHING job,
 * handling token persistence, retryable pre-admission failure, and uncertain admission safely.
 */
export async function dispatchClaimedJob({
  job,
  workerId,
  judge0Service,
  retryMaxAttempts = 3,
  pollIntervalMs = 750,
  nowFn = () => Date.now(),
  logger
}) {
  const submission = await Submission.findById(job.submissionId).select('+sourceCode').lean();
  if (!submission) {
    await ExecutionJob.updateOne(
      { _id: job._id, leaseOwner: workerId, fencingVersion: job.fencingVersion },
      {
        $set: {
          status: EXECUTION_JOB_STATUSES.SYSTEM_FAILED,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(nowFn()),
          sanitizedSystemError: {
            code: 'SUBMISSION_NOT_FOUND',
            message: 'Parent submission not found during job dispatch'
          }
        },
        $inc: { fencingVersion: 1 }
      }
    );
    await releaseCapacitySlot({ capacityKey: job.capacityKey, jobId: job._id });
    return { outcome: 'SYSTEM_FAILED' };
  }

  try {
    const admission = await judge0Service.createSubmission({
      language: job.language,
      sourceCode: submission.sourceCode,
      stdin: job.testCaseInput ?? '',
      executionLimits: job.executionLimits
    });

    const nowMs = nowFn();
    const saved = await ExecutionJob.findOneAndUpdate(
      {
        _id: job._id,
        status: EXECUTION_JOB_STATUSES.DISPATCHING,
        leaseOwner: workerId,
        fencingVersion: job.fencingVersion
      },
      {
        $set: {
          status: EXECUTION_JOB_STATUSES.POLLING,
          judge0Token: admission.token,
          nextPollAt: new Date(nowMs + Math.min(250, pollIntervalMs)),
          leaseOwner: null,
          leaseExpiresAt: null
        },
        $inc: { fencingVersion: 1 }
      },
      { returnDocument: 'after' }
    ).lean();

    if (!saved) {
      logger?.warn?.(
        { jobId: job._id.toString(), workerId },
        'Stale worker write rejected after Judge0 submission admission'
      );
      return { outcome: 'STALE_FENCED' };
    }

    return { outcome: 'POLLING', jobId: saved._id.toString() };
  } catch (err) {
    const nowMs = nowFn();
    const nowDate = new Date(nowMs);
    const errCode = isJudge0Error(err) ? err.code : JUDGE0_ERROR_CODES.INTERNAL_ERROR;
    const errMessage = err?.message || 'Judge0 submission failed';

    // CRITICAL: Ambiguous POST failures NEVER auto-retry and NEVER free capacity blindly.
    if (isJudge0Error(err) && err.admissionUncertain) {
      const uncertainSaved = await ExecutionJob.findOneAndUpdate(
        {
          _id: job._id,
          status: EXECUTION_JOB_STATUSES.DISPATCHING,
          leaseOwner: workerId,
          fencingVersion: job.fencingVersion
        },
        {
          $set: {
            status: EXECUTION_JOB_STATUSES.ADMISSION_UNCERTAIN,
            uncertainSince: nowDate,
            leaseOwner: null,
            leaseExpiresAt: null,
            sanitizedSystemError: { code: errCode, message: errMessage }
          },
          $inc: { fencingVersion: 1 }
        },
        { returnDocument: 'after' }
      ).lean();

      if (uncertainSaved) {
        logger?.warn?.(
          {
            submissionId: job.submissionId.toString(),
            jobId: job._id.toString(),
            errorCode: errCode
          },
          'Submission admission requires reconciliation'
        );
        await reconcileSubmissionProgress({
          submissionId: job.submissionId,
          nowFn,
          logger
        });
      }

      return { outcome: 'ADMISSION_UNCERTAIN', errorCode: errCode };
    }

    // Definitive pre-admission non-acceptance: retryable only if explicitly known safe & within budget
    if (
      isJudge0Error(err) &&
      RETRYABLE_PRE_ADMISSION_CODES.has(err.code) &&
      job.retryCount < retryMaxAttempts
    ) {
      const backoffMs = Math.min(3000, 150 * (job.retryCount + 1));
      const requeued = await ExecutionJob.findOneAndUpdate(
        {
          _id: job._id,
          status: EXECUTION_JOB_STATUSES.DISPATCHING,
          leaseOwner: workerId,
          fencingVersion: job.fencingVersion
        },
        {
          $set: {
            status: EXECUTION_JOB_STATUSES.QUEUED,
            dispatchAttemptId: null,
            nextPollAt: new Date(nowMs + backoffMs),
            leaseOwner: null,
            leaseExpiresAt: null,
            sanitizedSystemError: { code: errCode, message: errMessage }
          },
          $inc: { retryCount: 1, fencingVersion: 1 }
        },
        { returnDocument: 'after' }
      ).lean();

      if (requeued) {
        await releaseCapacitySlot({ capacityKey: job.capacityKey, jobId: job._id });
      }
      return { outcome: 'REQUEUED', errorCode: errCode };
    }

    const failedSaved = await ExecutionJob.findOneAndUpdate(
      {
        _id: job._id,
        status: EXECUTION_JOB_STATUSES.DISPATCHING,
        leaseOwner: workerId,
        fencingVersion: job.fencingVersion
      },
      {
        $set: {
          status: EXECUTION_JOB_STATUSES.SYSTEM_FAILED,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: nowDate,
          resultVerdict: SUBMISSION_VERDICTS.SYSTEM_ERROR,
          sanitizedSystemError: { code: errCode, message: errMessage }
        },
        $inc: { fencingVersion: 1 }
      },
      { returnDocument: 'after' }
    ).lean();

    if (failedSaved) {
      await releaseCapacitySlot({ capacityKey: job.capacityKey, jobId: job._id });
      await reconcileSubmissionProgress({
        submissionId: job.submissionId,
        nowFn,
        logger
      });
    }

    return { outcome: 'SYSTEM_FAILED', errorCode: errCode };
  }
}

/**
 * Atomically claim due SUBMITTED / POLLING jobs whose leases are free or expired.
 */
export async function claimDuePollingJobs({
  workerId,
  capacityKey = DEFAULT_EXECUTION_CAPACITY_KEY,
  batchLimit = 8,
  leaseDurationMs = 30000,
  nowFn = () => Date.now()
}) {
  const nowMs = nowFn();
  const nowDate = new Date(nowMs);

  const dueCandidates = await ExecutionJob.find({
    capacityKey,
    status: { $in: [EXECUTION_JOB_STATUSES.SUBMITTED, EXECUTION_JOB_STATUSES.POLLING] },
    $or: [{ nextPollAt: null }, { nextPollAt: { $lte: nowDate } }],
    $and: [
      {
        $or: [{ leaseOwner: null }, { leaseExpiresAt: { $lte: nowDate } }]
      }
    ]
  })
    .select('_id fencingVersion leaseExpiresAt')
    .sort({ nextPollAt: 1, _id: 1 })
    .limit(batchLimit)
    .lean();

  const claimed = [];
  for (const candidate of dueCandidates) {
    const leaseNow = nowFn();
    const updated = await ExecutionJob.findOneAndUpdate(
      {
        _id: candidate._id,
        status: { $in: [EXECUTION_JOB_STATUSES.SUBMITTED, EXECUTION_JOB_STATUSES.POLLING] },
        fencingVersion: candidate.fencingVersion,
        $or: [{ leaseOwner: null }, { leaseExpiresAt: { $lte: new Date(leaseNow) } }]
      },
      {
        $set: {
          status: EXECUTION_JOB_STATUSES.POLLING,
          leaseOwner: workerId,
          leaseExpiresAt: new Date(leaseNow + leaseDurationMs)
        },
        $inc: { fencingVersion: 1 }
      },
      { returnDocument: 'after' }
    )
      .select('+judge0Token +testCaseInput +expectedOutput')
      .lean();

    if (updated) {
      claimed.push(updated);
    }
  }

  return claimed;
}

/**
 * Poll Judge0 once for a claimed SUBMITTED/POLLING job using its persisted token,
 * guarding all updates with fencingVersion + leaseOwner and releasing capacity cleanly.
 */
export async function pollClaimedJob({
  job,
  workerId,
  judge0Service,
  pollIntervalMs = 750,
  pollTimeoutMs = 60000,
  retryMaxAttempts = 3,
  nowFn = () => Date.now(),
  logger
}) {
  if (!job.judge0Token) {
    const failed = await ExecutionJob.findOneAndUpdate(
      {
        _id: job._id,
        status: EXECUTION_JOB_STATUSES.POLLING,
        leaseOwner: workerId,
        fencingVersion: job.fencingVersion
      },
      {
        $set: {
          status: EXECUTION_JOB_STATUSES.SYSTEM_FAILED,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(nowFn()),
          resultVerdict: SUBMISSION_VERDICTS.SYSTEM_ERROR,
          sanitizedSystemError: {
            code: 'MISSING_JUDGE0_TOKEN',
            message: 'Execution job entered polling state without a Judge0 token'
          }
        },
        $inc: { fencingVersion: 1 }
      },
      { returnDocument: 'after' }
    ).lean();

    if (failed) {
      await releaseCapacitySlot({ capacityKey: job.capacityKey, jobId: job._id });
      await reconcileSubmissionProgress({ submissionId: job.submissionId, nowFn, logger });
    }
    return { outcome: 'SYSTEM_FAILED' };
  }

  try {
    const mappedResult = await judge0Service.getSubmissionResult({
      token: job.judge0Token,
      maxOutputBytes: job.executionLimits.maxOutputBytes
    });

    const nowMs = nowFn();
    const nowDate = new Date(nowMs);

    if (!mappedResult.isTerminal) {
      const dispatchStartedMs = job.dispatchStartedAt
        ? new Date(job.dispatchStartedAt).getTime()
        : nowMs;

      if (nowMs - dispatchStartedMs >= pollTimeoutMs) {
        const timedOut = await ExecutionJob.findOneAndUpdate(
          {
            _id: job._id,
            status: EXECUTION_JOB_STATUSES.POLLING,
            leaseOwner: workerId,
            fencingVersion: job.fencingVersion
          },
          {
            $set: {
              status: EXECUTION_JOB_STATUSES.SYSTEM_FAILED,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastPolledAt: nowDate,
              completedAt: nowDate,
              resultVerdict: SUBMISSION_VERDICTS.SYSTEM_ERROR,
              sanitizedSystemError: {
                code: JUDGE0_ERROR_CODES.POLL_TIMEOUT,
                message: 'Judge0 execution exceeded result polling timeout'
              }
            },
            $inc: { fencingVersion: 1 }
          },
          { returnDocument: 'after' }
        ).lean();

        if (timedOut) {
          await releaseCapacitySlot({ capacityKey: job.capacityKey, jobId: job._id });
          await reconcileSubmissionProgress({ submissionId: job.submissionId, nowFn, logger });
        }
        return { outcome: 'POLL_TIMEOUT' };
      }

      await ExecutionJob.findOneAndUpdate(
        {
          _id: job._id,
          status: EXECUTION_JOB_STATUSES.POLLING,
          leaseOwner: workerId,
          fencingVersion: job.fencingVersion
        },
        {
          $set: {
            lastPolledAt: nowDate,
            nextPollAt: new Date(nowMs + pollIntervalMs),
            leaseOwner: null,
            leaseExpiresAt: null
          },
          $inc: { fencingVersion: 1 }
        }
      );

      return { outcome: 'PENDING' };
    }

    if (mappedResult.isInfrastructureError) {
      const failed = await ExecutionJob.findOneAndUpdate(
        {
          _id: job._id,
          status: EXECUTION_JOB_STATUSES.POLLING,
          leaseOwner: workerId,
          fencingVersion: job.fencingVersion
        },
        {
          $set: {
            status: EXECUTION_JOB_STATUSES.SYSTEM_FAILED,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastPolledAt: nowDate,
            completedAt: nowDate,
            resultVerdict: SUBMISSION_VERDICTS.SYSTEM_ERROR,
            sanitizedSystemError: {
              code: mappedResult.status,
              message: mappedResult.systemMessage || 'Judge0 internal execution error'
            }
          },
          $inc: { fencingVersion: 1 }
        },
        { returnDocument: 'after' }
      ).lean();

      if (failed) {
        await releaseCapacitySlot({ capacityKey: job.capacityKey, jobId: job._id });
        await reconcileSubmissionProgress({ submissionId: job.submissionId, nowFn, logger });
      }
      return { outcome: 'SYSTEM_FAILED' };
    }

    // Evaluate participant verdict deterministically using Phase 05 compareOutputs
    const evaluated = evaluateTestCaseResult({
      mappedResult,
      testCase: {
        id: job.testCaseId,
        type: job.testCaseType,
        displayOrder: job.testCaseOrder,
        input: job.testCaseInput ?? '',
        expectedOutput: job.expectedOutput ?? ''
      }
    });

    const isSampleRunCase =
      job.mode === SUBMISSION_MODES.RUN && job.testCaseType === TEST_CASE_TYPES.SAMPLE;
    const isCompilationFailure = evaluated.verdict === EXECUTION_STATUSES.COMPILATION_ERROR;

    const completedJob = await ExecutionJob.findOneAndUpdate(
      {
        _id: job._id,
        status: EXECUTION_JOB_STATUSES.POLLING,
        leaseOwner: workerId,
        fencingVersion: job.fencingVersion
      },
      {
        $set: {
          status: EXECUTION_JOB_STATUSES.COMPLETED,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastPolledAt: nowDate,
          completedAt: nowDate,
          resultVerdict: evaluated.verdict,
          runtimeErrorSignal: evaluated.runtimeErrorSignal ?? null,
          executionTime: evaluated.timeSeconds ?? null,
          wallTime: evaluated.wallTimeSeconds ?? null,
          memoryUsage: evaluated.memoryKb ?? null,
          outputTruncated: Boolean(evaluated.outputTruncated),
          // NEVER store actual stdout/stderr for HIDDEN cases
          actualOutputSnapshot: isSampleRunCase ? evaluated.actualOutput : null,
          stderrSnapshot: isSampleRunCase ? evaluated.stderr : null,
          compileOutputSnapshot:
            isSampleRunCase || isCompilationFailure ? evaluated.compileOutput : ''
        },
        $inc: { fencingVersion: 1 }
      },
      { returnDocument: 'after' }
    ).lean();

    if (!completedJob) {
      logger?.warn?.(
        { jobId: job._id.toString(), workerId },
        'Stale worker write rejected during job completion'
      );
      return { outcome: 'STALE_FENCED' };
    }

    await releaseCapacitySlot({ capacityKey: job.capacityKey, jobId: job._id });

    // Early termination in SUBMIT mode: mark remaining unsent QUEUED jobs as SKIPPED
    if (job.mode === SUBMISSION_MODES.SUBMIT && !evaluated.passed) {
      await ExecutionJob.updateMany(
        {
          submissionId: job.submissionId,
          status: EXECUTION_JOB_STATUSES.QUEUED
        },
        {
          $set: {
            status: EXECUTION_JOB_STATUSES.SKIPPED,
            completedAt: nowDate
          }
        }
      );
    }

    await reconcileSubmissionProgress({
      submissionId: job.submissionId,
      nowFn,
      logger
    });

    return { outcome: evaluated.verdict };
  } catch (err) {
    const nowMs = nowFn();
    const nowDate = new Date(nowMs);
    const errCode = isJudge0Error(err) ? err.code : JUDGE0_ERROR_CODES.INTERNAL_ERROR;
    const errMessage = err?.message || 'Judge0 polling failed';
    const dispatchStartedMs = job.dispatchStartedAt
      ? new Date(job.dispatchStartedAt).getTime()
      : nowMs;

    if (
      isJudge0Error(err) &&
      RETRYABLE_POLL_ERROR_CODES.has(err.code) &&
      job.retryCount < retryMaxAttempts &&
      nowMs - dispatchStartedMs < pollTimeoutMs
    ) {
      const backoffMs = Math.min(3000, pollIntervalMs * (job.retryCount + 1));
      await ExecutionJob.findOneAndUpdate(
        {
          _id: job._id,
          status: EXECUTION_JOB_STATUSES.POLLING,
          leaseOwner: workerId,
          fencingVersion: job.fencingVersion
        },
        {
          $set: {
            lastPolledAt: nowDate,
            nextPollAt: new Date(nowMs + backoffMs),
            leaseOwner: null,
            leaseExpiresAt: null,
            sanitizedSystemError: { code: errCode, message: errMessage }
          },
          $inc: { retryCount: 1, fencingVersion: 1 }
        }
      );
      return { outcome: 'POLL_RETRY_SCHEDULED', errorCode: errCode };
    }

    const failed = await ExecutionJob.findOneAndUpdate(
      {
        _id: job._id,
        status: EXECUTION_JOB_STATUSES.POLLING,
        leaseOwner: workerId,
        fencingVersion: job.fencingVersion
      },
      {
        $set: {
          status: EXECUTION_JOB_STATUSES.SYSTEM_FAILED,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastPolledAt: nowDate,
          completedAt: nowDate,
          resultVerdict: SUBMISSION_VERDICTS.SYSTEM_ERROR,
          sanitizedSystemError: { code: errCode, message: errMessage }
        },
        $inc: { fencingVersion: 1 }
      },
      { returnDocument: 'after' }
    ).lean();

    if (failed) {
      await releaseCapacitySlot({ capacityKey: job.capacityKey, jobId: job._id });
      await reconcileSubmissionProgress({ submissionId: job.submissionId, nowFn, logger });
    }

    return { outcome: 'SYSTEM_FAILED', errorCode: errCode };
  }
}

/**
 * Sanitized internal queue monitoring metrics for future admin observability.
 * Never exposes source code, tokens, hidden test data, or Judge0 credentials.
 */
export async function getQueueMonitoringStats({
  competitionId,
  capacityKey = DEFAULT_EXECUTION_CAPACITY_KEY,
  maxInFlight = 8,
  maxQueuedSubmissions = 100,
  judge0Service,
  nowFn = () => Date.now()
} = {}) {
  const nowMs = nowFn();
  const compFilter = competitionId ? { competitionId } : {};

  await ensureExecutionCapacityDoc({ capacityKey, maxInFlight });

  const [
    queuedSubmissions,
    processingSubmissions,
    awaitingReconciliationSubmissions,
    pendingSettlementSubmissions,
    oldestPending,
    queuedExecutionJobs,
    uncertainExecutionJobs,
    recentSystemErrorsCount,
    capacityDoc,
    perTeamPendingRaw
  ] = await Promise.all([
    Submission.countDocuments({ ...compFilter, status: SUBMISSION_STATUSES.QUEUED }),
    Submission.countDocuments({ ...compFilter, status: SUBMISSION_STATUSES.PROCESSING }),
    Submission.countDocuments({
      ...compFilter,
      status: SUBMISSION_STATUSES.AWAITING_RECONCILIATION
    }),
    Submission.countDocuments({
      ...compFilter,
      settlementStatus: SUBMISSION_SETTLEMENT_STATUSES.PENDING_SETTLEMENT
    }),
    Submission.findOne({ ...compFilter, status: { $in: ACTIVE_SUBMISSION_STATUSES } })
      .sort({ admittedAt: 1 })
      .select('admittedAt')
      .lean(),
    ExecutionJob.countDocuments({
      ...compFilter,
      capacityKey,
      status: EXECUTION_JOB_STATUSES.QUEUED
    }),
    ExecutionJob.countDocuments({
      ...compFilter,
      capacityKey,
      status: EXECUTION_JOB_STATUSES.ADMISSION_UNCERTAIN
    }),
    Submission.countDocuments({
      ...compFilter,
      status: SUBMISSION_STATUSES.SYSTEM_FAILED,
      executionCompletedAt: { $gte: new Date(nowMs - 15 * 60 * 1000) }
    }),
    ExecutionCapacity.findById(capacityKey).lean(),
    Submission.find({ ...compFilter, status: { $in: ACTIVE_SUBMISSION_STATUSES } })
      .select('teamId status')
      .limit(100)
      .lean()
  ]);

  const outstandingJudge0Jobs = capacityDoc?.activeJobIds?.length ?? 0;
  const oldestPendingSubmissionAgeMs = oldestPending?.admittedAt
    ? Math.max(0, nowMs - new Date(oldestPending.admittedAt).getTime())
    : 0;

  const perTeamPendingCounts = {};
  for (const s of perTeamPendingRaw) {
    const key = s.teamId.toString();
    perTeamPendingCounts[key] = (perTeamPendingCounts[key] ?? 0) + 1;
  }

  const totalPendingSubmissions =
    queuedSubmissions + processingSubmissions + awaitingReconciliationSubmissions;

  let executionDependency = null;
  if (judge0Service?.checkAvailability) {
    executionDependency = await judge0Service.checkAvailability();
  }

  return {
    queuedSubmissions,
    processingSubmissions,
    awaitingReconciliationSubmissions,
    pendingSettlementSubmissions,
    outstandingJudge0Jobs,
    maxInFlight,
    queuedExecutionJobs,
    uncertainExecutionJobs,
    oldestPendingSubmissionAgeMs,
    queueSaturation: {
      activeSubmissions: totalPendingSubmissions,
      maxQueuedSubmissions,
      submissionQueueFull: totalPendingSubmissions >= maxQueuedSubmissions,
      judge0CapacityFull: outstandingJudge0Jobs >= maxInFlight
    },
    recentSystemErrorsCount,
    perTeamPendingCounts,
    executionDependency,
    serverTime: new Date(nowMs).toISOString()
  };
}

void CAPACITY_OCCUPYING_JOB_STATUSES;
