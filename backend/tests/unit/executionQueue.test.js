import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  SUBMISSION_MODES,
  SUBMISSION_SETTLEMENT_STATUSES,
  SUBMISSION_STATUSES,
  SUBMISSION_VERDICTS
} from '../../src/modules/submissions/submission.constants.js';
import {
  serializeSubmissionForAdminQueue,
  serializeSubmissionForParticipant
} from '../../src/modules/submissions/submission.serializer.js';
import {
  computeRequestFingerprint,
  computeSourceCodeHash,
  validateAdmitSubmissionInput
} from '../../src/modules/submissions/submission.validation.js';
import { EXECUTION_POLICY } from '../../src/modules/problems/language.config.js';
import { TEST_CASE_TYPES } from '../../src/modules/problems/testCase.model.js';

describe('Persistent execution queue serialization & validation (unit)', () => {
  const baseSubmission = {
    _id: new mongoose.Types.ObjectId(),
    competitionId: new mongoose.Types.ObjectId(),
    teamId: new mongoose.Types.ObjectId(),
    submittedByUserId: new mongoose.Types.ObjectId(),
    challengeAttemptId: new mongoose.Types.ObjectId(),
    problemId: new mongoose.Types.ObjectId(),
    problemVersion: 2,
    mode: SUBMISSION_MODES.SUBMIT,
    language: 'PYTHON',
    sourceCode: 'print("secret participant code")',
    totalCaseCount: 4,
    completedCaseCount: 4,
    passedCaseCount: 3,
    failedCaseCount: 1,
    skippedCaseCount: 0,
    executionJobsCreated: 4,
    executionJobsDispatched: 4,
    admittedAt: new Date('2026-11-25T12:00:00Z'),
    competitionEndsAt: new Date('2026-11-25T12:30:00Z'),
    processingStartedAt: new Date('2026-11-25T12:00:01Z'),
    executionCompletedAt: new Date('2026-11-25T12:00:05Z'),
    settlementStatus: SUBMISSION_SETTLEMENT_STATUSES.PENDING_SETTLEMENT,
    compileOutput: 'compiler details only'
  };

  it('validates submission admission payloads and canonical idempotency fingerprints', () => {
    const valid = validateAdmitSubmissionInput({
      challengeAttemptId: baseSubmission.challengeAttemptId.toString(),
      problemId: baseSubmission.problemId.toString(),
      problemVersion: 2,
      mode: 'SUBMIT',
      language: 'PYTHON',
      sourceCode: 'print(42)',
      idempotencyKey: 'idem-key-0001'
    });

    expect(valid.sourceCodeBytes).toBe(9);

    const h1 = computeSourceCodeHash('print(42)');
    const h2 = computeSourceCodeHash('print(43)');
    expect(h1).not.toBe(h2);

    const fp1 = computeRequestFingerprint({
      challengeAttemptId: baseSubmission.challengeAttemptId,
      problemId: baseSubmission.problemId,
      problemVersion: 2,
      mode: 'SUBMIT',
      language: 'PYTHON',
      sourceCodeHash: h1
    });
    const fp2 = computeRequestFingerprint({
      challengeAttemptId: baseSubmission.challengeAttemptId,
      problemId: baseSubmission.problemId,
      problemVersion: 2,
      mode: 'SUBMIT',
      language: 'PYTHON',
      sourceCodeHash: h2
    });
    expect(fp1).not.toBe(fp2);

    // Rejects unknown execution override fields and oversized UTF-8 source
    expect(() =>
      validateAdmitSubmissionInput({
        challengeAttemptId: baseSubmission.challengeAttemptId.toString(),
        problemId: baseSubmission.problemId.toString(),
        mode: 'SUBMIT',
        language: 'C',
        sourceCode: 'int main(){}',
        idempotencyKey: 'idem-key-0002',
        cpuTimeLimitSeconds: 999
      })
    ).toThrow(/Invalid submission admission payload/);

    expect(() =>
      validateAdmitSubmissionInput({
        challengeAttemptId: baseSubmission.challengeAttemptId.toString(),
        problemId: baseSubmission.problemId.toString(),
        mode: 'RUN',
        language: 'PYTHON',
        sourceCode: 'A'.repeat(EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES + 1),
        idempotencyKey: 'idem-key-0003'
      })
    ).toThrow(/exceeds maximum/);
  });

  it('prevents source code, Judge0 token, and hidden test leakage across SUBMIT and admin serializers', () => {
    const hiddenJobs = [
      {
        testCaseType: TEST_CASE_TYPES.HIDDEN,
        testCaseOrder: 1,
        status: 'COMPLETED',
        resultVerdict: SUBMISSION_VERDICTS.WRONG_ANSWER,
        testCaseInput: 'secret-input',
        expectedOutput: 'secret-expected',
        actualOutputSnapshot: 'secret-actual',
        stderrSnapshot: 'secret-stderr',
        judge0Token: 'judge0-secret-token'
      }
    ];

    const submitView = serializeSubmissionForParticipant(
      {
        ...baseSubmission,
        status: SUBMISSION_STATUSES.EXECUTION_COMPLETED,
        verdict: SUBMISSION_VERDICTS.WRONG_ANSWER
      },
      hiddenJobs
    );

    const serializedJson = JSON.stringify(submitView);
    expect(submitView.sourceCode).toBeUndefined();
    expect(submitView.sampleResults).toBeUndefined();
    expect(submitView.compileOutput).toBeUndefined();
    expect(serializedJson).not.toContain('secret-input');
    expect(serializedJson).not.toContain('secret-expected');
    expect(serializedJson).not.toContain('secret-actual');
    expect(serializedJson).not.toContain('secret-stderr');
    expect(serializedJson).not.toContain('judge0-secret-token');
    expect(serializedJson).not.toContain('secret participant code');

    const compileErrView = serializeSubmissionForParticipant(
      {
        ...baseSubmission,
        status: SUBMISSION_STATUSES.EXECUTION_COMPLETED,
        verdict: SUBMISSION_VERDICTS.COMPILATION_ERROR
      },
      hiddenJobs
    );
    expect(compileErrView.compileOutput).toBe('compiler details only');

    const adminView = serializeSubmissionForAdminQueue({
      ...baseSubmission,
      status: SUBMISSION_STATUSES.QUEUED
    });
    expect(adminView.sourceCode).toBeUndefined();
    expect(adminView.executionJobsCreated).toBe(4);
    expect(JSON.stringify(adminView)).not.toContain('secret participant code');
  });

  it('includes bounded SAMPLE diagnostics for RUN mode while filtering out HIDDEN cases and tokens', () => {
    const mixedJobs = [
      {
        testCaseType: TEST_CASE_TYPES.SAMPLE,
        testCaseOrder: 1,
        status: 'COMPLETED',
        resultVerdict: SUBMISSION_VERDICTS.ACCEPTED,
        testCaseInput: '2 3\n',
        expectedOutput: '5\n',
        actualOutputSnapshot: '5\n',
        stderrSnapshot: '',
        compileOutputSnapshot: '',
        executionTime: 0.015,
        memoryUsage: 3000,
        judge0Token: 'sample-token-secret'
      },
      {
        testCaseType: TEST_CASE_TYPES.HIDDEN,
        testCaseOrder: 1,
        status: 'COMPLETED',
        resultVerdict: SUBMISSION_VERDICTS.WRONG_ANSWER,
        testCaseInput: '9 9\n',
        expectedOutput: '18\n',
        actualOutputSnapshot: '0\n',
        stderrSnapshot: 'hidden err',
        judge0Token: 'hidden-token-secret'
      }
    ];

    const runView = serializeSubmissionForParticipant(
      {
        ...baseSubmission,
        mode: SUBMISSION_MODES.RUN,
        status: SUBMISSION_STATUSES.EXECUTION_COMPLETED,
        verdict: SUBMISSION_VERDICTS.ACCEPTED
      },
      mixedJobs
    );

    expect(runView.sampleResults).toHaveLength(1);
    expect(runView.sampleResults[0].input).toBe('2 3\n');
    expect(runView.sampleResults[0].actualOutput).toBe('5\n');
    expect(JSON.stringify(runView)).not.toContain('sample-token-secret');
    expect(JSON.stringify(runView)).not.toContain('9 9');
    expect(JSON.stringify(runView)).not.toContain('hidden-token-secret');
  });
});
