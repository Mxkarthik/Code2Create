import { JUDGE0_ERROR_CODES, isJudge0Error } from '../../integrations/judge0/judge0.errors.js';
import { EXECUTION_STATUSES } from '../../integrations/judge0/judge0.mapper.js';
import { createInFlightLimiter } from '../../integrations/judge0/judge0.service.js';
import { AppError } from '../../utils/AppError.js';
import { EXECUTION_POLICY, getLanguageConfig } from '../problems/language.config.js';
import { getInternalExecutionProblem } from '../problems/problem.service.js';
import {
  EVALUATION_MODES,
  evaluateTestCaseResult,
  sanitizeCaseResultForMode
} from './testCaseEvaluator.js';

function assertAllowedLanguageAndSource({ language, allowedLanguages, sourceCode, executionLimits }) {
  const langCfg = getLanguageConfig(language);

  if (Array.isArray(allowedLanguages) && !allowedLanguages.includes(langCfg.key)) {
    throw new AppError(`Language ${langCfg.key} is not allowed for this problem`, {
      statusCode: 400,
      code: 'LANGUAGE_NOT_ALLOWED'
    });
  }

  if (typeof sourceCode !== 'string' || sourceCode.trim().length === 0) {
    throw new AppError('Source code is required', {
      statusCode: 400,
      code: 'EMPTY_SOURCE_CODE'
    });
  }

  const maxSourceBytes =
    executionLimits?.maxSourceCodeBytes ?? EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES;
  const actualBytes = Buffer.byteLength(sourceCode, 'utf8');
  if (actualBytes > maxSourceBytes) {
    throw new AppError(
      `Source code exceeds ${maxSourceBytes} bytes limit (${actualBytes} bytes provided)`,
      {
        statusCode: 400,
        code: 'SOURCE_CODE_TOO_LARGE'
      }
    );
  }

  return langCfg;
}

/**
 * Evaluate one test case end-to-end against Judge0 for diagnostic or orchestrated flows.
 */
export async function evaluateSingleTestCase({
  judge0Service,
  language,
  sourceCode,
  testCase,
  executionLimits = null,
  pollIntervalMs,
  pollTimeoutMs
}) {
  let submissionToken = null;
  let executionJobsSubmitted = 0;

  try {
    const admission = await judge0Service.createSubmission({
      language,
      sourceCode,
      stdin: testCase.input ?? '',
      executionLimits
    });
    submissionToken = admission.token;
    executionJobsSubmitted = 1;

    const maxOutputBytes =
      executionLimits?.maxOutputBytes ?? EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES;

    const mappedResult = await judge0Service.waitForResult({
      token: submissionToken,
      pollIntervalMs,
      pollTimeoutMs,
      maxOutputBytes
    });

    const verdict = evaluateTestCaseResult({ mappedResult, testCase });
    return {
      caseResult: verdict,
      executionJobsSubmitted,
      admissionUncertain: false
    };
  } catch (err) {
    if (isJudge0Error(err)) {
      const submittedCount = err.admissionUncertain || submissionToken ? 1 : 0;
      return {
        caseResult: {
          testCaseId: testCase.id ? String(testCase.id) : null,
          type: testCase.type,
          displayOrder: testCase.displayOrder,
          verdict: EXECUTION_STATUSES.INFRASTRUCTURE_ERROR,
          passed: false,
          outputMatched: false,
          isInfrastructureError: true,
          runtimeErrorSignal: null,
          timeSeconds: null,
          wallTimeSeconds: null,
          memoryKb: null,
          input: testCase.input,
          expectedOutput: testCase.expectedOutput,
          actualOutput: '',
          stderr: '',
          compileOutput: '',
          outputTruncated: false,
          nonUtf8Detected: false,
          judge0Token: err.judge0Token ?? submissionToken,
          errorCode: err.code
        },
        executionJobsSubmitted: submittedCount,
        admissionUncertain: Boolean(err.admissionUncertain)
      };
    }
    throw err;
  }
}

function summarizeOverallVerdict(caseResults, totalCases) {
  if (caseResults.length === 0) {
    return {
      overallVerdict: EXECUTION_STATUSES.INFRASTRUCTURE_ERROR,
      isInfrastructureError: true
    };
  }

  const infraFailure = caseResults.find((item) => item.isInfrastructureError);
  if (infraFailure) {
    return {
      overallVerdict: EXECUTION_STATUSES.INFRASTRUCTURE_ERROR,
      isInfrastructureError: true
    };
  }

  const compilationFailure = caseResults.find(
    (item) => item.verdict === EXECUTION_STATUSES.COMPILATION_ERROR
  );
  if (compilationFailure) {
    return {
      overallVerdict: EXECUTION_STATUSES.COMPILATION_ERROR,
      isInfrastructureError: false
    };
  }

  const firstFailure = caseResults.find((item) => !item.passed);
  if (firstFailure) {
    return {
      overallVerdict: firstFailure.verdict,
      isInfrastructureError: false
    };
  }

  if (caseResults.length === totalCases) {
    return {
      overallVerdict: EXECUTION_STATUSES.ACCEPTED,
      isInfrastructureError: false
    };
  }

  return {
    overallVerdict: EXECUTION_STATUSES.INFRASTRUCTURE_ERROR,
    isInfrastructureError: true
  };
}

/**
 * Multi-test-case evaluation foundation for RUN, SUBMIT, and REFERENCE_VERIFICATION modes.
 * Uses bounded concurrency (respecting JUDGE0_MAX_IN_FLIGHT) and never awards scores or mutates state.
 * In Phase 07, persistent queues will invoke createSubmission/getSubmissionResult step-by-step.
 */
