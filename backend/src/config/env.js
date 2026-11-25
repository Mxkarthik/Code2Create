import dotenv from 'dotenv';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ENV_PATH = path.resolve(__dirname, '../../.env');

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const LOG_FORMATS = ['minimal', 'debug', 'json'];
const NODE_ENVS = ['development', 'test', 'production'];

export const DEFAULT_SESSION_MAX_AGE_MS = 28800000; // 8 hours
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 7200000; // 2 hours
export const DEFAULT_OAUTH_STATE_TTL_MS = 600000; // 10 minutes
export const DEFAULT_JUDGE0_URL = 'http://127.0.0.1:2358';
export const DEFAULT_JUDGE0_MAX_IN_FLIGHT = 8;
export const DEFAULT_JUDGE0_REQUEST_TIMEOUT_MS = 10000;
export const DEFAULT_JUDGE0_POLL_INTERVAL_MS = 750;
export const DEFAULT_JUDGE0_POLL_TIMEOUT_MS = 60000;
export const DEFAULT_EXECUTION_WORKER_POLL_INTERVAL_MS = 250;
export const DEFAULT_EXECUTION_LEASE_DURATION_MS = 30000;
export const DEFAULT_EXECUTION_LEASE_RENEW_INTERVAL_MS = 10000;
export const DEFAULT_EXECUTION_MAX_QUEUED_SUBMISSIONS = 100;
export const DEFAULT_EXECUTION_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_EXECUTION_SHUTDOWN_TIMEOUT_MS = 8000;
export const DEFAULT_EXECUTION_UNCERTAIN_RECONCILE_MS = 90000;

const BLOCKED_PUBLIC_JUDGE0_HOSTS = new Set([
  'ce.judge0.com',
  'api.judge0.com',
  'judge0-ce.p.rapidapi.com'
]);

