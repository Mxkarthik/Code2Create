import {
  JUDGE0_SUBMISSION_RESULT_FIELDS,
  validateJudge0Config
} from './judge0.config.js';
import { JUDGE0_ERROR_CODES, Judge0Error, isJudge0Error } from './judge0.errors.js';

const DEFAULT_GET_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 150;
const SAFE_TOKEN_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCauseCode(err) {
  return err?.cause?.code || err?.code || '';
}

function isAbortOrTimeout(err) {
  return (
    err?.name === 'AbortError' ||
    err?.name === 'TimeoutError' ||
    getCauseCode(err) === 'UND_ERR_HEADERS_TIMEOUT' ||
    getCauseCode(err) === 'UND_ERR_BODY_TIMEOUT' ||
    getCauseCode(err) === 'ABORT_ERR'
  );
}

function isPreConnectNetworkError(err) {
  const code = getCauseCode(err);
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH'
  );
}

function isTransientGetHttpStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function computeRetryDelayMs(attemptIndex, baseDelayMs, randomFn) {
  const exponential = baseDelayMs * 2 ** attemptIndex;
  const jitter = Math.floor(randomFn() * Math.max(25, Math.floor(exponential * 0.4)));
  return exponential + jitter;
}

/**
 * Read HTTP response text strictly within maxResponseBytes to protect Node memory.
 */
async function readBoundedResponseText(response, maxBytes) {
  const declaredLenHeader = response?.headers?.get?.('content-length');
  if (declaredLenHeader !== null && declaredLenHeader !== undefined && declaredLenHeader !== '') {
    const declaredLen = Number(declaredLenHeader);
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      try {
        await response.body?.cancel?.();
      } catch {
        // Ignore cancellation failures
      }
      throw new Judge0Error('Judge0 HTTP response exceeded configured byte limit', {
        code: JUDGE0_ERROR_CODES.INVALID_RESPONSE,
        statusCode: 502,
        httpStatus: response.status
      });
    }
  }

  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          totalBytes += value.byteLength ?? value.length ?? 0;
          if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Judge0Error('Judge0 HTTP response exceeded configured byte limit', {
              code: JUDGE0_ERROR_CODES.INVALID_RESPONSE,
              statusCode: 502,
              httpStatus: response.status
            });
          }
          chunks.push(Buffer.from(value));
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Judge0Error('Judge0 HTTP response exceeded configured byte limit', {
      code: JUDGE0_ERROR_CODES.INVALID_RESPONSE,
      statusCode: 502,
      httpStatus: response.status
    });
  }
  return text;
}

function parseJsonBodyStrict(rawText, { httpStatus, onInvalidCode, admissionUncertain = false }) {
  try {
    const parsed = JSON.parse(rawText);
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('Expected JSON object or array');
    }
    return parsed;
  } catch (err) {
    throw new Judge0Error('Judge0 returned malformed JSON payload', {
      code: onInvalidCode,
      statusCode: 502,
      httpStatus,
      admissionUncertain,
      cause: err
    });
  }
}

function looksLikeQueueSaturated(rawText) {
  const lower = String(rawText || '').toLowerCase();
  return lower.includes('queue') || lower.includes('max_queue_size') || lower.includes('full');
}

/**
 * Create an internal HTTP client for our self-hosted Judge0 CE server.
 * Never logs auth tokens, follows redirects, or automatically retries POST submissions.
 */
