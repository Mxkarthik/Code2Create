import crypto from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../utils/AppError.js';
import { EXECUTION_POLICY, LANGUAGE_KEYS } from '../problems/language.config.js';
import { SUBMISSION_MODES } from './submission.constants.js';

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_.:-]{4,128}$/;

export const admitSubmissionPayloadSchema = z
  .object({
    challengeAttemptId: z
      .string()
      .trim()
      .regex(OBJECT_ID_REGEX, 'challengeAttemptId must be a valid ObjectId'),
    problemId: z
      .string()
      .trim()
      .regex(OBJECT_ID_REGEX, 'problemId must be a valid ObjectId'),
    problemVersion: z.number().int().min(1).optional(),
    mode: z.enum([SUBMISSION_MODES.RUN, SUBMISSION_MODES.SUBMIT]),
    language: z.enum(LANGUAGE_KEYS),
    sourceCode: z.string(),
    idempotencyKey: z
      .string()
      .trim()
      .regex(
        IDEMPOTENCY_KEY_REGEX,
        'idempotencyKey must be 4-128 characters of alphanumeric, ., _, :, or -'
      )
  })
  .strict();

export function validateAdmitSubmissionInput(rawInput) {
  const parsed = admitSubmissionPayloadSchema.safeParse({
    ...rawInput,
    challengeAttemptId:
      rawInput?.challengeAttemptId !== undefined ? String(rawInput.challengeAttemptId) : '',
    problemId: rawInput?.problemId !== undefined ? String(rawInput.problemId) : ''
  });

  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message
    }));
    throw new AppError('Invalid submission admission payload', {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      details
    });
  }

  const data = parsed.data;
  if (data.sourceCode.trim().length === 0) {
    throw new AppError('Source code cannot be empty', {
      statusCode: 400,
      code: 'EMPTY_SOURCE_CODE'
    });
  }

  const sourceCodeBytes = Buffer.byteLength(data.sourceCode, 'utf8');
  if (sourceCodeBytes > EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES) {
    throw new AppError(
      `Source code exceeds maximum ${EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES} bytes limit`,
      {
        statusCode: 400,
        code: 'SOURCE_CODE_TOO_LARGE'
      }
    );
  }

  return {
    ...data,
    sourceCodeBytes
  };
}

export function computeSourceCodeHash(sourceCode) {
  return crypto.createHash('sha256').update(sourceCode, 'utf8').digest('hex');
}

export function computeRequestFingerprint({
  challengeAttemptId,
  problemId,
  problemVersion,
  mode,
  language,
  sourceCodeHash
}) {
  const canonical = JSON.stringify({
    challengeAttemptId: String(challengeAttemptId),
    language,
    mode,
    problemId: String(problemId),
    problemVersion: problemVersion ?? null,
    sourceCodeHash
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}
