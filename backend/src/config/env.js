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
      .default(DEFAULT_OAUTH_STATE_TTL_MS)
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
    OAUTH_STATE_TTL_MS: normalizeOptionalString(rawEnv.OAUTH_STATE_TTL_MS)
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
    OAUTH_STATE_TTL_MS: parsed.OAUTH_STATE_TTL_MS
  });
}

/**
 * Load variables from .env (if present) and validate the application configuration.
 */
export function loadEnv({ envPath = DEFAULT_ENV_PATH, override = false } = {}) {
  dotenv.config({ path: envPath, override, quiet: true });
  return validateEnv(process.env);
}
