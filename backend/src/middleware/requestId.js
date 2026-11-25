import crypto from 'node:crypto';

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Assign a correlation ID to each incoming request and expose it on X-Request-Id.
 */
export function requestIdMiddleware(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const incomingValue = Array.isArray(incoming) ? incoming[0] : incoming;

  const requestId =
    typeof incomingValue === 'string' && SAFE_REQUEST_ID_PATTERN.test(incomingValue.trim())
      ? incomingValue.trim()
      : crypto.randomUUID();

  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
