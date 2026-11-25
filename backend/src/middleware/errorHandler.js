import { isDatabaseInfrastructureError } from '../config/database.js';
import { AppError } from '../utils/AppError.js';
import { LOG_FORMATS } from '../utils/logger.js';

const SILENCED_MINIMAL_4XX_CODES = new Set([
  'ROUTE_NOT_FOUND',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'SESSION_INVALID',
  'INVALID_JSON'
]);

function isMalformedJsonError(err) {
  return (
    err instanceof SyntaxError &&
    err.status === 400 &&
    ('body' in err || err.type === 'entity.parse.failed')
  );
}

function isPayloadTooLargeError(err) {
  return err?.type === 'entity.too.large' || err?.status === 413;
}

function isClientAbortError(err) {
  return Boolean(
    err?.type === 'request.aborted' ||
      err?.code === 'ECONNRESET' ||
      err?.code === 'ECONNABORTED'
  );
}

/**
 * Centralized Express error-handling middleware with production error sanitization,
 * minimal-mode noise suppression, and duplicate-log prevention.
 */
export function createErrorHandler({
  nodeEnv = 'development',
  logFormat,
  logger
} = {}) {
  const isProduction = nodeEnv === 'production';
  const effectiveFormat =
    logFormat ?? logger?.format ?? (isProduction ? LOG_FORMATS.JSON : LOG_FORMATS.MINIMAL);

  return function errorHandler(err, req, res, _next) {
    let normalizedError = err;

    if (isMalformedJsonError(err)) {
      normalizedError = AppError.badRequest(
        'Malformed JSON request body',
        'INVALID_JSON'
      );
    } else if (isPayloadTooLargeError(err)) {
      normalizedError = new AppError('Request payload exceeds allowed limit', {
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE'
      });
    } else if (!(err instanceof AppError) && isDatabaseInfrastructureError(err)) {
      normalizedError = AppError.serviceUnavailable(
        'Database or session infrastructure temporarily unavailable',
        'AUTH_INFRASTRUCTURE_UNAVAILABLE'
      );
    } else if (!(err instanceof AppError)) {
      const statusCode =
        Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 600
          ? err.statusCode
          : 500;
      normalizedError = new AppError(
        statusCode >= 500 ? 'Internal server error' : err?.message || 'Request failed',
        {
          statusCode,
          code: statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR',
          isOperational: false
        }
      );
    }

    // Mark handled so pino-http does not log the same error twice.
    res.locals.errorLoggedByHandler = true;

    const requestLogger = req.log ?? logger;
    const shouldSuppressMinimal =
      effectiveFormat === LOG_FORMATS.MINIMAL &&
      normalizedError.statusCode < 500 &&
      SILENCED_MINIMAL_4XX_CODES.has(normalizedError.code);

    if (requestLogger && !isClientAbortError(err) && !shouldSuppressMinimal) {
      if (effectiveFormat === LOG_FORMATS.MINIMAL) {
        if (normalizedError.statusCode >= 500) {
          requestLogger.error(
            {
              requestId: req.id,
              statusCode: normalizedError.statusCode,
              errorCode: normalizedError.code,
              errorMessage: err?.message
            },
            `${req.method} ${req.path} failed (${normalizedError.statusCode})`
          );
        } else {
          requestLogger.warn(
            `${req.method} ${req.path} rejected (${normalizedError.statusCode} ${normalizedError.code})`
          );
        }
      } else {
        const logPayload = {
          requestId: req.id,
          statusCode: normalizedError.statusCode,
          errorCode: normalizedError.code,
          path: req.path,
          method: req.method
        };

        if (normalizedError.statusCode >= 500) {
          requestLogger.error({ ...logPayload, err }, 'Unhandled server error');
        } else {
          requestLogger.warn(logPayload, normalizedError.message);
        }
      }
    }

    const exposeMessage =
      !isProduction || normalizedError.isOperational || normalizedError.statusCode < 500;

    const responseBody = {
      success: false,
      error: {
        code: normalizedError.code,
        message: exposeMessage ? normalizedError.message : 'Internal server error',
        requestId: req.id
      }
    };

    if (!isProduction && normalizedError.isOperational && normalizedError.details !== undefined) {
      responseBody.error.details = normalizedError.details;
    }

    res.status(normalizedError.statusCode).json(responseBody);
  };
}
