import { Writable } from 'node:stream';
import session from 'express-session';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createPassportAuthenticator } from '../../src/config/passport.js';
import { createOAuthStateStore } from '../../src/modules/auth/auth.service.js';
import { createLogger } from '../../src/utils/logger.js';

function createMemoryLogCapture() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    }
  });
  return {
    stream,
    readAll: () => chunks.join('')
  };
}

function createUnitOAuthApp({
  nodeEnv = 'development',
  oauthStateTtlMs = 600000,
  nowFn = () => Date.now(),
  rateLimitOptions,
  mockGoogleProfile = {
    provider: 'google',
    id: 'google-sub-oauth-1',
    displayName: 'OAuth Test User',
    _json: {
      sub: 'google-sub-oauth-1',
      email: 'oauth.user@example.com',
      email_verified: true,
      name: 'OAuth Test User',
      picture: 'https://lh3.googleusercontent.com/a/default'
    }
  }
} = {}) {
  let currentNow = nowFn();
  const clock = () => currentNow;

  const usersBySub = new Map();
  let nextId = 1;
  const mockUserService = {
    async findOrCreateGoogleUser({ googleSub, email, emailVerified, name, avatar }) {
      if (emailVerified !== true) {
        const err = new Error('Unverified email');
        err.statusCode = 401;
        err.code = 'UNVERIFIED_GOOGLE_EMAIL';
        throw err;
      }
      let existing = usersBySub.get(googleSub);
      if (!existing) {
        const assignedId = `user-${nextId++}`;
        existing = {
          _id: { toString: () => assignedId },
          googleSub,
          email,
          name,
          avatar,
          role: 'PARTICIPANT',
          isActive: true
        };
        usersBySub.set(googleSub, existing);
      }
      return existing;
    },
    async getUserById(userId) {
      for (const u of usersBySub.values()) {
        if (u._id.toString() === userId) {
          return u;
        }
      }
      return null;
    },
    toPublicUser(u) {
      return {
        id: u._id.toString(),
        name: u.name,
        email: u.email,
        avatar: u.avatar,
        role: u.role,
        permissions: {
          participantPortal: true,
          adminPortal: u.role === 'ADMIN'
        }
      };
    }
  };

  const env = {
    NODE_ENV: nodeEnv,
    LOG_LEVEL: 'info',
    PARTICIPANT_FRONTEND_URL: 'http://localhost:5173',
    ADMIN_FRONTEND_URL: 'http://localhost:5174',
    CORS_ORIGINS: ['http://localhost:5173', 'http://localhost:5174'],
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_CALLBACK_URL: 'http://localhost:5000/api/auth/google/callback',
    SESSION_SECRET: 'unit-test-session-secret-must-be-at-least-32-characters',
    SESSION_MAX_AGE_MS: 28800000,
    SESSION_IDLE_TIMEOUT_MS: 7200000,
    OAUTH_STATE_TTL_MS: oauthStateTtlMs
  };

  const logCapture = createMemoryLogCapture();
  const logger = createLogger({ level: 'info', destination: logCapture.stream });

  const oauthStateStore = createOAuthStateStore({
    oauthStateTtlMs,
    nowFn: clock,
    useDatabase: false
  });

  const authenticator = createPassportAuthenticator({
    env,
    oauthStateStore,
    userService: mockUserService
  });

  // Mock external Google HTTP calls while exercising real Passport OAuth2 + PKCE + state store
  const googleStrategy = authenticator._strategy('google');
  vi.spyOn(googleStrategy._oauth2, 'getOAuthAccessToken').mockImplementation(
    (_code, params, callback) => {
      expect(params.code_verifier).toBeTypeOf('string');
      expect(params.redirect_uri).toBe(env.GOOGLE_CALLBACK_URL);
      callback(null, 'mock-google-access-token', 'mock-google-refresh-token', {});
    }
  );
  vi.spyOn(googleStrategy, 'userProfile').mockImplementation((_token, callback) => {
    callback(null, mockGoogleProfile);
  });

  const sessionStore = new session.MemoryStore();

  const app = createApp({
    env,
    logger,
    database: { isReady: () => true },
    sessionStore,
    userService: mockUserService,
    oauthStateStore,
    authenticator,
    rateLimitOptions,
    nowFn: clock
  });

  return {
    app,
    logCapture,
    advanceTime(ms) {
      currentNow += ms;
    }
  };
}

