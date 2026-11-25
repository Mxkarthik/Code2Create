import { AppError } from '../utils/AppError.js';

/**
 * Forward unmatched routes to the centralized error handler.
 */
export function notFoundMiddleware(req, _res, next) {
  next(
    AppError.notFound(
      `Route not found: ${req.method} ${req.path}`,
      'ROUTE_NOT_FOUND'
    )
  );
}