function isSafeJudge0Url(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    if (BLOCKED_PUBLIC_JUDGE0_HOSTS.has(parsed.hostname.toLowerCase())) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

function parseDnsServers(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(5000),
    MONGODB_URI: z
      .string({ required_error: 'MONGODB_URI is required' })
      .trim()
      .min(1, 'MONGODB_URI is required')
      .refine(
        (val) => val.startsWith('mongodb://') || val.startsWith('mongodb+srv://'),
        'MONGODB_URI must use mongodb:// or mongodb+srv:// scheme'
      ),
    MONGODB_TEST_URI: z.string().trim().optional(),
    MONGODB_DNS_SERVERS: z.string().trim().optional(),
    MONGODB_DNS_FALLBACK: z.enum(['true', 'false']).optional(),
    PARTICIPANT_FRONTEND_URL: z.string().trim().optional(),
    ADMIN_FRONTEND_URL: z.string().trim().optional(),
    LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
    LOG_FORMAT: z.enum(LOG_FORMATS).optional(),
    GOOGLE_CLIENT_ID: z
      .string({ required_error: 'GOOGLE_CLIENT_ID is required' })
      .trim()
      .min(1, 'GOOGLE_CLIENT_ID is required'),
    GOOGLE_CLIENT_SECRET: z
      .string({ required_error: 'GOOGLE_CLIENT_SECRET is required' })
      .trim()
      .min(1, 'GOOGLE_CLIENT_SECRET is required'),
    GOOGLE_CALLBACK_URL: z.string().trim().optional(),
    SESSION_SECRET: z
      .string({ required_error: 'SESSION_SECRET is required' })
      .trim()
      .min(32, 'SESSION_SECRET must be at least 32 characters'),
    SESSION_MAX_AGE_MS: z.coerce
      .number()
      .int()
      .positive('SESSION_MAX_AGE_MS must be a positive integer')
      .default(DEFAULT_SESSION_MAX_AGE_MS),
    SESSION_IDLE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive('SESSION_IDLE_TIMEOUT_MS must be a positive integer')
      .default(DEFAULT_SESSION_IDLE_TIMEOUT_MS),
    OAUTH_STATE_TTL_MS: z.coerce
      .number()
      .int()
      .positive('OAUTH_STATE_TTL_MS must be a positive integer')
      .default(DEFAULT_OAUTH_STATE_TTL_MS),
    JUDGE0_URL: z.string().trim().optional(),
    JUDGE0_AUTH_TOKEN: z.string().trim().optional(),
    JUDGE0_MAX_IN_FLIGHT: z.coerce
      .number()
      .int()
      .min(1, 'JUDGE0_MAX_IN_FLIGHT must be between 1 and 64')
      .max(64, 'JUDGE0_MAX_IN_FLIGHT must be between 1 and 64')
      .default(DEFAULT_JUDGE0_MAX_IN_FLIGHT),
    JUDGE0_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000, 'JUDGE0_REQUEST_TIMEOUT_MS must be between 1000 and 60000 ms')
      .max(60000, 'JUDGE0_REQUEST_TIMEOUT_MS must be between 1000 and 60000 ms')
      .default(DEFAULT_JUDGE0_REQUEST_TIMEOUT_MS),
    JUDGE0_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100, 'JUDGE0_POLL_INTERVAL_MS must be between 100 and 10000 ms')
      .max(10000, 'JUDGE0_POLL_INTERVAL_MS must be between 100 and 10000 ms')
      .default(DEFAULT_JUDGE0_POLL_INTERVAL_MS),
    JUDGE0_POLL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000, 'JUDGE0_POLL_TIMEOUT_MS must be between 1000 and 300000 ms')
      .max(300000, 'JUDGE0_POLL_TIMEOUT_MS must be between 1000 and 300000 ms')
      .default(DEFAULT_JUDGE0_POLL_TIMEOUT_MS),
    EXECUTION_WORKER_ENABLED: z.enum(['true', 'false']).optional(),
    EXECUTION_WORKER_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(50, 'EXECUTION_WORKER_POLL_INTERVAL_MS must be between 50 and 10000 ms')
      .max(10000, 'EXECUTION_WORKER_POLL_INTERVAL_MS must be between 50 and 10000 ms')
      .default(DEFAULT_EXECUTION_WORKER_POLL_INTERVAL_MS),
    EXECUTION_LEASE_DURATION_MS: z.coerce
      .number()
      .int()
      .min(1000, 'EXECUTION_LEASE_DURATION_MS must be between 1000 and 120000 ms')
      .max(120000, 'EXECUTION_LEASE_DURATION_MS must be between 1000 and 120000 ms')
      .default(DEFAULT_EXECUTION_LEASE_DURATION_MS),
    EXECUTION_LEASE_RENEW_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(500, 'EXECUTION_LEASE_RENEW_INTERVAL_MS must be between 500 and 60000 ms')
      .max(60000, 'EXECUTION_LEASE_RENEW_INTERVAL_MS must be between 500 and 60000 ms')
      .default(DEFAULT_EXECUTION_LEASE_RENEW_INTERVAL_MS),
    EXECUTION_MAX_QUEUED_SUBMISSIONS: z.coerce
      .number()
      .int()
      .min(1, 'EXECUTION_MAX_QUEUED_SUBMISSIONS must be between 1 and 1000')
      .max(1000, 'EXECUTION_MAX_QUEUED_SUBMISSIONS must be between 1 and 1000')
      .default(DEFAULT_EXECUTION_MAX_QUEUED_SUBMISSIONS),
    EXECUTION_RETRY_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(0, 'EXECUTION_RETRY_MAX_ATTEMPTS must be between 0 and 10')
      .max(10, 'EXECUTION_RETRY_MAX_ATTEMPTS must be between 0 and 10')
      .default(DEFAULT_EXECUTION_RETRY_MAX_ATTEMPTS),
    EXECUTION_SHUTDOWN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500, 'EXECUTION_SHUTDOWN_TIMEOUT_MS must be between 500 and 60000 ms')
      .max(60000, 'EXECUTION_SHUTDOWN_TIMEOUT_MS must be between 500 and 60000 ms')
      .default(DEFAULT_EXECUTION_SHUTDOWN_TIMEOUT_MS),
    EXECUTION_UNCERTAIN_RECONCILE_MS: z.coerce
      .number()
      .int()
      .min(100, 'EXECUTION_UNCERTAIN_RECONCILE_MS must be between 100 and 300000 ms')
      .max(300000, 'EXECUTION_UNCERTAIN_RECONCILE_MS must be between 100 and 300000 ms')
      .default(DEFAULT_EXECUTION_UNCERTAIN_RECONCILE_MS)
  })
  .superRefine((data, ctx) => {
    const isProd = data.NODE_ENV === 'production';

    if (!data.PARTICIPANT_FRONTEND_URL) {
      if (isProd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PARTICIPANT_FRONTEND_URL'],
          message: 'PARTICIPANT_FRONTEND_URL is required in production'
        });
      }
    } else if (!isHttpUrl(data.PARTICIPANT_FRONTEND_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PARTICIPANT_FRONTEND_URL'],
        message: 'PARTICIPANT_FRONTEND_URL must be a valid http(s) URL'
      });
    }

    if (!data.ADMIN_FRONTEND_URL) {
      if (isProd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_FRONTEND_URL'],
          message: 'ADMIN_FRONTEND_URL is required in production'
        });
      }
    } else if (!isHttpUrl(data.ADMIN_FRONTEND_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_FRONTEND_URL'],
        message: 'ADMIN_FRONTEND_URL must be a valid http(s) URL'
      });
    }

    if (!data.GOOGLE_CALLBACK_URL) {
      if (isProd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GOOGLE_CALLBACK_URL'],
          message: 'GOOGLE_CALLBACK_URL is required in production'
        });
      }
    } else if (!isHttpUrl(data.GOOGLE_CALLBACK_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_CALLBACK_URL'],
        message: 'GOOGLE_CALLBACK_URL must be a valid http(s) URL'
      });
    }

    if (
      data.MONGODB_TEST_URI &&
      !data.MONGODB_TEST_URI.startsWith('mongodb://') &&
      !data.MONGODB_TEST_URI.startsWith('mongodb+srv://')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MONGODB_TEST_URI'],
        message: 'MONGODB_TEST_URI must use mongodb:// or mongodb+srv:// scheme'
      });
    }

    if (data.MONGODB_DNS_SERVERS) {
      const servers = parseDnsServers(data.MONGODB_DNS_SERVERS);
      if (servers.length === 0 || servers.some((ip) => net.isIP(ip) === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MONGODB_DNS_SERVERS'],
          message: 'MONGODB_DNS_SERVERS must be a comma-separated list of valid IP addresses'
        });
      }
    }

    if (data.SESSION_IDLE_TIMEOUT_MS > data.SESSION_MAX_AGE_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_IDLE_TIMEOUT_MS'],
        message: 'SESSION_IDLE_TIMEOUT_MS cannot exceed SESSION_MAX_AGE_MS'
      });
    }

    if (data.JUDGE0_URL && !isSafeJudge0Url(data.JUDGE0_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JUDGE0_URL'],
        message:
          'JUDGE0_URL must be a valid private/self-hosted http(s) URL without embedded credentials or public hosted Judge0 domains'
      });
    }

    if (data.JUDGE0_POLL_INTERVAL_MS > data.JUDGE0_POLL_TIMEOUT_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JUDGE0_POLL_INTERVAL_MS'],
        message: 'JUDGE0_POLL_INTERVAL_MS cannot exceed JUDGE0_POLL_TIMEOUT_MS'
      });
    }

    if (data.EXECUTION_LEASE_RENEW_INTERVAL_MS >= data.EXECUTION_LEASE_DURATION_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EXECUTION_LEASE_RENEW_INTERVAL_MS'],
        message: 'EXECUTION_LEASE_RENEW_INTERVAL_MS must be less than EXECUTION_LEASE_DURATION_MS'
      });
    }
  });

