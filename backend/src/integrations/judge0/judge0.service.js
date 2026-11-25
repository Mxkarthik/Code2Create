import {
  EXECUTION_LIMIT_BOUNDS,
  EXECUTION_POLICY,
  LANGUAGE_CONFIG,
  getLanguageConfig
} from '../../modules/problems/language.config.js';
import { JUDGE0_DEFAULT_MAX_FILE_SIZE_KB, validateJudge0Config } from './judge0.config.js';
import { JUDGE0_ERROR_CODES, Judge0Error, isJudge0Error } from './judge0.errors.js';
import { createJudge0Client } from './judge0.client.js';
import { mapExecutionResult } from './judge0.mapper.js';

const FORBIDDEN_REQUEST_OVERRIDE_KEYS = Object.freeze([
  'compiler_options',
  'compilerOptions',
  'command_line_arguments',
  'commandLineArguments',
  'additional_files',
  'additionalFiles',
  'callback_url',
  'callbackUrl',
  'enable_network',
  'enableNetwork',
  'language_id',
  'languageId',
  'cpu_time_limit',
  'wall_time_limit',
  'memory_limit',
  'number_of_runs',
  'expected_output',
  'expectedOutput'
]);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeBase64Utf8(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function clampBoundedNumber(value, bounds, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/**
 * Resolve trusted execution limits for a language, optionally overriding from stored Problem config.
 */
function resolveTrustedLanguageLimits(languageKey, problemExecutionLimits = null) {
  const langCfg = getLanguageConfig(languageKey);
  const perLangSource =
    problemExecutionLimits?.perLanguage instanceof Map
      ? problemExecutionLimits.perLanguage.get(languageKey)
      : problemExecutionLimits?.perLanguage?.[languageKey];

  const base = langCfg.executionLimits;
  return {
    cpuTimeLimitSeconds: clampBoundedNumber(
      perLangSource?.cpuTimeLimitSeconds,
      EXECUTION_LIMIT_BOUNDS.cpuTimeLimitSeconds,
      base.cpuTimeLimitSeconds
    ),
    wallTimeLimitSeconds: clampBoundedNumber(
      perLangSource?.wallTimeLimitSeconds,
      EXECUTION_LIMIT_BOUNDS.wallTimeLimitSeconds,
      base.wallTimeLimitSeconds
    ),
    memoryLimitKb: clampBoundedNumber(
      perLangSource?.memoryLimitKb,
      EXECUTION_LIMIT_BOUNDS.memoryLimitKb,
      base.memoryLimitKb
    )
  };
}

/**
 * Construct a trusted Judge0 POST /submissions payload solely from server policy.
 */
export function buildJudge0SubmissionPayload({
  language,
  sourceCode,
  stdin = '',
  executionLimits = null,
  extraOptions
}) {
  if (extraOptions && typeof extraOptions === 'object') {
    for (const key of FORBIDDEN_REQUEST_OVERRIDE_KEYS) {
      if (Object.hasOwn(extraOptions, key) && extraOptions[key] !== undefined) {
        throw new Judge0Error(`Forbidden execution option override: ${key}`, {
          code: JUDGE0_ERROR_CODES.INVALID_REQUEST,
          statusCode: 400,
          isInfrastructureError: false
        });
      }
    }
  }

  const langCfg = getLanguageConfig(language);

  if (typeof sourceCode !== 'string' || sourceCode.trim().length === 0) {
    throw new Judge0Error('Source code must be a non-empty string', {
      code: JUDGE0_ERROR_CODES.INVALID_REQUEST,
      statusCode: 400,
      isInfrastructureError: false
    });
  }

  const maxSourceBytes =
    executionLimits?.maxSourceCodeBytes ?? EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES;
  const sourceBytes = Buffer.byteLength(sourceCode, 'utf8');
  if (sourceBytes > maxSourceBytes) {
    throw new Judge0Error(
      `Source code size (${sourceBytes} bytes) exceeds maximum limit (${maxSourceBytes} bytes)`,
      {
        code: JUDGE0_ERROR_CODES.INVALID_REQUEST,
        statusCode: 400,
        isInfrastructureError: false
      }
    );
  }

  if (typeof stdin !== 'string') {
    throw new Judge0Error('Test case stdin must be a string', {
      code: JUDGE0_ERROR_CODES.INVALID_REQUEST,
      statusCode: 400,
      isInfrastructureError: false
    });
  }

  const limits = resolveTrustedLanguageLimits(langCfg.key, executionLimits);

  return {
    languageKey: langCfg.key,
    limitsApplied: {
      ...limits,
      maxSourceCodeBytes: maxSourceBytes,
      maxOutputBytes:
        executionLimits?.maxOutputBytes ?? EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES,
      networkAccessEnabled: false,
      oneRunPerJob: true
    },
    payload: {
      source_code: encodeBase64Utf8(sourceCode),
      language_id: langCfg.judge0LanguageId,
      stdin: encodeBase64Utf8(stdin),
      cpu_time_limit: limits.cpuTimeLimitSeconds,
      wall_time_limit: limits.wallTimeLimitSeconds,
      memory_limit: limits.memoryLimitKb,
      number_of_runs: 1,
      enable_network: false,
      max_file_size: JUDGE0_DEFAULT_MAX_FILE_SIZE_KB
    }
  };
}

/**
 * Create bounded in-flight semaphore so diagnostic batches stay within JUDGE0_MAX_IN_FLIGHT.
 */
export function createInFlightLimiter(maxConcurrent) {
  const cap = Math.max(1, Number(maxConcurrent) || 1);
  let active = 0;
  const queue = [];

  async function acquire() {
    if (active < cap) {
      active += 1;
      return;
    }
    await new Promise((resolve) => queue.push(resolve));
    active += 1;
  }

  function release() {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) {
      next();
    }
  }

  return {
    get activeCount() {
      return active;
    },
    get maxConcurrent() {
      return cap;
    },
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    }
  };
}

