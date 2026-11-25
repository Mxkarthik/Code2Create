import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../utils/AppError.js';

function throwValidation(zodError, code = 'VALIDATION_ERROR') {
  const message = zodError.issues.map((i) => i.message).join('; ');
  throw AppError.badRequest(message || 'Invalid request payload', code);
}

const importRanksSchema = z.object({
  rankedTeamCount: z
    .number({
      required_error: 'rankedTeamCount is required',
      invalid_type_error: 'rankedTeamCount must be an integer'
    })
    .int('rankedTeamCount must be an integer')
    .min(1, 'rankedTeamCount must be at least 1')
    .max(500, 'rankedTeamCount cannot exceed 500'),
  entries: z.array(
    z.object({
      teamId: z
        .string({ required_error: 'teamId is required' })
        .trim()
        .refine((v) => mongoose.Types.ObjectId.isValid(v), 'Invalid teamId'),
      rank: z
        .number({
          required_error: 'rank is required',
          invalid_type_error: 'rank must be an integer'
        })
        .int('rank must be an integer')
        .min(1, 'rank must be at least 1')
    }),
    { required_error: 'entries array is required' }
  )
});

export function validateImportRanksBody(body) {
  const parsed = importRanksSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidation(parsed.error, 'ROUND1_RANK_INVALID');
  }

  const { rankedTeamCount, entries } = parsed.data;
  if (entries.length > rankedTeamCount) {
    throw AppError.badRequest(
      'entries count cannot exceed rankedTeamCount',
      'ROUND1_RANK_INVALID'
    );
  }

  const seenTeamIds = new Set();
  const seenRanks = new Set();

  for (const entry of entries) {
    if (entry.rank > rankedTeamCount) {
      throw AppError.badRequest(
        `rank ${entry.rank} exceeds rankedTeamCount (${rankedTeamCount})`,
        'ROUND1_RANK_INVALID'
      );
    }
    if (seenTeamIds.has(entry.teamId)) {
      throw AppError.badRequest(
        `Duplicate teamId in rank import: ${entry.teamId}`,
        'ROUND1_RANK_DUPLICATE'
      );
    }
    if (seenRanks.has(entry.rank)) {
      throw AppError.badRequest(
        `Duplicate rank in rank import: ${entry.rank}`,
        'ROUND1_RANK_DUPLICATE'
      );
    }
    seenTeamIds.add(entry.teamId);
    seenRanks.add(entry.rank);
  }

  return { rankedTeamCount, entries };
}

const confirmRanksSchema = z.object({
  rankImportVersion: z
    .number({ invalid_type_error: 'rankImportVersion must be an integer' })
    .int('rankImportVersion must be an integer')
    .min(1, 'rankImportVersion must be at least 1')
    .optional(),
  expectedRankImportVersion: z
    .number({ invalid_type_error: 'expectedRankImportVersion must be an integer' })
    .int('expectedRankImportVersion must be an integer')
    .min(1, 'expectedRankImportVersion must be at least 1')
    .optional()
});

export function validateConfirmRanksBody(body) {
  const parsed = confirmRanksSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidation(parsed.error, 'VALIDATION_ERROR');
  }

  const version = parsed.data.rankImportVersion ?? parsed.data.expectedRankImportVersion;
  if (version === undefined) {
    throw AppError.badRequest('rankImportVersion is required', 'VALIDATION_ERROR');
  }

  return { rankImportVersion: version };
}

const excludeTeamSchema = z.object({
  reason: z
    .string({ required_error: 'Exclusion reason is required' })
    .trim()
    .min(3, 'Exclusion reason must be between 3 and 300 characters')
    .max(300, 'Exclusion reason must be between 3 and 300 characters')
});

export function validateExcludeTeamBody(body) {
  const parsed = excludeTeamSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidation(parsed.error, 'VALIDATION_ERROR');
  }
  return parsed.data;
}

const lockRosterSchema = z.object({
  expectedRosterVersion: z
    .number({
      required_error: 'expectedRosterVersion is required',
      invalid_type_error: 'expectedRosterVersion must be an integer'
    })
    .int('expectedRosterVersion must be an integer')
    .min(0, 'expectedRosterVersion must be >= 0'),
  expectedRankImportVersion: z
    .number({
      required_error: 'expectedRankImportVersion is required',
      invalid_type_error: 'expectedRankImportVersion must be an integer'
    })
    .int('expectedRankImportVersion must be an integer')
    .min(0, 'expectedRankImportVersion must be >= 0')
});

export function validateLockRosterBody(body) {
  const parsed = lockRosterSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidation(parsed.error, 'VALIDATION_ERROR');
  }
  return parsed.data;
}

const competitionConfigSchema = z
  .object({
    durationSeconds: z
      .number({ invalid_type_error: 'durationSeconds must be an integer' })
      .int('durationSeconds must be an integer')
      .min(10, 'durationSeconds must be at least 10 seconds')
      .max(14400, 'durationSeconds cannot exceed 14400 seconds')
      .optional(),
    maxHeadStart: z
      .number({ invalid_type_error: 'maxHeadStart must be an integer' })
      .int('maxHeadStart must be an integer')
      .min(0, 'maxHeadStart must be >= 0')
      .max(100, 'maxHeadStart cannot exceed 100')
      .optional(),
    qualificationLimit: z
      .number({ invalid_type_error: 'qualificationLimit must be an integer' })
      .int('qualificationLimit must be an integer')
      .min(1, 'qualificationLimit must be >= 1')
      .max(100, 'qualificationLimit cannot exceed 100')
      .optional()
  })
  .strict();

export function validateCompetitionConfigBody(body) {
  const parsed = competitionConfigSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidation(parsed.error, 'VALIDATION_ERROR');
  }

  if (Object.keys(parsed.data).length === 0) {
    throw AppError.badRequest(
      'At least one configuration field (durationSeconds, maxHeadStart, qualificationLimit) is required',
      'VALIDATION_ERROR'
    );
  }

  return parsed.data;
}

export function validateTeamIdParam(teamId) {
  if (typeof teamId !== 'string' || !mongoose.Types.ObjectId.isValid(teamId.trim())) {
    throw AppError.badRequest('Invalid teamId parameter', 'VALIDATION_ERROR');
  }
  return teamId.trim();
}
