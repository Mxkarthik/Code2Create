import {
  DEFAULT_JUDGE0_MAX_IN_FLIGHT,
  DEFAULT_JUDGE0_POLL_INTERVAL_MS,
  DEFAULT_JUDGE0_POLL_TIMEOUT_MS,
  DEFAULT_JUDGE0_REQUEST_TIMEOUT_MS,
  DEFAULT_JUDGE0_URL
} from '../../config/env.js';
import { JUDGE0_ERROR_CODES, Judge0Error } from './judge0.errors.js';

export const JUDGE0_MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
export const JUDGE0_DEFAULT_MAX_FILE_SIZE_KB = 1024; // Matches deployed Judge0 default (1024 KB)
export const JUDGE0_SUBMISSION_RESULT_FIELDS =
  'token,stdout,stderr,compile_output,message,status,status_id,time,wall_time,memory,exit_code,exit_signal';

const BLOCKED_PUBLIC_JUDGE0_HOSTS = new Set([
  'ce.judge0.com',
  'api.judge0.com',
  'judge0-ce.p.rapidapi.com'
]);

function coerceInt(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const num = Number(value);
  return Number.isInteger(num) ? num : NaN;
}

/**
 * Validate and normalize Judge0 client settings independently of unrelated app boot logic.
 */
export function validateJudge0Config(rawConfig = {}, { requireAuthToken = true } = {}) {
  const rawUrl =
    typeof rawConfig.JUDGE0_URL === 'string' && rawConfig.JUDGE0_URL.trim().length > 0
      ? rawConfig.JUDGE0_URL.trim()
      : typeof rawConfig.url === 'string' && rawConfig.url.trim().length > 0
        ? rawConfig.url.trim()
        : DEFAULT_JUDGE0_URL;

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Judge0Error('JUDGE0_URL is not a valid URL', {
      code: JUDGE0_ERROR_CODES.CONFIG_ERROR,
      statusCode: 500
    });
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Judge0Error('JUDGE0_URL must use http:// or https:// scheme', {
      code: JUDGE0_ERROR_CODES.CONFIG_ERROR,
      statusCode: 500
    });
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Judge0Error('JUDGE0_URL must not contain embedded URL credentials', {
      code: JUDGE0_ERROR_CODES.CONFIG_ERROR,
      statusCode: 500
    });
  }

  if (BLOCKED_PUBLIC_JUDGE0_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    throw new Judge0Error('Public Judge0 hosts are prohibited; use self-hosted Judge0', {
      code: JUDGE0_ERROR_CODES.CONFIG_ERROR,
      statusCode: 500
    });
  }

  const rawToken = rawConfig.JUDGE0_AUTH_TOKEN ?? rawConfig.authToken ?? '';
  const authToken = typeof rawToken === 'string' ? rawToken.trim() : '';

  if (requireAuthToken && !authToken) {
    throw new Judge0Error('JUDGE0_AUTH_TOKEN is required for authenticated Judge0 requests', {
      code: JUDGE0_ERROR_CODES.CONFIG_ERROR,
      statusCode: 500
    });
  }

  const maxInFlight = coerceInt(
    rawConfig.JUDGE0_MAX_IN_FLIGHT ?? rawConfig.maxInFlight,
    DEFAULT_JUDGE0_MAX_IN_FLIGHT
  );
  const requestTimeoutMs = coerceInt(
    rawConfig.JUDGE0_REQUEST_TIMEOUT_MS ?? rawConfig.requestTimeoutMs,
    DEFAULT_JUDGE0_REQUEST_TIMEOUT_MS
  );
  const pollIntervalMs = coerceInt(
    rawConfig.JUDGE0_POLL_INTERVAL_MS ?? rawConfig.pollIntervalMs,
    DEFAULT_JUDGE0_POLL_INTERVAL_MS
  );
  const pollTimeoutMs = coerceInt(
    rawConfig.JUDGE0_POLL_TIMEOUT_MS ?? rawConfig.pollTimeoutMs,
    DEFAULT_JUDGE0_POLL_TIMEOUT_MS
  );
  const maxResponseBytes = coerceInt(
    rawConfig.maxResponseBytes,
    JUDGE0_MAX_HTTP_RESPONSE_BYTES
  );

  if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64) {
    throw new Judge0Error('JUDGE0_MAX_IN_FLIGHT must be an integer between 1 and 64', {
      code: JUDGE0_ERROR_CODES.CONFIG_ERROR,
      statusCode: 500
    });
  }

  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 100 ||
    requestTimeoutMs > 60000
  ) {
    throw new Judge0Error('JUDGE0_REQUEST_TIMEOUT_MS must be an integer between 100 and 60000', {
      code: JUDGE0_ERROR_CODES.CONFIG_ERROR,
      statusCode: 500
    });
  }

  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 10000) {
    throw new Judge0Error('JUDGE0_POLL_INTERVAL_MS must be an integer between 10 and 10000', {
      code: JUDGE0_ERROR_CODES.CONFIG_ERROR,
      statusCode: 500
    });
  }

  if (!Number.isInteger(pollTimeoutMs) || pollTimeoutMs < 100 || pollTimeoutMs > 300000) {
    throw new Judge0Error('JUDGE0_POLL_TIMEOUT_MS must be an integer between 100 and 300000', {
      code: JUDGE0_ERROR_CODES.CONFIG_ERROR,
      statusCode: 500
    });
  }

  if (pollIntervalMs > pollTimeoutMs) {
    throw new Judge0Error('JUDGE0_POLL_INTERVAL_MS cannot exceed JUDGE0_POLL_TIMEOUT_MS', {
      code: JUDGE0_ERROR_CODES.CONFIG_ERROR,
      statusCode: 500
    });
  }

  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 512) {
    throw new Judge0Error('maxResponseBytes must be an integer >= 512', {
      code: JUDGE0_ERROR_CODES.CONFIG_ERROR,
      statusCode: 500
    });
  }

  return Object.freeze({
    baseUrl: parsedUrl.toString().replace(/\/+$/, ''),
    authToken,
    maxInFlight,
    requestTimeoutMs,
    pollIntervalMs,
    pollTimeoutMs,
    maxResponseBytes
  });
}
