import { EXECUTION_STATUSES } from '../../integrations/judge0/judge0.mapper.js';
import { compareOutputs } from '../problems/outputComparison.js';
import { TEST_CASE_TYPES } from '../problems/testCase.model.js';

export const EVALUATION_MODES = Object.freeze({
  RUN: 'RUN',
  SUBMIT: 'SUBMIT',
  REFERENCE_VERIFICATION: 'REFERENCE_VERIFICATION'
});

/**
 * Evaluate a single normalized Judge0 execution result against a trusted TestCase.
 */
export function evaluateTestCaseResult({ mappedResult, testCase }) {
  if (!mappedResult || !testCase) {
    throw new Error('mappedResult and testCase are required for evaluation');
  }

  let verdict = mappedResult.status;
  let passed = false;
  let isInfrastructureError = Boolean(mappedResult.isInfrastructureError);
  let outputMatched = false;

  if (isInfrastructureError || !mappedResult.isTerminal) {
    verdict = EXECUTION_STATUSES.INFRASTRUCTURE_ERROR;
    isInfrastructureError = true;
    passed = false;
  } else if (mappedResult.status === EXECUTION_STATUSES.EXECUTED) {
    const comparison = compareOutputs(mappedResult.stdout, testCase.expectedOutput);
    outputMatched = comparison.matched;
    verdict = comparison.matched
      ? EXECUTION_STATUSES.ACCEPTED
      : EXECUTION_STATUSES.WRONG_ANSWER;
    passed = comparison.matched;
  }

  return {
    testCaseId: testCase.id ? String(testCase.id) : null,
    type: testCase.type,
    displayOrder: testCase.displayOrder,
    verdict,
    passed,
    outputMatched,
    isInfrastructureError,
    runtimeErrorSignal: mappedResult.runtimeErrorSignal ?? null,
    timeSeconds: mappedResult.timeSeconds ?? null,
    wallTimeSeconds: mappedResult.wallTimeSeconds ?? null,
    memoryKb: mappedResult.memoryKb ?? null,
    input: testCase.input,
    expectedOutput: testCase.expectedOutput,
    actualOutput: mappedResult.stdout ?? '',
    stderr: mappedResult.stderr ?? '',
    compileOutput: mappedResult.compileOutput ?? '',
    outputTruncated: Boolean(mappedResult.outputMetadata?.stdoutTruncated),
    nonUtf8Detected: Boolean(mappedResult.outputMetadata?.nonUtf8Detected),
    judge0Token: mappedResult.token ?? null,
    errorCode: null
  };
}

/**
 * Strip sensitive hidden test data, Judge0 tokens, and internal errors per mode.
 */
export function sanitizeCaseResultForMode(caseResult, mode) {
  if (mode === EVALUATION_MODES.RUN) {
    if (caseResult.type !== TEST_CASE_TYPES.SAMPLE) {
      throw new Error('SECURITY_VIOLATION: Hidden test case cannot be sanitized for RUN mode');
    }

    return {
      testCaseId: caseResult.testCaseId,
      type: caseResult.type,
      displayOrder: caseResult.displayOrder,
      verdict: caseResult.verdict,
      passed: caseResult.passed,
      isInfrastructureError: caseResult.isInfrastructureError,
      timeSeconds: caseResult.timeSeconds,
      memoryKb: caseResult.memoryKb,
      input: caseResult.input,
      expectedOutput: caseResult.expectedOutput,
      actualOutput: caseResult.actualOutput,
      stderr: caseResult.stderr,
      compileOutput: caseResult.compileOutput,
      outputTruncated: caseResult.outputTruncated
    };
  }

  if (mode === EVALUATION_MODES.SUBMIT) {
    return {
      displayOrder: caseResult.displayOrder,
      verdict: caseResult.verdict,
      passed: caseResult.passed,
      isInfrastructureError: caseResult.isInfrastructureError,
      timeSeconds: caseResult.timeSeconds,
      memoryKb: caseResult.memoryKb,
      ...(caseResult.verdict === EXECUTION_STATUSES.COMPILATION_ERROR &&
      caseResult.compileOutput
        ? { compileOutput: caseResult.compileOutput }
        : {})
    };
  }

  // REFERENCE_VERIFICATION (admin / internal CLI only)
  return {
    testCaseId: caseResult.testCaseId,
    type: caseResult.type,
    displayOrder: caseResult.displayOrder,
    verdict: caseResult.verdict,
    passed: caseResult.passed,
    isInfrastructureError: caseResult.isInfrastructureError,
    runtimeErrorSignal: caseResult.runtimeErrorSignal,
    timeSeconds: caseResult.timeSeconds,
    memoryKb: caseResult.memoryKb,
    input: caseResult.input,
    expectedOutput: caseResult.expectedOutput,
    actualOutput: caseResult.actualOutput,
    stderr: caseResult.stderr,
    compileOutput: caseResult.compileOutput,
    outputTruncated: caseResult.outputTruncated,
    errorCode: caseResult.errorCode ?? null
  };
}
