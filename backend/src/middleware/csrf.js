import crypto from 'node:crypto';
import { AppError } from '../utils/AppError.js';

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeOrigin(origin) {
  if (typeof origin !== 'string') {
    return '';
  }
  return origin.trim().replace(/\/+$/, '');
}

function extractOriginFromReferer(referer) {
  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

function timingSafeTokenEqual(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Issue or retrieve a cryptographically random CSRF token bound to the active session.
 */
export async function issueCsrfToken(req) {
  if (!req.session || !req.session.auth?.userId) {
    throw AppError.unauthorized('Authentication required', 'UNAUTHENTICATED');
  }

  if (typeof req.session.csrfToken === 'string' && req.session.csrfToken.length >= 32) {
    return req.session.csrfToken;
  }

  const token = crypto.randomBytes(32).toString('hex');
  req.session.csrfToken = token;

  await new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

  return token;
}

/**
 * Protect cookie-authenticated state-changing endpoints against CSRF by validating
 * both request origin/referer headers and a session-bound CSRF token.
 */
export function createCsrfMiddleware({ env }) {
  const allowedOrigins = new Set(
    (env.CORS_ORIGINS ?? [env.PARTICIPANT_FRONTEND_URL, env.ADMIN_FRONTEND_URL])
      .map(normalizeOrigin)
      .filter(Boolean)
  );

  return function csrfProtection(req, _res, next) {
    if (SAFE_HTTP_METHODS.has(req.method)) {
      return next();
    }

    const secFetchSite = req.get('sec-fetch-site');
    if (secFetchSite && secFetchSite.toLowerCase() === 'cross-site') {
      return next(
        AppError.forbidden('Cross-site mutation rejected by CSRF policy', 'CSRF_UNTRUSTED_ORIGIN')
      );
    }

    const host = req.get('host');
    const selfOrigin = host ? normalizeOrigin(`${req.protocol}://${host}`) : '';

    const originHeader = normalizeOrigin(req.get('origin'));
    if (originHeader) {
      const isTrustedOrigin =
        allowedOrigins.has(originHeader) || (selfOrigin && originHeader === selfOrigin);
      if (!isTrustedOrigin) {
        return next(
          AppError.forbidden('Origin not permitted by CSRF policy', 'CSRF_UNTRUSTED_ORIGIN')
        );
      }
    } else {
      const refererHeader = req.get('referer');
      if (refererHeader) {
        const refererOrigin = normalizeOrigin(extractOriginFromReferer(refererHeader));
        const isTrustedReferer =
          refererOrigin &&
          (allowedOrigins.has(refererOrigin) || (selfOrigin && refererOrigin === selfOrigin));
        if (!isTrustedReferer) {
          return next(
            AppError.forbidden('Referer not permitted by CSRF policy', 'CSRF_UNTRUSTED_ORIGIN')
          );
        }
      }
    }

    const expectedToken = req.session?.csrfToken;
    const providedToken = req.get('x-csrf-token') ?? req.body?._csrf;

    if (!providedToken || typeof providedToken !== 'string') {
      return next(AppError.forbidden('Missing CSRF token', 'CSRF_TOKEN_MISSING'));
    }

    if (!timingSafeTokenEqual(expectedToken, providedToken.trim())) {
      return next(AppError.forbidden('Invalid CSRF token', 'CSRF_TOKEN_INVALID'));
    }

    return next();
  };
}
