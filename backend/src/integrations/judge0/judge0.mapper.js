import { EXECUTION_POLICY } from '../../modules/problems/language.config.js';
import { JUDGE0_ERROR_CODES, Judge0Error } from './judge0.errors.js';

export const EXECUTION_STATUSES = Object.freeze({
  IN_QUEUE: 'IN_QUEUE',
  PROCESSING: 'PROCESSING',
  EXECUTED: 'EXECUTED',
  ACCEPTED: 'ACCEPTED',
  WRONG_ANSWER: 'WRONG_ANSWER',
  TIME_LIMIT_EXCEEDED: 'TIME_LIMIT_EXCEEDED',
  COMPILATION_ERROR: 'COMPILATION_ERROR',
  RUNTIME_ERROR: 'RUNTIME_ERROR',
  OUTPUT_LIMIT_EXCEEDED: 'OUTPUT_LIMIT_EXCEEDED',
  INFRASTRUCTURE_ERROR: 'INFRASTRUCTURE_ERROR',
  UNKNOWN_STATUS: 'UNKNOWN_STATUS'
});

export const JUDGE0_STATUS_IDS = Object.freeze({
  IN_QUEUE: 1,
  PROCESSING: 2,
  ACCEPTED_EXECUTION: 3,
  WRONG_ANSWER: 4,
  TIME_LIMIT_EXCEEDED: 5,
  COMPILATION_ERROR: 6,
  RUNTIME_ERROR_SIGSEGV: 7,
  RUNTIME_ERROR_SIGXFSZ: 8,
  RUNTIME_ERROR_SIGFPE: 9,
  RUNTIME_ERROR_SIGABRT: 10,
  RUNTIME_ERROR_NZEC: 11,
  RUNTIME_ERROR_OTHER: 12,
  INTERNAL_ERROR: 13,
  EXEC_FORMAT_ERROR: 14
});

const RUNTIME_SIGNAL_MAP = Object.freeze({
  7: 'SIGSEGV',
  8: 'SIGXFSZ',
  9: 'SIGFPE',
  10: 'SIGABRT',
  11: 'NZEC',
  12: 'OTHER'
});

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
const replacementUtf8Decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Safely decode a Base64 Judge0 output field with strict byte limits and UTF-8 handling.
 */
export function decodeBase64Field(
  rawValue,
  { maxBytes = EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES } = {}
) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return {
      text: '',
      rawBytes: 0,
      capturedBytes: 0,
      truncated: false,
      nonUtf8Detected: false,
      invalidBase64: false
    };
  }

  if (typeof rawValue !== 'string') {
    return {
      text: '',
      rawBytes: 0,
      capturedBytes: 0,
      truncated: false,
      nonUtf8Detected: false,
      invalidBase64: true
    };
  }

  const compact = rawValue.replace(/[\r\n\s]+/g, '');
  if (compact.length === 0) {
    return {
      text: '',
      rawBytes: 0,
      capturedBytes: 0,
      truncated: false,
      nonUtf8Detected: false,
      invalidBase64: false
    };
  }

  if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    return {
      text: '',
      rawBytes: 0,
      capturedBytes: 0,
      truncated: false,
      nonUtf8Detected: false,
      invalidBase64: true
    };
  }

  const paddingNeeded = (4 - (compact.length % 4)) % 4;
  const padded = compact + '='.repeat(paddingNeeded);
  const fullBuffer = Buffer.from(padded, 'base64');

  // Verify round-trip canonical encoding length when padded strictly
  const truncated = fullBuffer.length > maxBytes;
  const boundedBuffer = truncated ? fullBuffer.subarray(0, maxBytes) : fullBuffer;

  let text = '';
  let nonUtf8Detected = false;

  try {
    text = fatalUtf8Decoder.decode(boundedBuffer);
  } catch {
    nonUtf8Detected = true;
    text = replacementUtf8Decoder.decode(boundedBuffer);
  }

  return {
    text,
    rawBytes: fullBuffer.length,
    capturedBytes: boundedBuffer.length,
    truncated,
    nonUtf8Detected,
    invalidBase64: false
  };
}