/**
 * Create the backend Judge0 integration service exposing discrete async operations.
 */
export function createJudge0Service({
  config = {},
  client,
  nowFn = () => Date.now(),
  sleepFn = defaultSleep
} = {}) {
  const judge0Client = client ?? createJudge0Client({ config, sleepFn });

  return {
    client: judge0Client,

    getConfig() {
      return validateJudge0Config(config, { requireAuthToken: false });
    },

    async createSubmission({
      language,
      sourceCode,
      stdin = '',
      executionLimits = null,
      extraOptions
    }) {
      const built = buildJudge0SubmissionPayload({
        language,
        sourceCode,
        stdin,
        executionLimits,
        extraOptions
      });

      const { token } = await judge0Client.postSubmission(built.payload);

      return {
        token,
        languageKey: built.languageKey,
        judge0LanguageId: built.payload.language_id,
        limitsApplied: built.limitsApplied
      };
    },

    async getSubmissionResult({
      token,
      maxOutputBytes = EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES
    }) {
      const raw = await judge0Client.getSubmission(token);
      return mapExecutionResult(raw, { token, maxOutputBytes });
    },

    /**
     * Bounded polling helper intended strictly for diagnostic scripts and internal
     * reference solution verification. Phase 07 persistent queues should persist tokens
     * and schedule incremental polling rather than blocking HTTP handlers.
     */
    async waitForResult({
      token,
      pollIntervalMs,
      pollTimeoutMs,
      maxOutputBytes = EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES
    }) {
      const cfg = validateJudge0Config(config, { requireAuthToken: false });
      const effectiveIntervalMs = pollIntervalMs ?? cfg.pollIntervalMs;
      const effectiveTimeoutMs = pollTimeoutMs ?? cfg.pollTimeoutMs;
      const deadlineMs = nowFn() + effectiveTimeoutMs;

      while (true) {
        const result = await this.getSubmissionResult({ token, maxOutputBytes });
        if (result.isTerminal) {
          return result;
        }

        const remainingMs = deadlineMs - nowFn();
        if (remainingMs <= 0) {
          throw new Judge0Error('Timed out waiting for Judge0 execution result', {
            code: JUDGE0_ERROR_CODES.POLL_TIMEOUT,
            statusCode: 504,
            isRetryable: true,
            isInfrastructureError: true,
            judge0Token: token
          });
        }

        await sleepFn(Math.min(effectiveIntervalMs, remainingMs));
      }
    },

    async checkAvailability() {
      const startedAt = nowFn();

      try {
        const cfg = validateJudge0Config(config, { requireAuthToken: true });
        const [about, languages] = await Promise.all([
          judge0Client.getAbout(),
          judge0Client.getLanguages()
        ]);

        const availableById = new Map(languages.map((entry) => [entry.id, entry.name]));
        const languageChecks = {};
        const missingLanguageIds = [];

        for (const [key, entry] of Object.entries(LANGUAGE_CONFIG)) {
          const remoteName = availableById.get(entry.judge0LanguageId) ?? null;
          languageChecks[key] = {
            expectedId: entry.judge0LanguageId,
            available: Boolean(remoteName),
            remoteName
          };
          if (!remoteName) {
            missingLanguageIds.push(entry.judge0LanguageId);
          }
        }

        return {
          available: missingLanguageIds.length === 0,
          authenticated: true,
          version: about?.version ?? null,
          baseUrl: cfg.baseUrl,
          latencyMs: nowFn() - startedAt,
          languageChecks,
          missingLanguageIds,
          errorCode: missingLanguageIds.length === 0 ? null : JUDGE0_ERROR_CODES.CONFIG_ERROR
        };
      } catch (err) {
        return {
          available: false,
          authenticated: isJudge0Error(err) ? err.code !== JUDGE0_ERROR_CODES.AUTH_FAILED : false,
          version: null,
          latencyMs: nowFn() - startedAt,
          languageChecks: {},
          missingLanguageIds: [],
          errorCode: isJudge0Error(err) ? err.code : JUDGE0_ERROR_CODES.INTERNAL_ERROR,
          errorMessage: err?.message ?? 'Judge0 availability check failed'
        };
      }
    }
  };
}
