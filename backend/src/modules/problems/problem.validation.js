import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../utils/AppError.js';
import {
  EXECUTION_LIMIT_BOUNDS,
  EXECUTION_POLICY,
  LANGUAGE_KEYS,
  PROBLEM_DIFFICULTIES
} from './language.config.js';
import { PROBLEM_STATUSES } from './problem.model.js';
import { TEST_CASE_TYPES } from './testCase.model.js';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNSAFE_HTML_PATTERNS = [
  /<script\b/i,
  /<\/script>/i,
  /<iframe\b/i,
  /<object\b/i,
  /<embed\b/i,
  /\bon[a-z]+\s*=/i,
  /javascript\s*:/i
];

function containsUnsafeHtml(value) {
  return typeof value === 'string' && UNSAFE_HTML_PATTERNS.some((re) => re.test(value));
}

function safeMarkdownString(label, { min = 1, max = 30000 } = {}) {
  return z
    .string({ required_error: `${label} is required` })
    .refine((v) => v.trim().length >= min, `${label} must be at least ${min} characters`)
    .refine((v) => v.length <= max, `${label} cannot exceed ${max} characters`)
    .refine(
      (v) => !containsUnsafeHtml(v),
      `${label} must not contain executable HTML or script tags`
    );
}

function throwValidation(zodError, code = 'VALIDATION_ERROR') {
  const message = zodError.issues.map((i) => i.message).join('; ');
  throw AppError.badRequest(message || 'Invalid request payload', code);
}