function parseNumericMetric(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Normalize a raw Judge0 submission result object into application-level execution fields.
 * Never treats Judge0 status ID 3 alone as problem acceptance without output comparison.
 */
export function mapExecutionResult(
  rawResult,
  { token = null, maxOutputBytes = EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES } = {}
) {
  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    throw new Judge0Error('Invalid Judge0 result payload shape', {
      code: JUDGE0_ERROR_CODES.INVALID_RESPONSE,
      statusCode: 502,
      judge0Token: token
    });
  }

  const resolvedToken =
    typeof rawResult.token === 'string' && rawResult.token.trim().length > 0
      ? rawResult.token.trim()
      : token;

  const statusObj = rawResult.status && typeof rawResult.status === 'object' ? rawResult.status : null;
  const rawStatusId = statusObj?.id ?? rawResult.status_id;
  const statusId = Number.isInteger(rawStatusId) ? rawStatusId : Number.NaN;
  const statusDescription =
    typeof statusObj?.description === 'string' ? statusObj.description : null;

  const stdout = decodeBase64Field(rawResult.stdout, { maxBytes: maxOutputBytes });
  const stderr = decodeBase64Field(rawResult.stderr, { maxBytes: maxOutputBytes });
  const compileOutput = decodeBase64Field(rawResult.compile_output, { maxBytes: maxOutputBytes });
  const message = decodeBase64Field(rawResult.message, { maxBytes: maxOutputBytes });

  const diagnosticLimitExceeded =
    stdout.truncated || stderr.truncated || compileOutput.truncated;

  let executionStatus;
  let isTerminal = true;
  let isExecutionSuccess = false;
  let isInfrastructureError = false;
  let runtimeErrorSignal = null;

  switch (statusId) {
    case JUDGE0_STATUS_IDS.IN_QUEUE:
      executionStatus = EXECUTION_STATUSES.IN_QUEUE;
      isTerminal = false;
      break;
    case JUDGE0_STATUS_IDS.PROCESSING:
      executionStatus = EXECUTION_STATUSES.PROCESSING;
      isTerminal = false;
      break;
    case JUDGE0_STATUS_IDS.ACCEPTED_EXECUTION:
      if (stdout.invalidBase64) {
        executionStatus = EXECUTION_STATUSES.INFRASTRUCTURE_ERROR;
        isInfrastructureError = true;
      } else if (stdout.truncated) {
        executionStatus = EXECUTION_STATUSES.OUTPUT_LIMIT_EXCEEDED;
      } else {
        executionStatus = EXECUTION_STATUSES.EXECUTED;
        isExecutionSuccess = true;
      }
      break;
    case JUDGE0_STATUS_IDS.WRONG_ANSWER:
      executionStatus = EXECUTION_STATUSES.WRONG_ANSWER;
      break;
    case JUDGE0_STATUS_IDS.TIME_LIMIT_EXCEEDED:
      executionStatus = EXECUTION_STATUSES.TIME_LIMIT_EXCEEDED;
      break;
    case JUDGE0_STATUS_IDS.COMPILATION_ERROR:
      executionStatus = EXECUTION_STATUSES.COMPILATION_ERROR;
      break;
    case JUDGE0_STATUS_IDS.RUNTIME_ERROR_SIGXFSZ:
      executionStatus = EXECUTION_STATUSES.OUTPUT_LIMIT_EXCEEDED;
      runtimeErrorSignal = RUNTIME_SIGNAL_MAP[statusId];
      break;
    case JUDGE0_STATUS_IDS.RUNTIME_ERROR_SIGSEGV:
    case JUDGE0_STATUS_IDS.RUNTIME_ERROR_SIGFPE:
    case JUDGE0_STATUS_IDS.RUNTIME_ERROR_SIGABRT:
    case JUDGE0_STATUS_IDS.RUNTIME_ERROR_NZEC:
    case JUDGE0_STATUS_IDS.RUNTIME_ERROR_OTHER:
      executionStatus = EXECUTION_STATUSES.RUNTIME_ERROR;
      runtimeErrorSignal = RUNTIME_SIGNAL_MAP[statusId];
      break;
    case JUDGE0_STATUS_IDS.INTERNAL_ERROR:
    case JUDGE0_STATUS_IDS.EXEC_FORMAT_ERROR:
      executionStatus = EXECUTION_STATUSES.INFRASTRUCTURE_ERROR;
      isInfrastructureError = true;
      break;
    default:
      executionStatus = Number.isInteger(statusId)
        ? EXECUTION_STATUSES.UNKNOWN_STATUS
        : EXECUTION_STATUSES.INFRASTRUCTURE_ERROR;
      isInfrastructureError = true;
      break;
  }

  return {
    token: resolvedToken,
    status: executionStatus,
    judge0StatusId: Number.isInteger(statusId) ? statusId : null,
    judge0StatusDescription: statusDescription,
    isTerminal,
    isExecutionSuccess,
    isInfrastructureError,
    runtimeErrorSignal,
    timeSeconds: parseNumericMetric(rawResult.time),
    wallTimeSeconds: parseNumericMetric(rawResult.wall_time),
    memoryKb: parseNumericMetric(rawResult.memory),
    exitCode: Number.isInteger(rawResult.exit_code) ? rawResult.exit_code : null,
    exitSignal: Number.isInteger(rawResult.exit_signal) ? rawResult.exit_signal : null,
    stdout: stdout.text,
    stderr: stderr.text,
    compileOutput: compileOutput.text,
    systemMessage: message.text,
    outputMetadata: {
      stdoutBytes: stdout.rawBytes,
      stderrBytes: stderr.rawBytes,
      compileOutputBytes: compileOutput.rawBytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      compileOutputTruncated: compileOutput.truncated,
      diagnosticLimitExceeded,
      nonUtf8Detected:
        stdout.nonUtf8Detected ||
        stderr.nonUtf8Detected ||
        compileOutput.nonUtf8Detected ||
        message.nonUtf8Detected,
      invalidBase64Detected:
        stdout.invalidBase64 ||
        stderr.invalidBase64 ||
        compileOutput.invalidBase64 ||
        message.invalidBase64
    }
  };
}
