/**
 * Operational application error with HTTP status code and machine-readable error code.
 */
export class AppError extends Error {
  constructor(
    message,
    { statusCode = 500, code = 'INTERNAL_SERVER_ERROR', isOperational = true, details } = {}
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Bad request', code = 'BAD_REQUEST', details) {
    return new AppError(message, { statusCode: 400, code, details });
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppError(message, { statusCode: 401, code });
  }

  static forbidden(message = 'Access denied', code = 'FORBIDDEN') {
    return new AppError(message, { statusCode: 403, code });
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new AppError(message, { statusCode: 404, code });
  }

  static serviceUnavailable(
    message = 'Service temporarily unavailable',
    code = 'SERVICE_UNAVAILABLE'
  ) {
    return new AppError(message, { statusCode: 503, code });
  }
}
