import { EXECUTION_STATUSES } from '../../integrations/judge0/judge0.mapper.js';
import { AppError } from '../../utils/AppError.js';
import { getInternalExecutionProblem } from '../problems/problem.service.js';
import { Problem } from '../problems/problem.model.js';
import { TEST_CASE_TYPES } from '../problems/testCase.model.js';
import { evaluateProblemSubmission } from './execution.service.js';
import { EVALUATION_MODES } from './testCaseEvaluator.js';

/**
 * Verify a known-correct reference solution against every SAMPLE and HIDDEN test case
 * for a given problem version. Never holds a MongoDB transaction open during Judge0 execution,
 * and persists verification metadata only after every case passes cleanly on the exact version.
 */
export async function verifyReferenceSolution({
  competitionId,
  problemId,
  expectedProblemVersion,
  language,
  referenceSourceCode,
  judge0Service,
  includeUnpublished = true,
  stopOnFailure = false,
  persistResult = false,
  maxConcurrentJobs,
  pollIntervalMs,
  pollTimeoutMs,
  nowFn = () => Date.now(),
  logger
}) {
  if (!Number.isInteger(expectedProblemVersion) || expectedProblemVersion < 1) {
    throw new AppError('expectedProblemVersion must be a positive integer', {
      statusCode: 400,
      code: 'INVALID_PROBLEM_VERSION'
    });
  }

  const startedAtMs = nowFn();

  // Read trusted problem and verify version match before running Judge0 jobs.
  const problemSnapshot = await getInternalExecutionProblem({
    competitionId,
    problemId,
    expectedVersion: expectedProblemVersion,
    includeUnpublished
  });

  const evaluation = await evaluateProblemSubmission({
    competitionId,
    problemId,
    expectedProblemVersion,
    language,
    sourceCode: referenceSourceCode,
    mode: EVALUATION_MODES.REFERENCE_VERIFICATION,
    judge0Service,
    includeUnpublished,
    stopOnFailure,
    maxConcurrentJobs,
    pollIntervalMs,
    pollTimeoutMs
  });

  const sampleResults = evaluation.caseResults.filter(
    (c) => c.type === TEST_CASE_TYPES.SAMPLE
  );
  const hiddenResults = evaluation.caseResults.filter(
    (c) => c.type === TEST_CASE_TYPES.HIDDEN
  );

  const compilationError =
    evaluation.overallVerdict === EXECUTION_STATUSES.COMPILATION_ERROR
      ? {
          message: evaluation.compileOutput || 'Reference solution failed to compile'
        }
      : null;

  const mismatches = evaluation.caseResults
    .filter((c) => !c.passed && !c.isInfrastructureError && c.verdict !== EXECUTION_STATUSES.COMPILATION_ERROR)
    .map((c) => ({
      testCaseId: c.testCaseId,
      type: c.type,
      displayOrder: c.displayOrder,
      verdict: c.verdict,
      runtimeErrorSignal: c.runtimeErrorSignal,
      expectedOutput: c.expectedOutput,
      actualOutput: c.actualOutput
    }));

  const allCasesPassed =
    evaluation.passed &&
    !evaluation.isInfrastructureError &&
    evaluation.evaluatedCases === evaluation.totalCases;

  let persisted = false;
  let persistenceStatus = persistResult ? 'NOT_VERIFIED' : 'NOT_REQUESTED';

  if (persistResult && allCasesPassed) {
    const verifiedAt = new Date(nowFn());
    const updatedProblem = await Problem.findOneAndUpdate(
      {
        _id: problemId,
        competitionId,
        version: expectedProblemVersion
      },
      {
        $set: {
          verification: {
            status: 'VERIFIED',
            verifiedVersion: expectedProblemVersion,
            verifiedLanguage: evaluation.language,
            verifiedAt,
            verifiedCaseCount: evaluation.totalCases
          }
        }
      },
      { returnDocument: 'after' }
    ).lean();

    if (!updatedProblem) {
      persistenceStatus = 'STALE_VERSION_CONFLICT';
      throw new AppError(
        `Problem ${problemId} changed while reference verification was running (expected version ${expectedProblemVersion})`,
        {
          statusCode: 409,
          code: 'PROBLEM_VERSION_CONFLICT'
        }
      );
    }

    persisted = true;
    persistenceStatus = 'VERIFIED_RECORDED';
  } else if (persistResult) {
    persistenceStatus = evaluation.isInfrastructureError
      ? 'SKIPPED_INFRASTRUCTURE_ERROR'
      : 'SKIPPED_VERIFICATION_FAILED';
  }

  const durationMs = nowFn() - startedAtMs;

  if (allCasesPassed) {
    logger?.info?.(
      {
        problemId: problemSnapshot.problem.id,
        problemVersion: expectedProblemVersion,
        language: evaluation.language,
        totalCases: evaluation.totalCases,
        persisted
      },
      'Reference solution verification passed'
    );
  } else {
    logger?.warn?.(
      {
        problemId: problemSnapshot.problem.id,
        problemVersion: expectedProblemVersion,
        language: evaluation.language,
        overallVerdict: evaluation.overallVerdict,
        isInfrastructureError: evaluation.isInfrastructureError,
        passedCases: evaluation.passedCases,
        totalCases: evaluation.totalCases
      },
      'Reference solution verification did not pass'
    );
  }

  return {
    verified: allCasesPassed,
    persisted,
    persistenceStatus,
    problemId: problemSnapshot.problem.id,
    problemTitle: problemSnapshot.problem.title,
    problemVersion: expectedProblemVersion,
    language: evaluation.language,
    judge0LanguageId: evaluation.judge0LanguageId,
    overallVerdict: evaluation.overallVerdict,
    isInfrastructureError: evaluation.isInfrastructureError,
    errorCodes: evaluation.errorCodes,
    totalCases: evaluation.totalCases,
    evaluatedCases: evaluation.evaluatedCases,
    passedCases: evaluation.passedCases,
    failedCases: evaluation.failedCases,
    sampleSummary: {
      total: sampleResults.length,
      passed: sampleResults.filter((c) => c.passed).length,
      failed: sampleResults.filter((c) => !c.passed).length
    },
    hiddenSummary: {
      total: hiddenResults.length,
      passed: hiddenResults.filter((c) => c.passed).length,
      failed: hiddenResults.filter((c) => !c.passed).length
    },
    compilationError,
    mismatches,
    executionJobsSubmitted: evaluation.executionJobsSubmitted,
    durationMs
  };
}
