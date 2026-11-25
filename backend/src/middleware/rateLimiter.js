import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

function buildRateLimitHandler(message) {
  return (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message,
        requestId: req.id
      }
    });
  };
}

/**
 * Create authentication rate limiters calibrated for ~100 concurrent users
 * potentially sharing one or two college NAT IP addresses.
 * Normal session restoration endpoints (/api/auth/me, /api/auth/session) are not rate-limited.
 */
export function createAuthRateLimiters({
  oauthWindowMs = 15 * 60 * 1000,
  oauthMax = 300,
  mutationWindowMs = 15 * 60 * 1000,
  mutationMax = 300
} = {}) {
  const authOAuthLimiter = rateLimit({
    windowMs: oauthWindowMs,
    limit: oauthMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip || '127.0.0.1'),
    handler: buildRateLimitHandler(
      'Too many authentication attempts, please wait a moment and try again'
    )
  });

  const authMutationLimiter = rateLimit({
    windowMs: mutationWindowMs,
    limit: mutationMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) =>
      req.session?.auth?.userId
        ? `user:${req.session.auth.userId}`
        : ipKeyGenerator(req.ip || '127.0.0.1'),
    handler: buildRateLimitHandler(
      'Too many authentication requests, please wait a moment and try again'
    )
  });

  return {
    authOAuthLimiter,
    authMutationLimiter
  };
}
