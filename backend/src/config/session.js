import MongoStore from 'connect-mongo';
import session from 'express-session';
import mongoose from 'mongoose';
import { isDatabaseInfrastructureError } from './database.js';
import { AppError } from '../utils/AppError.js';

export const SESSION_COOKIE_NAME = 'c2c.sid';
export const SESSION_COLLECTION_NAME = 'sessions';

/**
 * Create a persistent MongoDB-backed express-session store.
 */
export function createMongoSessionStore({
  mongoUrl,
  client,
  clientPromise,
  ttlSeconds,
  collectionName = SESSION_COLLECTION_NAME
} = {}) {
  if (!client && !clientPromise && !mongoUrl) {
    throw new Error('MongoDB client or mongoUrl is required to create session store');
  }

  const options = {
    collectionName,
    ttl: ttlSeconds,
    autoRemove: 'native',
    touchAfter: 0
  };

  if (client) {
    options.client = client;
  } else if (clientPromise) {
    options.clientPromise = clientPromise;
  } else {
    options.mongoUrl = mongoUrl;
  }

  return MongoStore.create(options);
}

/**
 * Resolve a safe cookie configuration matching environment rules.
 */
export function getSessionCookieOptions({ env, maxAge } = {}) {
  const isProduction = env?.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAge ?? env?.SESSION_MAX_AGE_MS
  };
}

/**
 * Create express-session middleware configured with MongoStore and infrastructure outage safety.
 */
export function createSessionMiddleware({ env, store, database } = {}) {
  if (!store) {
    throw new Error('A persistent session store is required (MemoryStore is disallowed)');
  }

  const isProduction = env.NODE_ENV === 'production';

  const rawSessionMiddleware = session({
    name: SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    proxy: isProduction,
    cookie: getSessionCookieOptions({ env })
  });

  return function sessionMiddleware(req, res, next) {
    if (database && typeof database.isReady === 'function' && !database.isReady()) {
      return next(
        AppError.serviceUnavailable(
          'Authentication infrastructure temporarily unavailable',
          'AUTH_INFRASTRUCTURE_UNAVAILABLE'
        )
      );
    }

    rawSessionMiddleware(req, res, (err) => {
      if (err) {
        if (isDatabaseInfrastructureError(err) || err.code === 'ECONNREFUSED') {
          return next(
            AppError.serviceUnavailable(
              'Authentication infrastructure temporarily unavailable',
              'AUTH_INFRASTRUCTURE_UNAVAILABLE'
            )
          );
        }
        return next(err);
      }
      return next();
    });
  };
}

/**
 * Initialize minimal authentication and dual-expiration metadata on a newly regenerated session.
 */
export function attachAuthenticatedSession(
  req,
  { userId, nowMs = Date.now(), maxAgeMs, idleTimeoutMs }
) {
  req.session.auth = {
    userId,
    authenticatedAt: nowMs,
    absoluteExpiresAt: nowMs + maxAgeMs,
    lastActivityAt: nowMs,
    idleExpiresAt: nowMs + Math.min(idleTimeoutMs, maxAgeMs)
  };
}

/**
 * Clear the session cookie using matching security attributes.
 */
export function clearSessionCookie(res, env) {
  const cookieOpts = getSessionCookieOptions({ env });
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: cookieOpts.httpOnly,
    secure: cookieOpts.secure,
    sameSite: cookieOpts.sameSite,
    path: cookieOpts.path
  });
}

/**
 * Create a MongoStore bound to the active Mongoose MongoClient when connected.
 */
export function createDefaultMongoStore(env) {
  const ttlSeconds = Math.ceil(env.SESSION_MAX_AGE_MS / 1000);
  if (mongoose.connection.readyState === 1) {
    return createMongoSessionStore({
      client: mongoose.connection.getClient(),
      ttlSeconds
    });
  }

  return createMongoSessionStore({
    mongoUrl: env.MONGODB_URI,
    ttlSeconds
  });
}
