import { TEST_CASE_TYPES } from '../problems/testCase.model.js';
import {
  SUBMISSION_MODES,
  SUBMISSION_VERDICTS
} from './submission.constants.js';

function isoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Participant-safe serializer for Submission + optional RUN SAMPLE diagnostics.
 * Never exposes: hidden test inputs/outputs/actual stdout/stderr, Judge0 tokens,
 * worker leases, internal credentials, or another team's source code.
 */
export function serializeSubmissionForParticipant(submission, sampleJobs = []) {
  const mode = submission.mode;
  const verdict = submission.verdict ?? null;

  const base = {
    id: submission._id.toString(),
    teamId: submission.teamId.toString(),
    submittedByUserId: submission.submittedByUserId.toString(),
    challengeAttemptId: submission.challengeAttemptId.toString(),
    problemId: submission.problemId.toString(),
    problemVersion: submission.problemVersion,
    mode,
    language: submission.language,
    status: submission.status,
    verdict,
    totalCaseCount: submission.totalCaseCount,
    completedCaseCount: submission.completedCaseCount,
    passedCaseCount: submission.passedCaseCount,
    failedCaseCount: submission.failedCaseCount,
    skippedCaseCount: submission.skippedCaseCount,
    admittedAt: isoOrNull(submission.admittedAt),
    competitionEndsAt: isoOrNull(submission.competitionEndsAt),
    processingStartedAt: isoOrNull(submission.processingStartedAt),
    executionCompletedAt: isoOrNull(submission.executionCompletedAt),
    settlementStatus: submission.settlementStatus,
    settledAt: isoOrNull(submission.settledAt),
    maxTimeSeconds: submission.maxTimeSeconds ?? null,
    maxMemoryKb: submission.maxMemoryKb ?? null,
    ...(submission.systemErrorCode ? { systemErrorCode: submission.systemErrorCode } : {}),
    ...(submission.systemErrorMessage ? { systemErrorMessage: submission.systemErrorMessage } : {})
  };

  if (mode === SUBMISSION_MODES.RUN) {
    base.compileOutput = submission.compileOutput || '';
    base.sampleResults = (Array.isArray(sampleJobs) ? sampleJobs : [])
      .filter((job) => job.testCaseType === TEST_CASE_TYPES.SAMPLE)
      .sort((a, b) => a.testCaseOrder - b.testCaseOrder)
      .map((job) => ({
        displayOrder: job.testCaseOrder,
        status: job.status,
        verdict: job.resultVerdict ?? null,
        runtimeErrorSignal: job.runtimeErrorSignal ?? null,
        executionTimeSeconds: job.executionTime ?? null,
        memoryKb: job.memoryUsage ?? null,
        input: job.testCaseInput ?? '',
        expectedOutput: job.expectedOutput ?? '',
        actualOutput: job.actualOutputSnapshot ?? '',
        stderr: job.stderrSnapshot ?? '',
        compileOutput: job.compileOutputSnapshot ?? '',
        outputTruncated: Boolean(job.outputTruncated)
      }));
    return base;
  }

  // SUBMIT mode: aggregate statistics and compilation diagnostics ONLY; never hidden case data.
  if (verdict === SUBMISSION_VERDICTS.COMPILATION_ERROR && submission.compileOutput) {
    base.compileOutput = submission.compileOutput;
  }

  return base;
}

/**
 * Sanitized queue monitoring serializer for administrators (never exposes sourceCode or Judge0 tokens).
 */
export function serializeSubmissionForAdminQueue(submission) {
  return {
    id: submission._id.toString(),
    competitionId: submission.competitionId.toString(),
    teamId: submission.teamId.toString(),
    submittedByUserId: submission.submittedByUserId.toString(),
    challengeAttemptId: submission.challengeAttemptId.toString(),
    problemId: submission.problemId.toString(),
    problemVersion: submission.problemVersion,
    mode: submission.mode,
    language: submission.language,
    status: submission.status,
    verdict: submission.verdict ?? null,
    settlementStatus: submission.settlementStatus,
    totalCaseCount: submission.totalCaseCount,
    completedCaseCount: submission.completedCaseCount,
    passedCaseCount: submission.passedCaseCount,
    failedCaseCount: submission.failedCaseCount,
    skippedCaseCount: submission.skippedCaseCount,
    executionJobsCreated: submission.executionJobsCreated,
    executionJobsDispatched: submission.executionJobsDispatched,
    admittedAt: isoOrNull(submission.admittedAt),
    processingStartedAt: isoOrNull(submission.processingStartedAt),
    executionCompletedAt: isoOrNull(submission.executionCompletedAt),
    systemErrorCode: submission.systemErrorCode ?? null
  };
}
