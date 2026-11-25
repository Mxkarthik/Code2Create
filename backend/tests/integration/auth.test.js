import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { loadEnv } from '../../src/config/env.js';
import { createPassportAuthenticator } from '../../src/config/passport.js';
import {
  SESSION_COOKIE_NAME,
  createMongoSessionStore
} from '../../src/config/session.js';
import {
  requireActiveUser,
  requireAdmin,
  requireParticipantAccess
} from '../../src/middleware/authorize.js';
import {
  OAuthTransaction,
  createOAuthStateStore
} from '../../src/modules/auth/auth.service.js';
import { USER_ROLES, User } from '../../src/modules/users/user.model.js';
import { createLogger } from '../../src/utils/logger.js';

const env = loadEnv();
const logger = createLogger({ level: 'silent' });

function extractDbName(uri) {
  try {
    return new URL(uri).pathname.replace(/^\//, '') || 'test';
  } catch {
    return '';
  }
}

const isIsolatedTestDb =
  Boolean(env.MONGODB_TEST_URI) &&
  extractDbName(env.MONGODB_TEST_URI) === 'code2create_test' &&
  extractDbName(env.MONGODB_TEST_URI) !== extractDbName(env.MONGODB_URI);

function createTestHarness({
  nodeEnv = 'test',
  sessionMaxAgeMs = env.SESSION_MAX_AGE_MS,
  sessionIdleTimeoutMs = env.SESSION_IDLE_TIMEOUT_MS,
  databaseAdapter = { isReady: () => true },
  sessionStoreOverride,
  nowFn
} = {}) {
  let currentNow = nowFn ? nowFn() : Date.now();
  const clock = () => currentNow;

  const effectiveEnv = {
    ...env,
    NODE_ENV: nodeEnv,
    LOG_LEVEL: 'silent',
    SESSION_MAX_AGE_MS: sessionMaxAgeMs,
    SESSION_IDLE_TIMEOUT_MS: sessionIdleTimeoutMs,
    PARTICIPANT_FRONTEND_URL: 'http://localhost:5173',
    ADMIN_FRONTEND_URL: 'http://localhost:5174',
    CORS_ORIGINS: ['http://localhost:5173', 'http://localhost:5174']
  };

  const sessionStore =
    sessionStoreOverride ??
    createMongoSessionStore({
      client: mongoose.connection.getClient(),
      ttlSeconds: Math.ceil(sessionMaxAgeMs / 1000)
    });

  const oauthStateStore = createOAuthStateStore({
    oauthStateTtlMs: effectiveEnv.OAUTH_STATE_TTL_MS,
    nowFn: clock,
    useDatabase: true
  });

  const authenticator = createPassportAuthenticator({
    env: effectiveEnv,
    oauthStateStore
  });

  const googleStrategy = authenticator._strategy('google');
  let activeProfile = {
    provider: 'google',
    id: 'test-auth-sub-1',
    displayName: 'Auth Integration User',
    _json: {
      sub: 'test-auth-sub-1',
      email: 'auth.integration@example.com',
      email_verified: true,
      name: 'Auth Integration User',
      picture: 'https://example.com/avatar.png'
    }
  };

  vi.spyOn(googleStrategy._oauth2, 'getOAuthAccessToken').mockImplementation(
    (_code, _params, callback) => {
      callback(null, 'mock-access-token', 'mock-refresh-token', {});
    }
  );
  vi.spyOn(googleStrategy, 'userProfile').mockImplementation((_token, callback) => {
    callback(null, activeProfile);
  });

  const app = createApp({
    env: effectiveEnv,
    logger,
    database: databaseAdapter,
    sessionStore,
    oauthStateStore,
    authenticator,
    nowFn: clock,
    mountExtraRoutes: ({ app: targetApp, sessionMiddleware, authMiddleware }) => {
      const testRouter = express.Router();
      testRouter.use(sessionMiddleware);
      testRouter.get(
        '/participant-only',
        authMiddleware.requireAuth,
        requireActiveUser,
        requireParticipantAccess,
        (req, res) => {
          res.status(200).json({ success: true, role: req.user.role });
        }
      );
      testRouter.get(
        '/admin-only',
        authMiddleware.requireAuth,
        requireActiveUser,
        requireAdmin,
        (req, res) => {
          res.status(200).json({ success: true, role: req.user.role });
        }
      );
      targetApp.use('/api/test-rbac', testRouter);
    }
  });

  return {
    app,
    sessionStore,
    setProfile(profile) {
      activeProfile = profile;
    },
    advanceTime(ms) {
      currentNow += ms;
    }
  };
}

async function loginAgent(app, portal = 'participant') {
  const agent = request.agent(app);
  const initRes = await agent.get(`/api/auth/google?portal=${portal}`).expect(302);
  const state = new URL(initRes.headers.location).searchParams.get('state');
  const callbackRes = await agent
    .get(`/api/auth/google/callback?code=auth-code-123&state=${encodeURIComponent(state)}`)
    .expect(302);

  return { agent, initRes, callbackRes };
}

function extractSessionCookieValue(setCookieHeaders) {
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  const sidCookie = arr.find((c) => typeof c === 'string' && c.startsWith(`${SESSION_COOKIE_NAME}=`));
  return sidCookie ? sidCookie.split(';')[0] : null;
}

describe('Persistent MongoDB sessions, RBAC, and CSRF (real MongoDB integration)', () => {
  beforeAll(async () => {
    if (!isIsolatedTestDb) {
      throw new Error('MONGODB_TEST_URI pointing to code2create_test is required');
    }

    await connectDatabase(env.MONGODB_TEST_URI, {
      logger,
      dnsServers: env.MONGODB_DNS_SERVERS,
      allowDnsFallback: env.MONGODB_DNS_FALLBACK
    });
    await User.syncIndexes();
  });

  beforeEach(async () => {
    await User.deleteMany({ googleSub: /^test-auth-sub-/ });
    await OAuthTransaction.deleteMany({});
    await mongoose.connection.db.collection('sessions').deleteMany({});
  });

  afterAll(async () => {
    await User.deleteMany({ googleSub: /^test-auth-sub-/ });
    await OAuthTransaction.deleteMany({});
    await mongoose.connection.db.collection('sessions').deleteMany({});
    await disconnectDatabase({ logger });
  });

  it('persists session in MongoDB across repeated requests and app reconstruction, rotates session ID, and enforces cookie security', async () => {
    const harness1 = createTestHarness();
    const { agent, initRes, callbackRes } = await loginAgent(harness1.app);

    const preLoginCookie = extractSessionCookieValue(initRes.headers['set-cookie']);
    const postLoginCookie = extractSessionCookieValue(callbackRes.headers['set-cookie']);

    // Session identifier rotated on login
    expect(preLoginCookie).toBeTruthy();
    expect(postLoginCookie).toBeTruthy();
    expect(postLoginCookie).not.toBe(preLoginCookie);

    // Cookie security attributes (dev/test HTTP, HttpOnly, SameSite=Lax, Path=/, host-only)
    const rawCookieHeader = callbackRes.headers['set-cookie'].find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`)
    );
    expect(rawCookieHeader).toContain('HttpOnly');
    expect(rawCookieHeader).toContain('SameSite=Lax');
    expect(rawCookieHeader).toContain('Path=/');
    expect(rawCookieHeader).not.toContain('Domain=');
    expect(rawCookieHeader).not.toContain('Secure');

    // Production cookie sets Secure attribute (behind TLS reverse proxy)
    const prodHarness = createTestHarness({ nodeEnv: 'production' });
    const prodInit = await request(prodHarness.app)
      .get('/api/auth/google')
      .set('X-Forwarded-Proto', 'https')
      .expect(302);
    const prodCookie = prodInit.headers['set-cookie'].find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`)
    );
    expect(prodCookie).toContain('Secure');

    // Repeated authenticated requests
    const me1 = await agent.get('/api/auth/me').expect(200);
    expect(me1.headers['cache-control']).toBe('no-store');
    expect(me1.body.user.email).toBe('auth.integration@example.com');

    const sessRes = await agent.get('/api/auth/session').expect(200);
    expect(sessRes.body.authenticated).toBe(true);
    expect(sessRes.body.absoluteExpiresAt).toBeTruthy();
    expect(sessRes.body.idleExpiresAt).toBeTruthy();
    expect(JSON.stringify(sessRes.body)).not.toContain('s%3A');

    // Simulate backend restart / app reconstruction sharing the same MongoDB session store
    const harness2 = createTestHarness();
    const meAfterRestart = await request(harness2.app)
      .get('/api/auth/me')
      .set('Cookie', postLoginCookie)
      .expect(200);
    expect(meAfterRestart.body.user.id).toBe(me1.body.user.id);
  });

  it('enforces inactivity expiration, rolling activity capped at absolute expiration, and absolute expiration', async () => {
    const startMs = Date.UTC(2026, 10, 25, 10, 0, 0);
    const harness = createTestHarness({
      sessionMaxAgeMs: 60000,
      sessionIdleTimeoutMs: 20000,
      nowFn: () => startMs
    });

    const { agent } = await loginAgent(harness.app);
    const initialSession = await agent.get('/api/auth/session').expect(200);
    const initialAbs = Date.parse(initialSession.body.absoluteExpiresAt);

    // Advance 15s (< 20s idle) -> activity extends idleExpiresAt
    harness.advanceTime(15000);
    await agent.get('/api/auth/me').expect(200);
    const afterActivity1 = await agent.get('/api/auth/session').expect(200);
    expect(Date.parse(afterActivity1.body.idleExpiresAt)).toBe(startMs + 35000);
    expect(Date.parse(afterActivity1.body.absoluteExpiresAt)).toBe(initialAbs);

    // Advance another 15s (total 30s < 35s idle) -> rolling idle extends to 50s
    harness.advanceTime(15000);
    await agent.get('/api/auth/me').expect(200);
    const afterActivity2 = await agent.get('/api/auth/session').expect(200);
    expect(Date.parse(afterActivity2.body.idleExpiresAt)).toBe(startMs + 50000);

    // Advance another 15s (total 45s < 50s idle) -> rolling idle capped at absoluteExpiresAt (60s)
    harness.advanceTime(15000);
    await agent.get('/api/auth/me').expect(200);
    const afterActivity3 = await agent.get('/api/auth/session').expect(200);
    expect(Date.parse(afterActivity3.body.idleExpiresAt)).toBe(initialAbs);

    // Advance past absolute expiration (total 61s > 60s) -> rejected with 401 SESSION_EXPIRED
    harness.advanceTime(16000);
    const expiredRes = await agent.get('/api/auth/me').expect(401);
    expect(expiredRes.body.error.code).toBe('SESSION_EXPIRED');

    // Separate session: test inactivity expiration without activity
    const idleHarness = createTestHarness({
      sessionMaxAgeMs: 120000,
      sessionIdleTimeoutMs: 20000,
      nowFn: () => startMs
    });
    const { agent: idleAgent } = await loginAgent(idleHarness.app);
    idleHarness.advanceTime(25000);
    const idleExpired = await idleAgent.get('/api/auth/me').expect(401);
    expect(idleExpired.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('enforces RBAC and reflects manual MongoDB promotion and demotion without relogin', async () => {
    const harness = createTestHarness();
    const { agent } = await loginAgent(harness.app);

    // Unauthenticated rejected
    await request(harness.app).get('/api/auth/me').expect(401);
    await request(harness.app).get('/api/test-rbac/participant-only').expect(401);

    // Initially PARTICIPANT
    await agent.get('/api/test-rbac/participant-only').expect(200);
    await agent.get('/api/test-rbac/admin-only').expect(403);

    const meParticipant = await agent.get('/api/auth/me').expect(200);
    const userId = meParticipant.body.user.id;
    expect(meParticipant.body.user.permissions).toEqual({
      participantPortal: true,
      adminPortal: false
    });

    // Manual MongoDB promotion to ADMIN -> takes effect immediately without relogin
    await User.updateOne({ _id: userId }, { $set: { role: USER_ROLES.ADMIN } });

    const meAdmin = await agent.get('/api/auth/me').expect(200);
    expect(meAdmin.body.user.role).toBe('ADMIN');
    expect(meAdmin.body.user.permissions).toEqual({
      participantPortal: true,
      adminPortal: true
    });
    await agent.get('/api/test-rbac/participant-only').expect(200);
    await agent.get('/api/test-rbac/admin-only').expect(200);

    // Manual MongoDB demotion back to PARTICIPANT -> takes effect immediately without relogin
    await User.updateOne({ _id: userId }, { $set: { role: USER_ROLES.PARTICIPANT } });
    await agent.get('/api/test-rbac/admin-only').expect(403);
    await agent.get('/api/test-rbac/participant-only').expect(200);

    // Account disabled in MongoDB -> rejected with 403 ACCOUNT_DISABLED
    await User.updateOne({ _id: userId }, { $set: { isActive: false } });
    const disabledRes = await agent.get('/api/auth/me').expect(403);
    expect(disabledRes.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('enforces CSRF protection, rejects cross-session tokens & untrusted origins, and supports independent browser sessions & logout', async () => {
    const harness = createTestHarness();

    // User A
    const { agent: agentA } = await loginAgent(harness.app);
    // User B
    harness.setProfile({
      provider: 'google',
      id: 'test-auth-sub-2',
      displayName: 'Second User',
      _json: {
        sub: 'test-auth-sub-2',
        email: 'second.user@example.com',
        email_verified: true,
        name: 'Second User'
      }
    });
    const { agent: agentB } = await loginAgent(harness.app);

    const csrfARes = await agentA.get('/api/auth/csrf').expect(200);
    const csrfBRes = await agentB.get('/api/auth/csrf').expect(200);
    expect(csrfARes.headers['cache-control']).toBe('no-store');

    const csrfA = csrfARes.body.csrfToken;
    const csrfB = csrfBRes.body.csrfToken;

    // Missing CSRF token rejected
    const missingCsrf = await agentA.post('/api/auth/logout').expect(403);
    expect(missingCsrf.body.error.code).toBe('CSRF_TOKEN_MISSING');

    // Invalid CSRF token rejected
    const invalidCsrf = await agentA
      .post('/api/auth/logout')
      .set('X-CSRF-Token', 'invalid-csrf-token-value')
      .expect(403);
    expect(invalidCsrf.body.error.code).toBe('CSRF_TOKEN_INVALID');

    // Token from another session rejected
    const crossSessionCsrf = await agentA
      .post('/api/auth/logout')
      .set('X-CSRF-Token', csrfB)
      .expect(403);
    expect(crossSessionCsrf.body.error.code).toBe('CSRF_TOKEN_INVALID');

    // Untrusted origin rejected
    await agentA
      .post('/api/auth/logout')
      .set('Origin', 'https://evil.example.com')
      .set('X-CSRF-Token', csrfA)
      .expect(403);

    // Valid CSRF token from trusted origin succeeds and invalidates only Agent A's session
    await agentA
      .post('/api/auth/logout')
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfA)
      .expect(200);

    // Agent A is now unauthenticated
    await agentA.get('/api/auth/me').expect(401);
    const sessA = await agentA.get('/api/auth/session').expect(200);
    expect(sessA.body.authenticated).toBe(false);

    // Agent B's independent session remains valid
    const meB = await agentB.get('/api/auth/me').expect(200);
    expect(meB.body.user.email).toBe('second.user@example.com');

    // Invalid forged session cookie is rejected
    await request(harness.app)
      .get('/api/auth/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=s%3Aforged-id.invalid-sig`)
      .expect(401);
  });

  it('returns 503 instead of 401 and preserves session when session store or DB is temporarily unavailable', async () => {
    let dbUp = true;
    const harness = createTestHarness({
      databaseAdapter: { isReady: () => dbUp }
    });
    const { agent } = await loginAgent(harness.app);

    await agent.get('/api/auth/me').expect(200);

    // Simulate temporary DB outage
    dbUp = false;
    const outageMe = await agent.get('/api/auth/me').expect(503);
    expect(outageMe.body.error.code).toBe('AUTH_INFRASTRUCTURE_UNAVAILABLE');

    const outageSession = await agent.get('/api/auth/session').expect(503);
    expect(outageSession.body.error.code).toBe('AUTH_INFRASTRUCTURE_UNAVAILABLE');

    // Once DB recovers, the legitimate session still works without relogin
    dbUp = true;
    await agent.get('/api/auth/me').expect(200);
  });
});
