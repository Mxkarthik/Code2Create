import { isDatabaseInfrastructureError } from '../config/database.js';
import { clearSessionCookie } from '../config/session.js';
import { defaultUserService } from '../modules/users/user.service.js';
import { AppError } from '../utils/AppError.js';

function destroySessionQuietly(req, res, env) {
  return new Promise((resolve) => {
    clearSessionCookie(res, env);
    if (!req.session || typeof req.session.destroy !== 'function') {
      resolve();
      return;
    }
    req.session.destroy(() => resolve());
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Create authentication and passive session-status middleware backed by MongoDB.
 */
export function createAuthMiddleware({
  env,
  database,
  userService = defaultUserService,
  nowFn = () => Date.now()
}) {
  const touchIntervalMs = Math.max(
    1,
    Math.min(60000, Math.floor(env.SESSION_IDLE_TIMEOUT_MS / 4))
  );

  async function requireAuth(req, res, next) {
    try {
      if (database && typeof database.isReady === 'function' && !database.isReady()) {
        return next(
          AppError.serviceUnavailable(
            'Authentication infrastructure temporarily unavailable',
            'AUTH_INFRASTRUCTURE_UNAVAILABLE'
          )
        );
      }

      const auth = req.session?.auth;
      if (!auth || !auth.userId) {
        return next(AppError.unauthorized('Authentication required', 'UNAUTHENTICATED'));
      }

      const nowMs = nowFn();
      if (nowMs >= auth.absoluteExpiresAt || nowMs >= auth.idleExpiresAt) {
        await destroySessionQuietly(req, res, env);
        return next(AppError.unauthorized('Session has expired', 'SESSION_EXPIRED'));
      }

      let user;
      try {
        user = await userService.getUserById(auth.userId);
      } catch (err) {
        if (isDatabaseInfrastructureError(err)) {
          return next(
            AppError.serviceUnavailable(
              'Authentication infrastructure temporarily unavailable',
              'AUTH_INFRASTRUCTURE_UNAVAILABLE'
            )
          );
        }
        throw err;
      }

      if (!user) {
        await destroySessionQuietly(req, res, env);
        return next(AppError.unauthorized('Invalid session', 'SESSION_INVALID'));
      }

      if (!user.isActive) {
        return next(AppError.forbidden('Your account has been disabled', 'ACCOUNT_DISABLED'));
      }

      if (nowMs - auth.lastActivityAt >= touchIntervalMs) {
        auth.lastActivityAt = nowMs;
        auth.idleExpiresAt = Math.min(
          nowMs + env.SESSION_IDLE_TIMEOUT_MS,
          auth.absoluteExpiresAt
        );
        try {
          await saveSession(req);
        } catch (err) {
          if (isDatabaseInfrastructureError(err)) {
            return next(
              AppError.serviceUnavailable(
                'Authentication infrastructure temporarily unavailable',
                'AUTH_INFRASTRUCTURE_UNAVAILABLE'
              )
            );
          }
          throw err;
        }
      }

      req.user = user;
      req.authSession = { ...auth };
      return next();
    } catch (err) {
      return next(err);
    }
  }

  async function resolveSessionStatus(req, res, next) {
    try {
      if (database && typeof database.isReady === 'function' && !database.isReady()) {
        return next(
          AppError.serviceUnavailable(
            'Authentication infrastructure temporarily unavailable',
            'AUTH_INFRASTRUCTURE_UNAVAILABLE'
          )
        );
      }

      const nowMs = nowFn();
      const serverTime = new Date(nowMs).toISOString();
      const auth = req.session?.auth;

      if (!auth || !auth.userId) {
        req.sessionStatus = {
          authenticated: false,
          absoluteExpiresAt: null,
          idleExpiresAt: null,
          serverTime
        };
        return next();
      }

      if (nowMs >= auth.absoluteExpiresAt || nowMs >= auth.idleExpiresAt) {
        await destroySessionQuietly(req, res, env);
        req.sessionStatus = {
          authenticated: false,
          absoluteExpiresAt: null,
          idleExpiresAt: null,
          serverTime
        };
        return next();
      }

      let user;
      try {
        user = await userService.getUserById(auth.userId);
      } catch (err) {
        if (isDatabaseInfrastructureError(err)) {
          return next(
            AppError.serviceUnavailable(
              'Authentication infrastructure temporarily unavailable',
              'AUTH_INFRASTRUCTURE_UNAVAILABLE'
            )
          );
        }
        throw err;
      }

      if (!user || !user.isActive) {
        req.sessionStatus = {
          authenticated: false,
          absoluteExpiresAt: null,
          idleExpiresAt: null,
          serverTime
        };
        return next();
      }

      req.sessionStatus = {
        authenticated: true,
        absoluteExpiresAt: new Date(auth.absoluteExpiresAt).toISOString(),
        idleExpiresAt: new Date(auth.idleExpiresAt).toISOString(),
        serverTime
      };
      return next();
    } catch (err) {
      return next(err);
    }
  }

  return {
    requireAuth,
    resolveSessionStatus
  };
}