export async function evaluateProblemSubmission({
  competitionId,
  problemId,
  expectedProblemVersion,
  language,
  sourceCode,
  mode,
  judge0Service,
  includeUnpublished = false,
  stopOnFailure = true,
  maxConcurrentJobs,
  pollIntervalMs,
  pollTimeoutMs
}) {
  if (!Object.values(EVALUATION_MODES).includes(mode)) {
    throw new AppError(`Unsupported evaluation mode: ${mode}`, {
      statusCode: 400,
      code: 'INVALID_EVALUATION_MODE'
    });
  }

  const executionProblem = await getInternalExecutionProblem({
    competitionId,
    problemId,
    expectedVersion: expectedProblemVersion,
    includeUnpublished: includeUnpublished && mode === EVALUATION_MODES.REFERENCE_VERIFICATION
  });

  const langCfg = assertAllowedLanguageAndSource({
    language,
    allowedLanguages: executionProblem.allowedLanguages,
    sourceCode,
    executionLimits: executionProblem.executionLimits
  });

  let selectedCases;
  if (mode === EVALUATION_MODES.RUN) {
    selectedCases = executionProblem.sampleTestCases;
  } else if (mode === EVALUATION_MODES.SUBMIT) {
    selectedCases = executionProblem.hiddenTestCases;
  } else {
    selectedCases = [...executionProblem.sampleTestCases, ...executionProblem.hiddenTestCases];
  }

  if (selectedCases.length === 0) {
    throw new AppError(`Problem has no ${mode} test cases available`, {
      statusCode: 409,
      code: 'PROBLEM_TEST_CASES_MISSING'
    });
  }

  const serviceConfig = judge0Service.getConfig?.() ?? { maxInFlight: 8 };
  const concurrencyCap = Math.min(
    Math.max(1, Number(maxConcurrentJobs ?? serviceConfig.maxInFlight) || 1),
    selectedCases.length
  );
  const limiter = createInFlightLimiter(concurrencyCap);

  let executionJobsSubmitted = 0;
  let hasAdmissionUncertainty = false;
  let abortedEarly = false;
  const collected = new Array(selectedCases.length);

  const runCaseAtIndex = async (idx) => {
    const outcome = await evaluateSingleTestCase({
      judge0Service,
      language: langCfg.key,
      sourceCode,
      testCase: selectedCases[idx],
      executionLimits: executionProblem.executionLimits,
      pollIntervalMs,
      pollTimeoutMs
    });
    executionJobsSubmitted += outcome.executionJobsSubmitted;
    if (outcome.admissionUncertain) {
      hasAdmissionUncertainty = true;
    }
    collected[idx] = outcome.caseResult;
    return outcome.caseResult;
  };

  // Run case 0 first when stopping early so COMPILATION_ERROR / instant failure avoids extra Judge0 jobs.
  const startIndex = stopOnFailure ? 1 : 0;
  if (stopOnFailure) {
    const firstResult = await limiter.run(() => runCaseAtIndex(0));
    if (!firstResult.passed || firstResult.isInfrastructureError) {
      abortedEarly = true;
    }
  }

  if (!abortedEarly && startIndex < selectedCases.length) {
    const remainingTasks = [];
    for (let i = startIndex; i < selectedCases.length; i += 1) {
      remainingTasks.push(
        limiter.run(async () => {
          if (stopOnFailure && abortedEarly) {
            return;
          }
          const result = await runCaseAtIndex(i);
          if (stopOnFailure && (!result.passed || result.isInfrastructureError)) {
            abortedEarly = true;
          }
        })
      );
    }
    await Promise.all(remainingTasks);
  }

  const evaluatedResults = collected.filter(Boolean);
  const { overallVerdict, isInfrastructureError } = summarizeOverallVerdict(
    evaluatedResults,
    selectedCases.length
  );

  const passedCases = evaluatedResults.filter((c) => c.passed).length;
  const failedCases = evaluatedResults.filter((c) => !c.passed).length;
  const errorCodes = Array.from(
    new Set(evaluatedResults.map((c) => c.errorCode).filter(Boolean))
  );
  const compileFailure = evaluatedResults.find(
    (c) => c.verdict === EXECUTION_STATUSES.COMPILATION_ERROR
  );

  const maxTimeSeconds = evaluatedResults.reduce(
    (acc, c) => (c.timeSeconds !== null && (acc === null || c.timeSeconds > acc) ? c.timeSeconds : acc),
    null
  );
  const maxMemoryKb = evaluatedResults.reduce(
    (acc, c) => (c.memoryKb !== null && (acc === null || c.memoryKb > acc) ? c.memoryKb : acc),
    null
  );

  const sanitizedCases = evaluatedResults.map((c) => sanitizeCaseResultForMode(c, mode));

  return {
    mode,
    problemId: executionProblem.problem.id,
    problemVersion: executionProblem.problem.version,
    language: langCfg.key,
    judge0LanguageId: langCfg.judge0LanguageId,
    overallVerdict,
    passed: overallVerdict === EXECUTION_STATUSES.ACCEPTED && !isInfrastructureError,
    isInfrastructureError,
    hasAdmissionUncertainty,
    errorCodes,
    totalCases: selectedCases.length,
    evaluatedCases: evaluatedResults.length,
    passedCases,
    failedCases,
    executionJobsSubmitted,
    maxConcurrentJobs: concurrencyCap,
    maxTimeSeconds,
    maxMemoryKb,
    ...(compileFailure?.compileOutput ? { compileOutput: compileFailure.compileOutput } : {}),
    caseResults: sanitizedCases,
    // Keep structured infrastructure guidance for callers; never expose Judge0 auth secrets.
    ...(errorCodes.includes(JUDGE0_ERROR_CODES.SUBMISSION_ADMISSION_UNCERTAIN)
      ? { reconciliationRequired: true }
      : {})
  };
}
