import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JUDGE0_ERROR_CODES, Judge0Error } from '../../src/integrations/judge0/judge0.errors.js';
import { EXECUTION_STATUSES } from '../../src/integrations/judge0/judge0.mapper.js';
import { evaluateProblemSubmission } from '../../src/modules/execution/execution.service.js';
import { verifyReferenceSolution } from '../../src/modules/execution/referenceVerification.service.js';
import {
  EVALUATION_MODES,
  evaluateTestCaseResult,
  sanitizeCaseResultForMode
} from '../../src/modules/execution/testCaseEvaluator.js';
import { PROBLEM_STATUSES, Problem } from '../../src/modules/problems/problem.model.js';
import { buildProblemExecutionLimits } from '../../src/modules/problems/language.config.js';
import { TEST_CASE_TYPES, TestCase } from '../../src/modules/problems/testCase.model.js';

function createProblemFixture({ version = 2, status = PROBLEM_STATUSES.PUBLISHED } = {}) {
  const competitionId = new mongoose.Types.ObjectId();
  const problemId = new mongoose.Types.ObjectId();

  const problemDoc = {
    _id: problemId,
    competitionId,
    title: 'Sum Two Numbers',
    slug: 'sum-two-numbers',
    difficulty: 'EASY',
    allowedLanguages: ['C', 'CPP', 'PYTHON', 'JAVA'],
    executionLimits: buildProblemExecutionLimits(['C', 'CPP', 'PYTHON', 'JAVA']),
    status,
    version
  };

  const testCaseDocs = [
    {
      _id: new mongoose.Types.ObjectId(),
      competitionId,
      problemId,
      type: TEST_CASE_TYPES.SAMPLE,
      input: '1 2\n',
      expectedOutput: '3\n',
      explanation: '1 + 2 = 3',
      displayOrder: 1
    },
    {
      _id: new mongoose.Types.ObjectId(),
      competitionId,
      problemId,
      type: TEST_CASE_TYPES.HIDDEN,
      input: '10 20\n',
      expectedOutput: '30\n',
      explanation: null,
      displayOrder: 1
    },
    {
      _id: new mongoose.Types.ObjectId(),
      competitionId,
      problemId,
      type: TEST_CASE_TYPES.HIDDEN,
      input: '-5 5\n',
      expectedOutput: '0\n',
      explanation: null,
      displayOrder: 2
    }
  ];

  return { competitionId, problemId, problemDoc, testCaseDocs };
}

function mockProblemQueries(fixture) {
  vi.spyOn(Problem, 'findOne').mockImplementation(() => ({
    lean: vi.fn(async () => fixture.problemDoc)
  }));
  vi.spyOn(TestCase, 'find').mockImplementation(() => ({
    sort: () => ({
      lean: vi.fn(async () => fixture.testCaseDocs)
    })
  }));
}

