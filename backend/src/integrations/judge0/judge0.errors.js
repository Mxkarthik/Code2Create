export const JUDGE0_ERROR_CODES = Object.freeze({
  CONFIG_ERROR: 'JUDGE0_CONFIG_ERROR',
  AUTH_FAILED: 'JUDGE0_AUTH_FAILED',
  UNREACHABLE: 'JUDGE0_UNREACHABLE',
  QUEUE_SATURATED: 'JUDGE0_QUEUE_SATURATED',
  INVALID_REQUEST: 'JUDGE0_INVALID_REQUEST',
  INVALID_RESPONSE: 'JUDGE0_INVALID_RESPONSE',
  REDIRECT_REJECTED: 'JUDGE0_REDIRECT_REJECTED',
  TIMEOUT: 'JUDGE0_TIMEOUT',
  SUBMISSION_ADMISSION_UNCERTAIN: 'JUDGE0_SUBMISSION_ADMISSION_UNCERTAIN',
  POLL_TIMEOUT: 'JUDGE0_POLL_TIMEOUT',
  INTERNAL_ERROR: 'JUDGE0_INTERNAL_ERROR'
});

/**
 * Typed error representing Judge0 integration, transport, or admission-uncertainty failures.
 * Never embeds auth tokens, source code, or hidden test data in messages or properties.
 */
export class Judge0Error extends Error {
  constructor(
    message,
    {
      code = JUDGE0_ERROR_CODES.INTERNAL_ERROR,
      statusCode = 503,
      httpStatus = null,
      admissionUncertain = false,
      isRetryable = false,
      isInfrastructureError = true,
      judge0Token = null,
      details = null,
      cause = null
    } = {}
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'Judge0Error';
    this.code = code;
    this.statusCode = statusCode;
    this.httpStatus = httpStatus;
    this.admissionUncertain = Boolean(admissionUncertain);
    this.isRetryable = Boolean(isRetryable);
    this.isInfrastructureError = Boolean(isInfrastructureError);
    this.judge0Token = judge0Token;
    this.details = details;
  }
}

export function isJudge0Error(err) {
  return err instanceof Judge0Error || (err?.name === 'Judge0Error' && Boolean(err?.code));
}
