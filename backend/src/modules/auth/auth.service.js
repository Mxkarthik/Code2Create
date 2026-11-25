import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';

export const PORTAL_DESTINATIONS = Object.freeze({
  PARTICIPANT: 'participant',
  ADMIN: 'admin',
  DEV: 'dev'
});

const oauthTransactionSchema = new mongoose.Schema(
  {
    handleHash: {
      type: String,
      required: true,
      unique: true
    },
    sessionId: {
      type: String,
      required: true
    },
    portal: {
      type: String,
      enum: Object.values(PORTAL_DESTINATIONS),
      required: true
    },
    codeVerifier: {
      type: String,
      required: true
    },
    consumed: {
      type: Boolean,
      default: false,
      required: true
    },
    consumedAt: {
      type: Date,
      default: null
    },
    expiresAt: {
      type: Date,
      required: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

oauthTransactionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OAuthTransaction =
  mongoose.models.OAuthTransaction ||
  mongoose.model('OAuthTransaction', oauthTransactionSchema, 'oauth_transactions');

function hashStateHandle(handle) {
  return crypto.createHash('sha256').update(handle).digest('hex');
}

function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Resolve and validate the post-login redirect URL from a predefined portal key.
 * Prevents open redirects by ignoring arbitrary URLs.
 */
export function resolvePortalRedirectUrl(portal, env) {
  switch (portal) {
    case PORTAL_DESTINATIONS.ADMIN:
      return env.ADMIN_FRONTEND_URL;
    case PORTAL_DESTINATIONS.DEV:
      if (env.NODE_ENV !== 'development') {
        throw AppError.badRequest(
          'Development login destination is disabled outside development',
          'INVALID_PORTAL_DESTINATION'
        );
      }
      return '/api/auth/me';
    case PORTAL_DESTINATIONS.PARTICIPANT:
    default:
      return env.PARTICIPANT_FRONTEND_URL;
  }
}

/**
 * Resolve trusted failure redirect target for frontend portals when consent is cancelled.
 */
export function resolvePortalFailureRedirectUrl(portal, env, errorCode) {
  if (portal === PORTAL_DESTINATIONS.ADMIN) {
    return `${env.ADMIN_FRONTEND_URL}?authError=${encodeURIComponent(errorCode)}`;
  }
  if (portal === PORTAL_DESTINATIONS.PARTICIPANT) {
    return `${env.PARTICIPANT_FRONTEND_URL}?authError=${encodeURIComponent(errorCode)}`;
  }
  return null;
}

/**
 * Create a Passport OAuth2 state store with:
 * - 256-bit cryptographically random state handle
 * - Session binding + explicit session.save() before redirect
 * - Configurable TTL (default 10 minutes)
 * - Atomic one-time consumption preventing concurrent callback replay
 */
export function createOAuthStateStore({
  oauthStateTtlMs = 600000,
  nowFn = () => Date.now(),
  useDatabase = 'auto'
} = {}) {
  const memoryTransactions = new Map();

  function shouldUseMongo() {
    if (useDatabase === true) {
      return true;
    }
    if (useDatabase === false) {
      return false;
    }
    return mongoose.connection.readyState === 1;
  }

  return {
    store(req, verifier, stateMeta, _meta, callback) {
      if (!req.session) {
        return callback(new Error('OAuth state store requires active session middleware'));
      }

      const handle = crypto.randomBytes(32).toString('base64url');
      const handleHash = hashStateHandle(handle);
      const nowMs = nowFn();
      const expiresAtMs = nowMs + oauthStateTtlMs;
      const portal = stateMeta?.portal ?? PORTAL_DESTINATIONS.PARTICIPANT;

      req.session.oauthTx = {
        handleHash,
        portal,
        expiresAt: expiresAtMs
      };

      const persistRecord = async () => {
        if (shouldUseMongo()) {
          await OAuthTransaction.create({
            handleHash,
            sessionId: req.sessionID,
            portal,
            codeVerifier: verifier || '',
            consumed: false,
            expiresAt: new Date(expiresAtMs)
          });
        } else {
          memoryTransactions.set(handleHash, {
            handleHash,
            sessionId: req.sessionID,
            portal,
            codeVerifier: verifier || '',
            consumed: false,
            expiresAt: expiresAtMs
          });
        }
      };

      persistRecord()
        .then(() => {
          req.session.save((saveErr) => {
            if (saveErr) {
              return callback(saveErr);
            }
            return callback(null, handle);
          });
        })
        .catch((err) => callback(err));
    },

    verify(req, providedState, callback) {
      if (!req.session) {
        return callback(new Error('OAuth state verification requires active session middleware'));
      }

      if (typeof providedState !== 'string' || providedState.trim().length === 0) {
        return callback(null, false, {
          code: 'MISSING_OAUTH_STATE',
          message: 'Missing OAuth state parameter'
        });
      }

      const providedHash = hashStateHandle(providedState.trim());
      const sessionTx = req.session.oauthTx;

      if (!sessionTx || !timingSafeHexEqual(providedHash, sessionTx.handleHash)) {
        return callback(null, false, {
          code: 'INVALID_OAUTH_STATE',
          message: 'Invalid OAuth state parameter'
        });
      }

      const nowMs = nowFn();
      if (nowMs >= sessionTx.expiresAt) {
        delete req.session.oauthTx;
        return req.session.save(() =>
          callback(null, false, {
            code: 'EXPIRED_OAUTH_STATE',
            message: 'OAuth transaction has expired'
          })
        );
      }

      const consumeRecord = async () => {
        if (shouldUseMongo()) {
          return OAuthTransaction.findOneAndUpdate(
            {
              handleHash: providedHash,
              sessionId: req.sessionID,
              consumed: false,
              expiresAt: { $gt: new Date(nowMs) }
            },
            {
              $set: {
                consumed: true,
                consumedAt: new Date(nowMs)
              }
            },
            { returnDocument: 'after' }
          ).lean();
        }

        const record = memoryTransactions.get(providedHash);
        if (
          !record ||
          record.sessionId !== req.sessionID ||
          record.consumed ||
          nowMs >= record.expiresAt
        ) {
          return null;
        }
        record.consumed = true;
        record.consumedAt = nowMs;
        return record;
      };

      consumeRecord()
        .then((record) => {
          delete req.session.oauthTx;

          if (!record) {
            return req.session.save(() =>
              callback(null, false, {
                code: 'REPLAYED_OAUTH_STATE',
                message: 'OAuth state has already been consumed or expired'
              })
            );
          }

          return req.session.save((saveErr) => {
            if (saveErr) {
              return callback(saveErr);
            }
            return callback(null, record.codeVerifier || true, {
              portal: record.portal
            });
          });
        })
        .catch((err) => callback(err));
    }
  };
}