describe('Google OAuth security, state validation, redirects, and log redaction (unit / mocked Google provider)', () => {
  it('completes OAuth login with valid state + PKCE, rotates session, redirects to trusted portal, and redacts sensitive logs', async () => {
    const { app, logCapture } = createUnitOAuthApp({ nodeEnv: 'development' });
    const agent = request.agent(app);

    const initRes = await agent.get('/api/auth/google?portal=dev').expect(302);
    const location = new URL(initRes.headers.location);
    const state = location.searchParams.get('state');
    const codeChallenge = location.searchParams.get('code_challenge');

    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(codeChallenge).toBeTruthy();
    expect(state).toBeTruthy();

    const callbackRes = await agent
      .get(`/api/auth/google/callback?code=fake-oauth-auth-code-999&state=${encodeURIComponent(state)}`)
      .expect(302);

    expect(callbackRes.headers.location).toBe('/api/auth/me');

    const meRes = await agent.get('/api/auth/me').expect(200);
    expect(meRes.body.user).toMatchObject({
      email: 'oauth.user@example.com',
      role: 'PARTICIPANT',
      permissions: { participantPortal: true, adminPortal: false }
    });

    const logs = logCapture.readAll();
    expect(logs).not.toContain('fake-oauth-auth-code-999');
    expect(logs).not.toContain('mock-google-access-token');
    expect(logs).not.toContain('mock-google-refresh-token');
    expect(logs).not.toContain('c2c.sid=');
  });

  it('rejects missing, invalid, expired, and replayed OAuth states', async () => {
    const { app, advanceTime } = createUnitOAuthApp({ oauthStateTtlMs: 600000 });

    // Missing state
    const missingAgent = request.agent(app);
    await missingAgent.get('/api/auth/google').expect(302);
    const missingRes = await missingAgent
      .get('/api/auth/google/callback?code=some-code')
      .expect(400);
    expect(missingRes.body.error.code).toBe('MISSING_OAUTH_STATE');

    // Invalid state
    const invalidAgent = request.agent(app);
    await invalidAgent.get('/api/auth/google').expect(302);
    const invalidRes = await invalidAgent
      .get('/api/auth/google/callback?code=some-code&state=forged-state-value')
      .expect(403);
    expect(invalidRes.body.error.code).toBe('INVALID_OAUTH_STATE');

    // Expired state (after 10 minutes)
    const expiredAgent = request.agent(app);
    const expInit = await expiredAgent.get('/api/auth/google').expect(302);
    const expState = new URL(expInit.headers.location).searchParams.get('state');
    advanceTime(600001);
    const expiredRes = await expiredAgent
      .get(`/api/auth/google/callback?code=some-code&state=${encodeURIComponent(expState)}`)
      .expect(403);
    expect(expiredRes.body.error.code).toBe('EXPIRED_OAUTH_STATE');

    // Replayed state
    const replayAgent = request.agent(app);
    const repInit = await replayAgent.get('/api/auth/google').expect(302);
    const repState = new URL(repInit.headers.location).searchParams.get('state');
    await replayAgent
      .get(`/api/auth/google/callback?code=code-1&state=${encodeURIComponent(repState)}`)
      .expect(302);
    const replayRes = await replayAgent
      .get(`/api/auth/google/callback?code=code-1&state=${encodeURIComponent(repState)}`)
      .expect(403);
    expect(['INVALID_OAUTH_STATE', 'REPLAYED_OAUTH_STATE']).toContain(
      replayRes.body.error.code
    );
  });

  it('prevents concurrent callback replay on the same OAuth state', async () => {
    const { app } = createUnitOAuthApp();
    const agent = request.agent(app);

    const initRes = await agent.get('/api/auth/google').expect(302);
    const state = new URL(initRes.headers.location).searchParams.get('state');
    const callbackUrl = `/api/auth/google/callback?code=concurrent-code&state=${encodeURIComponent(state)}`;

    const [resA, resB] = await Promise.all([agent.get(callbackUrl), agent.get(callbackUrl)]);
    const statuses = [resA.status, resB.status].sort((a, b) => a - b);

    expect(statuses).toEqual([302, 403]);
  });

  it('handles Google consent cancellation gracefully without creating a session', async () => {
    const { app } = createUnitOAuthApp({ nodeEnv: 'development' });

    const participantAgent = request.agent(app);
    await participantAgent.get('/api/auth/google?portal=participant').expect(302);
    const cancelRedirect = await participantAgent
      .get('/api/auth/google/callback?error=access_denied')
      .expect(302);
    expect(cancelRedirect.headers.location).toBe(
      'http://localhost:5173?authError=OAUTH_CONSENT_CANCELLED'
    );
    await participantAgent.get('/api/auth/me').expect(401);

    const devAgent = request.agent(app);
    await devAgent.get('/api/auth/google?portal=dev').expect(302);
    const cancelJson = await devAgent
      .get('/api/auth/google/callback?error=access_denied')
      .expect(401);
    expect(cancelJson.body.error.code).toBe('OAUTH_CONSENT_CANCELLED');
  });

  it('rejects invalid portal redirect destinations and disables dev destination outside development', async () => {
    const { app: devApp } = createUnitOAuthApp({ nodeEnv: 'development' });
    const badPortal = await request(devApp)
      .get('/api/auth/google?portal=https://evil.example.com')
      .expect(400);
    expect(badPortal.body.error.code).toBe('INVALID_PORTAL_DESTINATION');

    const { app: prodApp } = createUnitOAuthApp({ nodeEnv: 'production' });
    const prodDevPortal = await request(prodApp)
      .get('/api/auth/google?portal=dev')
      .expect(400);
    expect(prodDevPortal.body.error.code).toBe('INVALID_PORTAL_DESTINATION');
  });

  it('enforces auth OAuth rate limits while keeping /api/auth/session unrestricted', async () => {
    const { app } = createUnitOAuthApp({
      rateLimitOptions: { oauthMax: 2, oauthWindowMs: 60000 }
    });

    await request(app).get('/api/auth/google').expect(302);
    await request(app).get('/api/auth/google').expect(302);
    const limited = await request(app).get('/api/auth/google').expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMIT_EXCEEDED');

    // Normal session inspection remains unaffected
    await request(app).get('/api/auth/session').expect(200);
    await request(app).get('/api/auth/session').expect(200);
    await request(app).get('/api/auth/session').expect(200);
  });
});