export function slugifyTitle(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const perLanguageLimitOverrideSchema = z
  .object({
    cpuTimeLimitSeconds: z
      .number()
      .int()
      .min(EXECUTION_LIMIT_BOUNDS.cpuTimeLimitSeconds.min)
      .max(EXECUTION_LIMIT_BOUNDS.cpuTimeLimitSeconds.max)
      .optional(),
    wallTimeLimitSeconds: z
      .number()
      .int()
      .min(EXECUTION_LIMIT_BOUNDS.wallTimeLimitSeconds.min)
      .max(EXECUTION_LIMIT_BOUNDS.wallTimeLimitSeconds.max)
      .optional(),
    memoryLimitKb: z
      .number()
      .int()
      .min(EXECUTION_LIMIT_BOUNDS.memoryLimitKb.min)
      .max(EXECUTION_LIMIT_BOUNDS.memoryLimitKb.max)
      .optional()
  })
  .strict();

const executionLimitOverridesSchema = z
  .object({
    perLanguage: z
      .object({
        C: perLanguageLimitOverrideSchema.optional(),
        CPP: perLanguageLimitOverrideSchema.optional(),
        PYTHON: perLanguageLimitOverrideSchema.optional(),
        JAVA: perLanguageLimitOverrideSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict();

const allowedLanguagesSchema = z
  .array(z.enum(LANGUAGE_KEYS, { errorMap: () => ({ message: 'Unsupported language key' }) }))
  .min(1, 'At least one allowed language is required')
  .transform((arr) => Array.from(new Set(arr)));

const createProblemSchema = z
  .object({
    title: safeMarkdownString('title', { min: 3, max: 120 }).transform((v) => v.trim()),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(80)
      .regex(SLUG_PATTERN, 'slug must be lowercase alphanumeric with hyphens')
      .optional(),
    difficulty: z.enum(Object.values(PROBLEM_DIFFICULTIES), {
      errorMap: () => ({ message: 'difficulty must be EASY, MEDIUM, or HARD' })
    }),
    statement: safeMarkdownString('statement', { min: 10, max: 30000 }),
    inputFormat: safeMarkdownString('inputFormat', { min: 1, max: 10000 }),
    outputFormat: safeMarkdownString('outputFormat', { min: 1, max: 10000 }),
    constraints: safeMarkdownString('constraints', { min: 1, max: 10000 }),
    allowedLanguages: allowedLanguagesSchema.optional(),
    executionLimits: executionLimitOverridesSchema.optional(),
    displayOrder: z.number().int().min(1).max(500).optional()
  })
  .strict();

const updateProblemSchema = z
  .object({
    expectedVersion: z
      .number({
        required_error: 'expectedVersion is required',
        invalid_type_error: 'expectedVersion must be an integer'
      })
      .int()
      .min(1),
    title: safeMarkdownString('title', { min: 3, max: 120 })
      .transform((v) => v.trim())
      .optional(),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(80)
      .regex(SLUG_PATTERN, 'slug must be lowercase alphanumeric with hyphens')
      .optional(),
    difficulty: z
      .enum(Object.values(PROBLEM_DIFFICULTIES), {
        errorMap: () => ({ message: 'difficulty must be EASY, MEDIUM, or HARD' })
      })
      .optional(),
    statement: safeMarkdownString('statement', { min: 10, max: 30000 }).optional(),
    inputFormat: safeMarkdownString('inputFormat', { min: 1, max: 10000 }).optional(),
    outputFormat: safeMarkdownString('outputFormat', { min: 1, max: 10000 }).optional(),
    constraints: safeMarkdownString('constraints', { min: 1, max: 10000 }).optional(),
    allowedLanguages: allowedLanguagesSchema.optional(),
    executionLimits: executionLimitOverridesSchema.optional(),
    displayOrder: z.number().int().min(1).max(500).optional()
  })
  .strict();

const versionBodySchema = z
  .object({
    expectedVersion: z.number().int().min(1).optional()
  })
  .strict();

const listAdminProblemsQuerySchema = z
  .object({
    difficulty: z.enum(Object.values(PROBLEM_DIFFICULTIES)).optional(),
    status: z.enum(Object.values(PROBLEM_STATUSES)).optional(),
    page: z.coerce.number().int().min(1).max(100).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  })
  .strict();

const createTestCaseSchema = z
  .object({
    type: z.enum(Object.values(TEST_CASE_TYPES)),
    input: z
      .string({ required_error: 'input is required' })
      .refine(
        (v) => Buffer.byteLength(v, 'utf8') <= EXECUTION_POLICY.MAX_TEST_CASE_INPUT_BYTES,
        `Test case input cannot exceed ${EXECUTION_POLICY.MAX_TEST_CASE_INPUT_BYTES} bytes`
      ),
    expectedOutput: z
      .string({ required_error: 'expectedOutput is required' })
      .refine(
        (v) => Buffer.byteLength(v, 'utf8') <= EXECUTION_POLICY.MAX_TEST_CASE_OUTPUT_BYTES,
        `Test case expectedOutput cannot exceed ${EXECUTION_POLICY.MAX_TEST_CASE_OUTPUT_BYTES} bytes`
      ),
    explanation: safeMarkdownString('explanation', { min: 1, max: 2000 })
      .nullable()
      .optional(),
    displayOrder: z.number().int().min(1).max(500),
    expectedProblemVersion: z.number().int().min(1).optional()
  })
  .strict();

const updateTestCaseSchema = z
  .object({
    input: z
      .string()
      .refine(
        (v) => Buffer.byteLength(v, 'utf8') <= EXECUTION_POLICY.MAX_TEST_CASE_INPUT_BYTES,
        `Test case input cannot exceed ${EXECUTION_POLICY.MAX_TEST_CASE_INPUT_BYTES} bytes`
      )
      .optional(),
    expectedOutput: z
      .string()
      .refine(
        (v) => Buffer.byteLength(v, 'utf8') <= EXECUTION_POLICY.MAX_TEST_CASE_OUTPUT_BYTES,
        `Test case expectedOutput cannot exceed ${EXECUTION_POLICY.MAX_TEST_CASE_OUTPUT_BYTES} bytes`
      )
      .optional(),
    explanation: safeMarkdownString('explanation', { min: 1, max: 2000 })
      .nullable()
      .optional(),
    displayOrder: z.number().int().min(1).max(500).optional(),
    expectedProblemVersion: z.number().int().min(1).optional()
  })
  .strict();

export function validateCreateProblemBody(body) {
  const parsed = createProblemSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidation(parsed.error, 'VALIDATION_ERROR');
  }

  const data = parsed.data;
  const derivedSlug = data.slug ?? slugifyTitle(data.title);
  if (!SLUG_PATTERN.test(derivedSlug) || derivedSlug.length < 3) {
    throw AppError.badRequest(
      'Unable to derive a valid slug (3-80 lowercase alphanumeric characters)',
      'VALIDATION_ERROR'
    );
  }

  return {
    ...data,
    slug: derivedSlug,
    allowedLanguages: data.allowedLanguages ?? [...LANGUAGE_KEYS]
  };
}

export function validateUpdateProblemBody(body) {
  const parsed = updateProblemSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidation(parsed.error, 'VALIDATION_ERROR');
  }

  const { expectedVersion, ...updates } = parsed.data;
  if (Object.keys(updates).length === 0) {
    throw AppError.badRequest(
      'At least one editable problem field is required',
      'VALIDATION_ERROR'
    );
  }

  return { expectedVersion, updates };
}

export function validateExpectedVersionBody(body) {
  const parsed = versionBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidation(parsed.error, 'VALIDATION_ERROR');
  }
  return parsed.data;
}

export function validateAdminProblemsQuery(query) {
  const parsed = listAdminProblemsQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    throwValidation(parsed.error, 'VALIDATION_ERROR');
  }
  return parsed.data;
}

export function validateCreateTestCaseBody(body) {
  const parsed = createTestCaseSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidation(parsed.error, 'VALIDATION_ERROR');
  }
  return parsed.data;
}

export function validateUpdateTestCaseBody(body) {
  const parsed = updateTestCaseSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throwValidation(parsed.error, 'VALIDATION_ERROR');
  }

  const { expectedProblemVersion, ...updates } = parsed.data;
  if (Object.keys(updates).length === 0) {
    throw AppError.badRequest(
      'At least one test case field is required to update',
      'VALIDATION_ERROR'
    );
  }

  return { expectedProblemVersion, updates };
}

export function validateObjectIdParam(value, label = 'id') {
  if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value.trim())) {
    throw AppError.badRequest(`Invalid ${label} parameter`, 'VALIDATION_ERROR');
  }
  return value.trim();
}
