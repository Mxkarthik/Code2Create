import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../utils/AppError.js';

export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

const createTeamSchema = z.object({
  name: z
    .string({ required_error: 'Team name is required' })
    .trim()
    .min(3, 'Team name must be between 3 and 40 characters')
    .max(40, 'Team name must be between 3 and 40 characters')
});

const joinTeamSchema = z.object({
  joinCode: z
    .string({ required_error: 'Invitation code is required' })
    .trim()
    .transform((val) => val.toUpperCase())
    .refine(
      (val) => JOIN_CODE_PATTERN.test(val),
      'Invitation code must be 8 valid alphanumeric characters'
    )
});

const setReadySchema = z.object({
  isReady: z.boolean({
    required_error: 'isReady boolean is required',
    invalid_type_error: 'isReady must be a boolean'
  })
});

const transferLeadershipSchema = z.object({
  targetUserId: z
    .string({ required_error: 'targetUserId is required' })
    .trim()
    .refine((val) => mongoose.Types.ObjectId.isValid(val), 'Invalid targetUserId')
});

function throwValidationError(zodError, code = 'VALIDATION_ERROR') {
  const message = zodError.issues.map((issue) => issue.message).join('; ');
  throw AppError.badRequest(message || 'Invalid request payload', code);
}

export function validateCreateTeamBody(body) {
  const parsed = createTeamSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidationError(parsed.error, 'VALIDATION_ERROR');
  }
  return parsed.data;
}

export function validateJoinTeamBody(body) {
  const parsed = joinTeamSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidationError(parsed.error, 'TEAM_CODE_INVALID');
  }
  return parsed.data;
}

export function validateSetReadyBody(body) {
  const parsed = setReadySchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidationError(parsed.error, 'VALIDATION_ERROR');
  }
  return parsed.data;
}

export function validateTransferLeadershipBody(body) {
  const parsed = transferLeadershipSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidationError(parsed.error, 'VALIDATION_ERROR');
  }
  return parsed.data;
}

export function validateMemberIdParam(userId) {
  if (typeof userId !== 'string' || !mongoose.Types.ObjectId.isValid(userId.trim())) {
    throw AppError.badRequest('Invalid member userId parameter', 'VALIDATION_ERROR');
  }
  return userId.trim();
}