/**
 * Validate raw environment variables without logging or exposing secret values.
 * Preserves legacy MONGO_URI fallback when MONGODB_URI is unset.
 */
export function validateEnv(rawEnv = process.env) {
  const mongoUri =
    normalizeOptionalString(rawEnv.MONGODB_URI) ??
    normalizeOptionalString(rawEnv.MONGO_URI);

  const candidate = {
    NODE_ENV: normalizeOptionalString(rawEnv.NODE_ENV),
    PORT: normalizeOptionalString(rawEnv.PORT),
    MONGODB_URI: mongoUri,
    MONGODB_TEST_URI: normalizeOptionalString(rawEnv.MONGODB_TEST_URI),
    MONGODB_DNS_SERVERS: normalizeOptionalString(rawEnv.MONGODB_DNS_SERVERS),
    MONGODB_DNS_FALLBACK: normalizeOptionalString(rawEnv.MONGODB_DNS_FALLBACK),
    PARTICIPANT_FRONTEND_URL: normalizeOptionalString(rawEnv.PARTICIPANT_FRONTEND_URL),
    ADMIN_FRONTEND_URL: normalizeOptionalString(rawEnv.ADMIN_FRONTEND_URL),
    LOG_LEVEL: normalizeOptionalString(rawEnv.LOG_LEVEL),
    LOG_FORMAT: normalizeOptionalString(rawEnv.LOG_FORMAT),
    GOOGLE_CLIENT_ID: normalizeOptionalString(rawEnv.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: normalizeOptionalString(rawEnv.GOOGLE_CLIENT_SECRET),
    GOOGLE_CALLBACK_URL: normalizeOptionalString(rawEnv.GOOGLE_CALLBACK_URL),
    SESSION_SECRET: normalizeOptionalString(rawEnv.SESSION_SECRET),
    SESSION_MAX_AGE_MS: normalizeOptionalString(rawEnv.SESSION_MAX_AGE_MS),
    SESSION_IDLE_TIMEOUT_MS: normalizeOptionalString(rawEnv.SESSION_IDLE_TIMEOUT_MS),
    OAUTH_STATE_TTL_MS: normalizeOptionalString(rawEnv.OAUTH_STATE_TTL_MS),
    JUDGE0_URL: normalizeOptionalString(rawEnv.JUDGE0_URL),
    JUDGE0_AUTH_TOKEN: normalizeOptionalString(rawEnv.JUDGE0_AUTH_TOKEN),
    JUDGE0_MAX_IN_FLIGHT: normalizeOptionalString(rawEnv.JUDGE0_MAX_IN_FLIGHT),
    JUDGE0_REQUEST_TIMEOUT_MS: normalizeOptionalString(rawEnv.JUDGE0_REQUEST_TIMEOUT_MS),
    JUDGE0_POLL_INTERVAL_MS: normalizeOptionalString(rawEnv.JUDGE0_POLL_INTERVAL_MS),
    JUDGE0_POLL_TIMEOUT_MS: normalizeOptionalString(rawEnv.JUDGE0_POLL_TIMEOUT_MS),
    EXECUTION_WORKER_ENABLED: normalizeOptionalString(rawEnv.EXECUTION_WORKER_ENABLED),
    EXECUTION_WORKER_POLL_INTERVAL_MS: normalizeOptionalString(
      rawEnv.EXECUTION_WORKER_POLL_INTERVAL_MS
    ),
    EXECUTION_LEASE_DURATION_MS: normalizeOptionalString(rawEnv.EXECUTION_LEASE_DURATION_MS),
    EXECUTION_LEASE_RENEW_INTERVAL_MS: normalizeOptionalString(
      rawEnv.EXECUTION_LEASE_RENEW_INTERVAL_MS
    ),
    EXECUTION_MAX_QUEUED_SUBMISSIONS: normalizeOptionalString(
      rawEnv.EXECUTION_MAX_QUEUED_SUBMISSIONS
    ),
    EXECUTION_RETRY_MAX_ATTEMPTS: normalizeOptionalString(rawEnv.EXECUTION_RETRY_MAX_ATTEMPTS),
    EXECUTION_SHUTDOWN_TIMEOUT_MS: normalizeOptionalString(rawEnv.EXECUTION_SHUTDOWN_TIMEOUT_MS),
    EXECUTION_UNCERTAIN_RECONCILE_MS: normalizeOptionalString(
      rawEnv.EXECUTION_UNCERTAIN_RECONCILE_MS
    )
  };

  const result = envSchema.safeParse(candidate);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'ENV'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const parsed = result.data;
  const participantUrl = stripTrailingSlash(
    parsed.PARTICIPANT_FRONTEND_URL ?? 'http://localhost:5173'
  );
  const adminUrl = stripTrailingSlash(
    parsed.ADMIN_FRONTEND_URL ?? 'http://localhost:5174'
  );
  const googleCallbackUrl =
    parsed.GOOGLE_CALLBACK_URL ?? 'http://localhost:5000/api/auth/google/callback';

  const corsOrigins = Array.from(new Set([participantUrl, adminUrl]));
  const dnsServers = parseDnsServers(parsed.MONGODB_DNS_SERVERS);

  // Disabled by default in production; enabled in development/test for Windows WARP c-ares quirk.
  const allowDnsFallback =
    parsed.MONGODB_DNS_FALLBACK !== undefined
      ? parsed.MONGODB_DNS_FALLBACK === 'true'
      : parsed.NODE_ENV !== 'production';

  const logFormat =
    parsed.LOG_FORMAT ?? (parsed.NODE_ENV === 'production' ? 'json' : 'minimal');
  const logLevel = parsed.LOG_LEVEL ?? (logFormat === 'debug' ? 'debug' : 'info');

  const executionWorkerEnabled =
    parsed.EXECUTION_WORKER_ENABLED !== undefined
      ? parsed.EXECUTION_WORKER_ENABLED === 'true'
      : parsed.NODE_ENV !== 'test';

  return Object.freeze({
    NODE_ENV: parsed.NODE_ENV,
    PORT: parsed.PORT,
    MONGODB_URI: parsed.MONGODB_URI,
    MONGODB_TEST_URI: parsed.MONGODB_TEST_URI,
    MONGODB_DNS_SERVERS: Object.freeze(dnsServers),
    MONGODB_DNS_FALLBACK: allowDnsFallback,
    PARTICIPANT_FRONTEND_URL: participantUrl,
    ADMIN_FRONTEND_URL: adminUrl,
    CORS_ORIGINS: Object.freeze(corsOrigins),
    LOG_LEVEL: logLevel,
    LOG_FORMAT: logFormat,
    GOOGLE_CLIENT_ID: parsed.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: parsed.GOOGLE_CLIENT_SECRET,
    GOOGLE_CALLBACK_URL: googleCallbackUrl,
    SESSION_SECRET: parsed.SESSION_SECRET,
    SESSION_MAX_AGE_MS: parsed.SESSION_MAX_AGE_MS,
    SESSION_IDLE_TIMEOUT_MS: parsed.SESSION_IDLE_TIMEOUT_MS,
    OAUTH_STATE_TTL_MS: parsed.OAUTH_STATE_TTL_MS,
    JUDGE0_URL: stripTrailingSlash(parsed.JUDGE0_URL ?? DEFAULT_JUDGE0_URL),
    JUDGE0_AUTH_TOKEN: parsed.JUDGE0_AUTH_TOKEN,
    JUDGE0_MAX_IN_FLIGHT: parsed.JUDGE0_MAX_IN_FLIGHT,
    JUDGE0_REQUEST_TIMEOUT_MS: parsed.JUDGE0_REQUEST_TIMEOUT_MS,
    JUDGE0_POLL_INTERVAL_MS: parsed.JUDGE0_POLL_INTERVAL_MS,
    JUDGE0_POLL_TIMEOUT_MS: parsed.JUDGE0_POLL_TIMEOUT_MS,
    EXECUTION_WORKER_ENABLED: executionWorkerEnabled,
    EXECUTION_WORKER_POLL_INTERVAL_MS: parsed.EXECUTION_WORKER_POLL_INTERVAL_MS,
    EXECUTION_LEASE_DURATION_MS: parsed.EXECUTION_LEASE_DURATION_MS,
    EXECUTION_LEASE_RENEW_INTERVAL_MS: parsed.EXECUTION_LEASE_RENEW_INTERVAL_MS,
    EXECUTION_MAX_QUEUED_SUBMISSIONS: parsed.EXECUTION_MAX_QUEUED_SUBMISSIONS,
    EXECUTION_RETRY_MAX_ATTEMPTS: parsed.EXECUTION_RETRY_MAX_ATTEMPTS,
    EXECUTION_SHUTDOWN_TIMEOUT_MS: parsed.EXECUTION_SHUTDOWN_TIMEOUT_MS,
    EXECUTION_UNCERTAIN_RECONCILE_MS: parsed.EXECUTION_UNCERTAIN_RECONCILE_MS
  });
}

/**
 * Load variables from .env (if present) and validate the application configuration.
 */
export function loadEnv({ envPath = DEFAULT_ENV_PATH, override = false } = {}) {
  dotenv.config({ path: envPath, override, quiet: true });
  return validateEnv(process.env);
}