export function createJudge0Client({
  config = {},
  fetchFn = globalThis.fetch,
  sleepFn = defaultSleep,
  randomFn = Math.random,
  maxGetAttempts = DEFAULT_GET_MAX_ATTEMPTS,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS
} = {}) {
  if (typeof fetchFn !== 'function') {
    throw new Error('A valid fetch implementation is required for createJudge0Client');
  }

  function getValidatedConfig({ requireAuthToken = true } = {}) {
    return validateJudge0Config(config, { requireAuthToken });
  }

  async function sendSingleHttp({
    method,
    path,
    bodyJson,
    requireAuthToken = true,
    isSubmissionPost = false,
    tokenOverride
  }) {
    const resolved = getValidatedConfig({ requireAuthToken });
    const targetUrl = `${resolved.baseUrl}${path}`;
    const headers = {
      Accept: 'application/json'
    };

    const effectiveToken = tokenOverride !== undefined ? tokenOverride : resolved.authToken;
    if (effectiveToken) {
      headers['X-Auth-Token'] = effectiveToken;
    }

    if (bodyJson !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const timeoutSignal =
      typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(resolved.requestTimeoutMs)
        : undefined;

    let response;
    try {
      response = await fetchFn(targetUrl, {
        method,
        headers,
        body: bodyJson,
        redirect: 'manual',
        signal: timeoutSignal
      });
    } catch (err) {
      if (isSubmissionPost) {
        if (isPreConnectNetworkError(err)) {
          throw new Judge0Error('Judge0 service is unreachable', {
            code: JUDGE0_ERROR_CODES.UNREACHABLE,
            statusCode: 503,
            admissionUncertain: false,
            isRetryable: false,
            cause: err
          });
        }
        throw new Judge0Error(
          isAbortOrTimeout(err)
            ? 'Judge0 submission request timed out; admission state is uncertain'
            : 'Judge0 submission connection failed after request transmission; admission state is uncertain',
          {
            code: JUDGE0_ERROR_CODES.SUBMISSION_ADMISSION_UNCERTAIN,
            statusCode: 503,
            admissionUncertain: true,
            isRetryable: false,
            cause: err
          }
        );
      }

      if (isAbortOrTimeout(err)) {
        throw new Judge0Error('Judge0 GET request timed out', {
          code: JUDGE0_ERROR_CODES.TIMEOUT,
          statusCode: 504,
          isRetryable: true,
          cause: err
        });
      }

      throw new Judge0Error('Unable to reach Judge0 service', {
        code: JUDGE0_ERROR_CODES.UNREACHABLE,
        statusCode: 503,
        isRetryable: true,
        cause: err
      });
    }

    if (
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400)
    ) {
      try {
        await response.body?.cancel?.();
      } catch {
        // Ignore cancellation failures
      }
      throw new Judge0Error('Unexpected HTTP redirect rejected by Judge0 client', {
        code: JUDGE0_ERROR_CODES.REDIRECT_REJECTED,
        statusCode: 502,
        httpStatus: response.status,
        admissionUncertain: false,
        isRetryable: false
      });
    }

    let rawText;
    try {
      rawText = await readBoundedResponseText(response, resolved.maxResponseBytes);
    } catch (err) {
      if (isJudge0Error(err)) {
        if (isSubmissionPost && response.ok) {
          throw new Judge0Error(
            'Judge0 accepted request but returned an oversized or unreadable response',
            {
              code: JUDGE0_ERROR_CODES.SUBMISSION_ADMISSION_UNCERTAIN,
              statusCode: 502,
              httpStatus: response.status,
              admissionUncertain: true,
              cause: err
            }
          );
        }
        throw err;
      }

      if (isSubmissionPost) {
        throw new Judge0Error(
          'Judge0 submission response stream failed; admission state is uncertain',
          {
            code: JUDGE0_ERROR_CODES.SUBMISSION_ADMISSION_UNCERTAIN,
            statusCode: 503,
            httpStatus: response.status,
            admissionUncertain: true,
            cause: err
          }
        );
      }

      throw new Judge0Error('Failed to read Judge0 response stream', {
        code: isAbortOrTimeout(err) ? JUDGE0_ERROR_CODES.TIMEOUT : JUDGE0_ERROR_CODES.UNREACHABLE,
        statusCode: 503,
        httpStatus: response.status,
        isRetryable: true,
        cause: err
      });
    }

    return {
      status: response.status,
      ok: response.ok,
      rawText
    };
  }

  async function performSafeGet(path, { requireAuthToken = true, tokenOverride } = {}) {
    let lastErr;

    for (let attempt = 0; attempt < maxGetAttempts; attempt += 1) {
      try {
        const res = await sendSingleHttp({
          method: 'GET',
          path,
          requireAuthToken,
          isSubmissionPost: false,
          tokenOverride
        });

        if (res.status === 401 || res.status === 403) {
          throw new Judge0Error('Judge0 authentication failed', {
            code: JUDGE0_ERROR_CODES.AUTH_FAILED,
            statusCode: 503,
            httpStatus: res.status,
            isRetryable: false
          });
        }

        if (isTransientGetHttpStatus(res.status)) {
          const errorCode =
            res.status === 429 || (res.status === 503 && looksLikeQueueSaturated(res.rawText))
              ? JUDGE0_ERROR_CODES.QUEUE_SATURATED
              : JUDGE0_ERROR_CODES.UNREACHABLE;

          throw new Judge0Error(`Judge0 returned transient HTTP status ${res.status}`, {
            code: errorCode,
            statusCode: 503,
            httpStatus: res.status,
            isRetryable: true
          });
        }

        if (!res.ok) {
          throw new Judge0Error(`Judge0 rejected GET request with status ${res.status}`, {
            code:
              res.status === 422 || res.status === 400 || res.status === 404
                ? JUDGE0_ERROR_CODES.INVALID_REQUEST
                : JUDGE0_ERROR_CODES.INVALID_RESPONSE,
            statusCode: 502,
            httpStatus: res.status,
            isRetryable: false
          });
        }

        return parseJsonBodyStrict(res.rawText, {
          httpStatus: res.status,
          onInvalidCode: JUDGE0_ERROR_CODES.INVALID_RESPONSE,
          admissionUncertain: false
        });
      } catch (err) {
        lastErr = err;
        if (isJudge0Error(err) && err.isRetryable && attempt + 1 < maxGetAttempts) {
          const delayMs = computeRetryDelayMs(attempt, retryBaseDelayMs, randomFn);
          await sleepFn(delayMs);
          continue;
        }
        throw err;
      }
    }

    throw lastErr;
  }

  return {
    getConfigSummary() {
      const cfg = getValidatedConfig({ requireAuthToken: false });
      return {
        baseUrl: cfg.baseUrl,
        hasAuthToken: Boolean(cfg.authToken),
        maxInFlight: cfg.maxInFlight,
        requestTimeoutMs: cfg.requestTimeoutMs,
        pollIntervalMs: cfg.pollIntervalMs,
        pollTimeoutMs: cfg.pollTimeoutMs,
        maxResponseBytes: cfg.maxResponseBytes
      };
    },

    async getAbout({ tokenOverride } = {}) {
      return performSafeGet('/about', {
        requireAuthToken: tokenOverride === undefined,
        tokenOverride
      });
    },

    async getLanguages() {
      const payload = await performSafeGet('/languages');
      if (!Array.isArray(payload)) {
        throw new Judge0Error('Judge0 /languages response must be an array', {
          code: JUDGE0_ERROR_CODES.INVALID_RESPONSE,
          statusCode: 502
        });
      }
      return payload;
    },

    async getStatuses() {
      const payload = await performSafeGet('/statuses');
      if (!Array.isArray(payload)) {
        throw new Judge0Error('Judge0 /statuses response must be an array', {
          code: JUDGE0_ERROR_CODES.INVALID_RESPONSE,
          statusCode: 502
        });
      }
      return payload;
    },

    async getConfigInfo() {
      return performSafeGet('/config_info');
    },

    /**
     * Submit an asynchronous job to Judge0.
     * NEVER performs automatic retries because ambiguous transport/response errors
     * may occur after Judge0 already queued the job.
     */
    async postSubmission(submissionPayload) {
      if (
        !submissionPayload ||
        typeof submissionPayload !== 'object' ||
        Array.isArray(submissionPayload)
      ) {
        throw new Judge0Error('Submission payload must be an object', {
          code: JUDGE0_ERROR_CODES.INVALID_REQUEST,
          statusCode: 400,
          isInfrastructureError: false
        });
      }

      const serialized = JSON.stringify(submissionPayload);
      const res = await sendSingleHttp({
        method: 'POST',
        path: '/submissions?base64_encoded=true&wait=false',
        bodyJson: serialized,
        requireAuthToken: true,
        isSubmissionPost: true
      });

      if (res.status === 401 || res.status === 403) {
        throw new Judge0Error('Judge0 authentication failed during submission', {
          code: JUDGE0_ERROR_CODES.AUTH_FAILED,
          statusCode: 503,
          httpStatus: res.status,
          admissionUncertain: false
        });
      }

      if (res.status === 400 || res.status === 422) {
        throw new Judge0Error(`Judge0 rejected submission parameters (${res.status})`, {
          code: JUDGE0_ERROR_CODES.INVALID_REQUEST,
          statusCode: 502,
          httpStatus: res.status,
          admissionUncertain: false
        });
      }

      if (res.status === 429 || (res.status === 503 && looksLikeQueueSaturated(res.rawText))) {
        throw new Judge0Error('Judge0 submission queue is saturated', {
          code: JUDGE0_ERROR_CODES.QUEUE_SATURATED,
          statusCode: 503,
          httpStatus: res.status,
          admissionUncertain: false
        });
      }

      if (res.status >= 500) {
        throw new Judge0Error(
          `Judge0 returned HTTP ${res.status} on submission creation; admission state is uncertain`,
          {
            code: JUDGE0_ERROR_CODES.SUBMISSION_ADMISSION_UNCERTAIN,
            statusCode: 503,
            httpStatus: res.status,
            admissionUncertain: true
          }
        );
      }

      if (!res.ok) {
        throw new Judge0Error(`Unexpected HTTP ${res.status} from Judge0 submission creation`, {
          code: JUDGE0_ERROR_CODES.SUBMISSION_ADMISSION_UNCERTAIN,
          statusCode: 502,
          httpStatus: res.status,
          admissionUncertain: true
        });
      }

      const parsed = parseJsonBodyStrict(res.rawText, {
        httpStatus: res.status,
        onInvalidCode: JUDGE0_ERROR_CODES.SUBMISSION_ADMISSION_UNCERTAIN,
        admissionUncertain: true
      });

      const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
      if (!SAFE_TOKEN_REGEX.test(token)) {
        throw new Judge0Error(
          'Judge0 returned HTTP success without a valid submission token; admission state is uncertain',
          {
            code: JUDGE0_ERROR_CODES.SUBMISSION_ADMISSION_UNCERTAIN,
            statusCode: 502,
            httpStatus: res.status,
            admissionUncertain: true
          }
        );
      }

      return { token };
    },

    async getSubmission(token) {
      const normalized = typeof token === 'string' ? token.trim() : '';
      if (!SAFE_TOKEN_REGEX.test(normalized)) {
        throw new Judge0Error('Invalid Judge0 submission token format', {
          code: JUDGE0_ERROR_CODES.INVALID_REQUEST,
          statusCode: 400,
          isInfrastructureError: false
        });
      }

      const fields = encodeURIComponent(JUDGE0_SUBMISSION_RESULT_FIELDS);
      return performSafeGet(
        `/submissions/${encodeURIComponent(normalized)}?base64_encoded=true&fields=${fields}`
      );
    }
  };
}
