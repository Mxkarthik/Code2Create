import crypto from 'node:crypto';
import {
  attachAuthenticatedSession,
  clearSessionCookie
} from '../../config/session.js';
import { issueCsrfToken } from '../../middleware/csrf.js';
import { AppError } from '../../utils/AppError.js';
import { defaultUserService } from '../users/user.service.js';
import { getUserTeamSummary } from '../teams/team.service.js';
import {
  PORTAL_DESTINATIONS,
  resolvePortalFailureRedirectUrl,
  resolvePortalRedirectUrl
} from './auth.service.js';
import { validateOAuthPortalQuery } from './auth.validation.js';

const STATE_ERROR_CODES = new Map([
  ['MISSING_OAUTH_STATE', 400],
  ['INVALID_OAUTH_STATE', 403],
  ['EXPIRED_OAUTH_STATE', 403],
  ['REPLAYED_OAUTH_STATE', 403]
]);

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
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

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Create controllers for Google OAuth, session inspection, CSRF token issuance, and logout.
 */
export function createAuthController({
  env,
  authenticator,
  userService = defaultUserService,
  logger,
  competitionSlug,
  nowFn = () => Date.now()
}) {
  function initiateGoogleOAuth(req, res, next) {
    try {
      const portal = validateOAuthPortalQuery(req.query, env);
      return authenticator.authenticate('google', {
        session: false,
        state: { portal }
      })(req, res, next);
    } catch (err) {
      return next(err);
    }
  }

  async function handleGoogleCallback(req, res, next) {
    if (req.query?.error) {
      const portal = req.session?.oauthTx?.portal;
      if (req.session?.oauthTx) {
        delete req.session.oauthTx;
        await saveSession(req).catch(() => {});
      }

      const errorCode =
        req.query.error === 'access_denied'
          ? 'OAUTH_CONSENT_CANCELLED'
          : 'OAUTH_AUTHORIZATION_ERROR';

      const failureRedirect = resolvePortalFailureRedirectUrl(portal, env, errorCode);
      if (failureRedirect) {
        return res.redirect(302, failureRedirect);
      }

      return next(
        AppError.unauthorized('Google authentication was cancelled or denied', errorCode)
      );
    }

    authenticator.authenticate('google', { session: false }, async (err, user, info) => {
      if (err) {
        if (err instanceof AppError) {
          return next(err);
        }
        return next(
          AppError.unauthorized(
            'Google authentication could not be completed',
            'OAUTH_EXCHANGE_FAILED'
          )
        );
      }

      if (!user) {
        const infoCode = info?.code;
        if (infoCode && STATE_ERROR_CODES.has(infoCode)) {
          return next(
            new AppError(info.message || 'Invalid OAuth state', {
              statusCode: STATE_ERROR_CODES.get(infoCode),
              code: infoCode
            })
          );
        }

        if (infoCode === 'ACCOUNT_DISABLED') {
          return next(AppError.forbidden(info.message || 'Account is disabled', infoCode));
        }

        if (infoCode === 'UNVERIFIED_GOOGLE_EMAIL' || infoCode === 'INVALID_GOOGLE_IDENTITY') {
          return next(AppError.unauthorized(info.message, infoCode));
        }

        return next(
          AppError.unauthorized(
            info?.message || 'Google authentication failed',
            infoCode || 'OAUTH_FAILED'
          )
        );
      }

      try {
        const portal = info?.state?.portal ?? PORTAL_DESTINATIONS.PARTICIPANT;
        const redirectUrl = resolvePortalRedirectUrl(portal, env);

        await regenerateSession(req);
        const nowMs = nowFn();
        attachAuthenticatedSession(req, {
          userId: user._id.toString(),
          nowMs,
          maxAgeMs: env.SESSION_MAX_AGE_MS,
          idleTimeoutMs: env.SESSION_IDLE_TIMEOUT_MS
        });
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        await saveSession(req);

        (req.log ?? logger)?.info(
          { userId: user._id.toString(), role: user.role, portal },
          `User authenticated via Google OAuth (${user.role})`
        );

        return res.redirect(302, redirectUrl);
      } catch (sessionErr) {
        return next(sessionErr);
      }
    })(req, res, next);
  }

  async function getCurrentUser(req, res, next) {
    try {
      const teamSummary = await getUserTeamSummary(req.user?._id, { competitionSlug });
      const publicUser = userService.toPublicUser(req.user);

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        user: {
          ...publicUser,
          teamId: teamSummary.teamId,
          teamRole: teamSummary.teamRole
        },
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  function getSessionStatus(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      success: true,
      ...req.sessionStatus,
      requestId: req.id
    });
  }

  async function getCsrfToken(req, res, next) {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const csrfToken = await issueCsrfToken(req);
      res.status(200).json({
        success: true,
        csrfToken,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function logout(req, res, next) {
    try {
      const userId = req.user?._id?.toString();
      await destroySession(req);
      clearSessionCookie(res, env);
      (req.log ?? logger)?.info({ userId }, 'User logged out');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        message: 'Logged out successfully',
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    initiateGoogleOAuth,
    handleGoogleCallback,
    getCurrentUser,
    getSessionStatus,
    getCsrfToken,
    logout
  };
}