describe('Execution evaluation & reference verification (unit)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('compares outputs strictly with normalization and rejects hidden exposure in RUN mode', () => {
    const sampleVerdict = evaluateTestCaseResult({
      mappedResult: {
        status: EXECUTION_STATUSES.EXECUTED,
        isTerminal: true,
        isInfrastructureError: false,
        stdout: '3   \r\n\r\n',
        stderr: '',
        compileOutput: '',
        timeSeconds: 0.01,
        memoryKb: 1024,
        token: 'secret-token-123'
      },
      testCase: {
        id: 'tc-1',
        type: TEST_CASE_TYPES.SAMPLE,
        displayOrder: 1,
        input: '1 2\n',
        expectedOutput: '3\n'
      }
    });

    expect(sampleVerdict.verdict).toBe(EXECUTION_STATUSES.ACCEPTED);
    expect(sampleVerdict.passed).toBe(true);

    const runSanitized = sanitizeCaseResultForMode(sampleVerdict, EVALUATION_MODES.RUN);
    expect(runSanitized.judge0Token).toBeUndefined();
    expect(runSanitized.expectedOutput).toBe('3\n');

    expect(() =>
      sanitizeCaseResultForMode(
        { ...sampleVerdict, type: TEST_CASE_TYPES.HIDDEN },
        EVALUATION_MODES.RUN
      )
    ).toThrow(/SECURITY_VIOLATION/);
  });

  it('evaluates RUN (samples only) and SUBMIT (all hidden pass, zero hidden leakage)', async () => {
    const fixture = createProblemFixture();
    mockProblemQueries(fixture);

    const submittedInputs = [];
    const judge0Service = {
      getConfig: () => ({ maxInFlight: 2 }),
      createSubmission: vi.fn(async ({ stdin }) => {
        submittedInputs.push(stdin);
        return { token: `tok-${submittedInputs.length}-abcdef` };
      }),
      waitForResult: vi.fn(async ({ token }) => {
        const idx = Number(token.split('-')[1]) - 1;
        const stdin = submittedInputs[idx];
        const [a, b] = stdin.trim().split(/\s+/).map(Number);
        return {
          token,
          status: EXECUTION_STATUSES.EXECUTED,
          isTerminal: true,
          isInfrastructureError: false,
          stdout: `${a + b}\n`,
          stderr: '',
          compileOutput: '',
          timeSeconds: 0.02,
          memoryKb: 3072,
          outputMetadata: {}
        };
      })
    };

    const runRes = await evaluateProblemSubmission({
      competitionId: fixture.competitionId,
      problemId: fixture.problemId,
      language: 'PYTHON',
      sourceCode: 'print(sum(map(int, input().split())))',
      mode: EVALUATION_MODES.RUN,
      judge0Service
    });

    expect(runRes.totalCases).toBe(1);
    expect(runRes.passedCases).toBe(1);
    expect(runRes.executionJobsSubmitted).toBe(1);
    expect(runRes.caseResults[0].type).toBe(TEST_CASE_TYPES.SAMPLE);

    submittedInputs.length = 0;

    const submitRes = await evaluateProblemSubmission({
      competitionId: fixture.competitionId,
      problemId: fixture.problemId,
      language: 'PYTHON',
      sourceCode: 'print(sum(map(int, input().split())))',
      mode: EVALUATION_MODES.SUBMIT,
      judge0Service
    });

    expect(submitRes.overallVerdict).toBe(EXECUTION_STATUSES.ACCEPTED);
    expect(submitRes.totalCases).toBe(2);
    expect(submitRes.passedCases).toBe(2);
    expect(submitRes.executionJobsSubmitted).toBe(2);
    for (const c of submitRes.caseResults) {
      expect(c.input).toBeUndefined();
      expect(c.expectedOutput).toBeUndefined();
      expect(c.actualOutput).toBeUndefined();
      expect(c.stderr).toBeUndefined();
    }
  });

  it('handles hidden failure, compilation early-stop, bounded concurrency, and infra failures cleanly', async () => {
    const fixture = createProblemFixture();
    mockProblemQueries(fixture);

    // 1. One hidden case fails -> WRONG_ANSWER with zero hidden output leak
    let jobNum = 0;
    const partialFailJudge0 = {
      getConfig: () => ({ maxInFlight: 1 }),
      createSubmission: vi.fn(async () => ({ token: `tok-${++jobNum}-123456` })),
      waitForResult: vi.fn(async ({ token }) => ({
        token,
        status: EXECUTION_STATUSES.EXECUTED,
        isTerminal: true,
        isInfrastructureError: false,
        stdout: token.startsWith('tok-1-') ? '30\n' : '999\n',
        stderr: 'secret-hidden-stderr',
        compileOutput: '',
        timeSeconds: 0.01,
        memoryKb: 1024,
        outputMetadata: {}
      }))
    };

    const wrongSubmit = await evaluateProblemSubmission({
      competitionId: fixture.competitionId,
      problemId: fixture.problemId,
      language: 'C',
      sourceCode: 'int main(){}',
      mode: EVALUATION_MODES.SUBMIT,
      judge0Service: partialFailJudge0
    });
    expect(wrongSubmit.overallVerdict).toBe(EXECUTION_STATUSES.WRONG_ANSWER);
    expect(wrongSubmit.passedCases).toBe(1);
    expect(wrongSubmit.failedCases).toBe(1);
    expect(JSON.stringify(wrongSubmit)).not.toContain('secret-hidden-stderr');
    expect(JSON.stringify(wrongSubmit)).not.toContain('999');

    // 2. Compilation failure aborts after case 0 (1 job total instead of 2)
    const compileFailJudge0 = {
      getConfig: () => ({ maxInFlight: 8 }),
      createSubmission: vi.fn(async () => ({ token: 'tok-compile-123456' })),
      waitForResult: vi.fn(async ({ token }) => ({
        token,
        status: EXECUTION_STATUSES.COMPILATION_ERROR,
        isTerminal: true,
        isInfrastructureError: false,
        stdout: '',
        stderr: '',
        compileOutput: 'error: expected ;',
        outputMetadata: {}
      }))
    };

    const ceRes = await evaluateProblemSubmission({
      competitionId: fixture.competitionId,
      problemId: fixture.problemId,
      language: 'CPP',
      sourceCode: 'int main(){ broken }',
      mode: EVALUATION_MODES.SUBMIT,
      judge0Service: compileFailJudge0
    });
    expect(ceRes.overallVerdict).toBe(EXECUTION_STATUSES.COMPILATION_ERROR);
    expect(ceRes.executionJobsSubmitted).toBe(1);
    expect(ceRes.compileOutput).toContain('expected ;');

    // 3. Infrastructure error (admission uncertainty) -> INFRASTRUCTURE_ERROR, never WRONG_ANSWER
    const infraFailJudge0 = {
      getConfig: () => ({ maxInFlight: 2 }),
      createSubmission: vi.fn(async () => {
        throw new Judge0Error('Admission uncertain on timeout', {
          code: JUDGE0_ERROR_CODES.SUBMISSION_ADMISSION_UNCERTAIN,
          admissionUncertain: true
        });
      })
    };

    const infraRes = await evaluateProblemSubmission({
      competitionId: fixture.competitionId,
      problemId: fixture.problemId,
      language: 'PYTHON',
      sourceCode: 'print(1)',
      mode: EVALUATION_MODES.SUBMIT,
      judge0Service: infraFailJudge0
    });
    expect(infraRes.overallVerdict).toBe(EXECUTION_STATUSES.INFRASTRUCTURE_ERROR);
    expect(infraRes.isInfrastructureError).toBe(true);
    expect(infraRes.hasAdmissionUncertainty).toBe(true);
    expect(infraRes.reconciliationRequired).toBe(true);

    // 4. Bounded concurrency respects JUDGE0_MAX_IN_FLIGHT = 2
    let inFlight = 0;
    let peakInFlight = 0;
    fixture.testCaseDocs.push({
      _id: new mongoose.Types.ObjectId(),
      competitionId: fixture.competitionId,
      problemId: fixture.problemId,
      type: TEST_CASE_TYPES.HIDDEN,
      input: '4 4\n',
      expectedOutput: '8\n',
      displayOrder: 3
    });

    const concurrencyJudge0 = {
      getConfig: () => ({ maxInFlight: 2 }),
      createSubmission: vi.fn(async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        return { token: `conc-${Math.random().toString(36).slice(2, 12)}` };
      }),
      waitForResult: vi.fn(async ({ token }) => {
        inFlight -= 1;
        return {
          token,
          status: EXECUTION_STATUSES.EXECUTED,
          isTerminal: true,
          isInfrastructureError: false,
          stdout: '0\n',
          outputMetadata: {}
        };
      })
    };

    await evaluateProblemSubmission({
      competitionId: fixture.competitionId,
      problemId: fixture.problemId,
      language: 'PYTHON',
      sourceCode: 'print(0)',
      mode: EVALUATION_MODES.REFERENCE_VERIFICATION,
      stopOnFailure: false,
      judge0Service: concurrencyJudge0
    });
    expect(peakInFlight).toBeLessThanOrEqual(2);
  });

  it('verifies reference solutions cleanly and guards against wrong output, invalid language, stale versions, and infra errors', async () => {
    const fixture = createProblemFixture({ version: 3, status: PROBLEM_STATUSES.DRAFT });
    mockProblemQueries(fixture);
    const findOneAndUpdateSpy = vi.spyOn(Problem, 'findOneAndUpdate').mockImplementation(() => ({
      lean: vi.fn(async () => ({ ...fixture.problemDoc, verification: { status: 'VERIFIED' } }))
    }));

    const inputsByToken = new Map();
    const okJudge0 = {
      getConfig: () => ({ maxInFlight: 2 }),
      createSubmission: vi.fn(async ({ stdin }) => {
        const token = `ref-${inputsByToken.size + 1}-abcdef`;
        inputsByToken.set(token, stdin);
        return { token };
      }),
      waitForResult: vi.fn(async ({ token }) => {
        const [a, b] = inputsByToken.get(token).trim().split(/\s+/).map(Number);
        return {
          token,
          status: EXECUTION_STATUSES.EXECUTED,
          isTerminal: true,
          isInfrastructureError: false,
          stdout: `${a + b}\n`,
          outputMetadata: {}
        };
      })
    };

    const okResult = await verifyReferenceSolution({
      competitionId: fixture.competitionId,
      problemId: fixture.problemId,
      expectedProblemVersion: 3,
      language: 'PYTHON',
      referenceSourceCode: 'print(sum(map(int, input().split())))',
      judge0Service: okJudge0,
      persistResult: true
    });
    expect(okResult.verified).toBe(true);
    expect(okResult.persisted).toBe(true);
    expect(okResult.totalCases).toBe(3);
    expect(findOneAndUpdateSpy).toHaveBeenCalledTimes(1);

    // Wrong expected output -> verified: false, never persisted
    findOneAndUpdateSpy.mockClear();
    const wrongJudge0 = {
      getConfig: () => ({ maxInFlight: 2 }),
      createSubmission: vi.fn(async () => ({ token: 'wrong-1-abcdef' })),
      waitForResult: vi.fn(async ({ token }) => ({
        token,
        status: EXECUTION_STATUSES.EXECUTED,
        isTerminal: true,
        isInfrastructureError: false,
        stdout: '9999\n',
        outputMetadata: {}
      }))
    };

    const failedResult = await verifyReferenceSolution({
      competitionId: fixture.competitionId,
      problemId: fixture.problemId,
      expectedProblemVersion: 3,
      language: 'PYTHON',
      referenceSourceCode: 'print(9999)',
      judge0Service: wrongJudge0,
      persistResult: true
    });
    expect(failedResult.verified).toBe(false);
    expect(failedResult.persisted).toBe(false);
    expect(failedResult.persistenceStatus).toBe('SKIPPED_VERIFICATION_FAILED');
    expect(failedResult.mismatches.length).toBeGreaterThan(0);
    expect(findOneAndUpdateSpy).not.toHaveBeenCalled();

    // Disallowed language rejected
    fixture.problemDoc.allowedLanguages = ['C'];
    await expect(
      verifyReferenceSolution({
        competitionId: fixture.competitionId,
        problemId: fixture.problemId,
        expectedProblemVersion: 3,
        language: 'JAVA',
        referenceSourceCode: 'class Main {}',
        judge0Service: okJudge0
      })
    ).rejects.toMatchObject({ code: 'LANGUAGE_NOT_ALLOWED' });
    fixture.problemDoc.allowedLanguages = ['C', 'CPP', 'PYTHON', 'JAVA'];

    // Infrastructure failure never marks problem verified
    const infraJudge0 = {
      getConfig: () => ({ maxInFlight: 2 }),
      createSubmission: vi.fn(async () => {
        throw new Judge0Error('Unreachable', { code: JUDGE0_ERROR_CODES.UNREACHABLE });
      })
    };
    const infraRes = await verifyReferenceSolution({
      competitionId: fixture.competitionId,
      problemId: fixture.problemId,
      expectedProblemVersion: 3,
      language: 'C',
      referenceSourceCode: 'int main(){}',
      judge0Service: infraJudge0,
      persistResult: true
    });
    expect(infraRes.verified).toBe(false);
    expect(infraRes.isInfrastructureError).toBe(true);
    expect(infraRes.persisted).toBe(false);
    expect(infraRes.persistenceStatus).toBe('SKIPPED_INFRASTRUCTURE_ERROR');
    expect(findOneAndUpdateSpy).not.toHaveBeenCalled();

    // Stale problem version cannot receive a successful verification marker (concurrent edit)
    vi.spyOn(Problem, 'findOneAndUpdate').mockImplementation(() => ({
      lean: vi.fn(async () => null)
    }));
    await expect(
      verifyReferenceSolution({
        competitionId: fixture.competitionId,
        problemId: fixture.problemId,
        expectedProblemVersion: 3,
        language: 'PYTHON',
        referenceSourceCode: 'print(sum(map(int, input().split())))',
        judge0Service: okJudge0,
        persistResult: true
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROBLEM_VERSION_CONFLICT'
    });
  });
});
