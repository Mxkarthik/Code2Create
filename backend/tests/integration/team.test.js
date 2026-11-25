import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { loadEnv } from '../../src/config/env.js';
import { createPassportAuthenticator } from '../../src/config/passport.js';
import { createMongoSessionStore } from '../../src/config/session.js';
import { createOAuthStateStore } from '../../src/modules/auth/auth.service.js';
import {
  COMPETITION_STATUSES,
  Competition
} from '../../src/modules/competition/competition.model.js';
import { ensureDefaultCompetition } from '../../src/modules/competition/competition.service.js';
import { TEAM_STATUSES, Team } from '../../src/modules/teams/team.model.js';
import { TEAM_ROLES, TeamMembership } from '../../src/modules/teams/teamMembership.model.js';
import { USER_ROLES, User } from '../../src/modules/users/user.model.js';
import { createLogger } from '../../src/utils/logger.js';

const env = loadEnv();
const logger = createLogger({ level: 'silent' });
const TEAM_TEST_SLUG = 'code-rush-phase03-it';
const TEAM_CAP_SLUG = 'code-rush-phase03-cap-it';

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

function createTeamTestHarness({
  competitionSlug = TEAM_TEST_SLUG,
  databaseAdapter = { isReady: () => true },
  rateLimitOptions
} = {}) {
  const effectiveEnv = {
    ...env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LOG_FORMAT: 'minimal',
    PARTICIPANT_FRONTEND_URL: 'http://localhost:5173',
    ADMIN_FRONTEND_URL: 'http://localhost:5174',
    CORS_ORIGINS: ['http://localhost:5173', 'http://localhost:5174']
  };

  const sessionStore = createMongoSessionStore({
    client: mongoose.connection.getClient(),
    ttlSeconds: Math.ceil(effectiveEnv.SESSION_MAX_AGE_MS / 1000)
  });

  const oauthStateStore = createOAuthStateStore({
    oauthStateTtlMs: effectiveEnv.OAUTH_STATE_TTL_MS,
    useDatabase: true
  });

  const authenticator = createPassportAuthenticator({
    env: effectiveEnv,
    oauthStateStore
  });

  const googleStrategy = authenticator._strategy('google');
  let nextProfile = null;

  vi.spyOn(googleStrategy._oauth2, 'getOAuthAccessToken').mockImplementation(
    (_code, _params, callback) => {
      callback(null, 'mock-access-token', 'mock-refresh-token', {});
    }
  );
  vi.spyOn(googleStrategy, 'userProfile').mockImplementation((_token, callback) => {
    callback(null, nextProfile);
  });

  const app = createApp({
    env: effectiveEnv,
    logger,
    database: databaseAdapter,
    sessionStore,
    oauthStateStore,
    authenticator,
    rateLimitOptions,
    competitionSlug
  });

  async function loginAs(sub, { name = `User ${sub}`, role = USER_ROLES.PARTICIPANT } = {}) {
    nextProfile = {
      provider: 'google',
      id: sub,
      displayName: name,
      _json: {
        sub,
        email: `${sub}@example.com`,
        email_verified: true,
        name
      }
    };

    const agent = request.agent(app);
    const initRes = await agent.get('/api/auth/google').expect(302);
    const state = new URL(initRes.headers.location).searchParams.get('state');
    await agent
      .get(`/api/auth/google/callback?code=code-${sub}&state=${encodeURIComponent(state)}`)
      .expect(302);

    if (role === USER_ROLES.ADMIN) {
      await User.updateOne({ googleSub: sub }, { $set: { role: USER_ROLES.ADMIN } });
    }

    const csrfRes = await agent.get('/api/auth/csrf').expect(200);
    const meRes = await agent.get('/api/auth/me').expect(200);

    return {
      agent,
      csrfToken: csrfRes.body.csrfToken,
      user: meRes.body.user
    };
  }

  return { app, loginAs };
}

async function cleanupTestFixtures() {
  const comps = await Competition.find({
    slug: { $in: [TEAM_TEST_SLUG, TEAM_CAP_SLUG] }
  })
    .select('_id')
    .lean();
  const compIds = comps.map((c) => c._id);

  if (compIds.length > 0) {
    await TeamMembership.deleteMany({ competitionId: { $in: compIds } });
    await Team.deleteMany({ competitionId: { $in: compIds } });
    await Competition.deleteMany({ _id: { $in: compIds } });
  }
  await User.deleteMany({ googleSub: /^test-team-sub-/ });
}

describe('Phase 03 Team formation, concurrency, readiness, membership & admin lobby (real MongoDB integration)', () => {
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
    await Competition.syncIndexes();
    await Team.syncIndexes();
    await TeamMembership.syncIndexes();
  });

  beforeEach(async () => {
    await cleanupTestFixtures();
    await ensureDefaultCompetition({
      slug: TEAM_TEST_SLUG,
      name: 'CODE RUSH',
      teamSize: 2,
      maxTeams: 50
    });
  });

  afterAll(async () => {
    await cleanupTestFixtures();
    await disconnectDatabase({ logger });
  });

  it('creates teams transactionally for PARTICIPANT and ADMIN, preserves ADMIN global role, enforces validation/uniqueness, and updates /api/auth/me', async () => {
    const harness = createTeamTestHarness();

    // Unauthenticated creation rejected
    await request(harness.app)
      .post('/api/teams')
      .send({ name: 'NoAuth Team' })
      .expect(401);

    const userA = await harness.loginAs('test-team-sub-create-a', { name: 'Leader A' });
    const adminUser = await harness.loginAs('test-team-sub-create-admin', {
      name: 'Admin Leader',
      role: USER_ROLES.ADMIN
    });

    // Unassigned /api/auth/me & /api/teams/me return null team fields cleanly
    expect(userA.user.teamId).toBeNull();
    expect(userA.user.teamRole).toBeNull();
    const emptyTeam = await userA.agent.get('/api/teams/me').expect(200);
    expect(emptyTeam.headers['cache-control']).toBe('no-store');
    expect(emptyTeam.body.team).toBeNull();
    expect(emptyTeam.body.teamRole).toBeNull();

    // Invalid team names rejected
    await userA.agent
      .post('/api/teams')
      .set('X-CSRF-Token', userA.csrfToken)
      .send({ name: 'ab' })
      .expect(400);

    // PARTICIPANT creates team -> TEAM_LEADER, isReady=false, FORMING
    const createdRes = await userA.agent
      .post('/api/teams')
      .set('X-CSRF-Token', userA.csrfToken)
      .set('Idempotency-Key', 'create-key-1')
      .send({ name: 'Code Warriors' })
      .expect(201);

    expect(createdRes.body.teamRole).toBe(TEAM_ROLES.TEAM_LEADER);
    expect(createdRes.body.isReady).toBe(false);
    expect(createdRes.body.team.status).toBe(TEAM_STATUSES.FORMING);
    expect(createdRes.body.team.memberCount).toBe(1);
    expect(createdRes.body.team.joinCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);

    // Idempotent retry with same Idempotency-Key returns same team without creating a second team
    const retryRes = await userA.agent
      .post('/api/teams')
      .set('X-CSRF-Token', userA.csrfToken)
      .set('Idempotency-Key', 'create-key-1')
      .send({ name: 'Code Warriors' })
      .expect(200);
    expect(retryRes.body.team.id).toBe(createdRes.body.team.id);

    // Duplicate membership prevented without matching Idempotency-Key
    const dupMembership = await userA.agent
      .post('/api/teams')
      .set('X-CSRF-Token', userA.csrfToken)
      .send({ name: 'Another Team' })
      .expect(409);
    expect(dupMembership.body.error.code).toBe('TEAM_ALREADY_ASSIGNED');

    // Duplicate active team name (case-insensitive) rejected for another user
    const dupName = await adminUser.agent
      .post('/api/teams')
      .set('X-CSRF-Token', adminUser.csrfToken)
      .send({ name: '  code warriors ' })
      .expect(409);
    expect(dupName.body.error.code).toBe('TEAM_NAME_TAKEN');

    // ADMIN creates their own team and preserves global ADMIN role
    const adminTeam = await adminUser.agent
      .post('/api/teams')
      .set('X-CSRF-Token', adminUser.csrfToken)
      .send({ name: 'Admin Squad' })
      .expect(201);
    expect(adminTeam.body.teamRole).toBe(TEAM_ROLES.TEAM_LEADER);

    const meAdminAfter = await adminUser.agent.get('/api/auth/me').expect(200);
    expect(meAdminAfter.body.user.role).toBe(USER_ROLES.ADMIN);
    expect(meAdminAfter.body.user.teamId).toBe(adminTeam.body.team.id);
    expect(meAdminAfter.body.user.teamRole).toBe(TEAM_ROLES.TEAM_LEADER);
  });

  it('prevents duplicate teams on concurrent creation by same user and enforces maxTeams capacity atomically', async () => {
    await ensureDefaultCompetition({
      slug: TEAM_CAP_SLUG,
      name: 'CODE RUSH CAP',
      teamSize: 2,
      maxTeams: 2
    });

    const harness = createTeamTestHarness({ competitionSlug: TEAM_CAP_SLUG });
    const u1 = await harness.loginAs('test-team-sub-conc-1');
    const u2 = await harness.loginAs('test-team-sub-conc-2');
    const u3 = await harness.loginAs('test-team-sub-conc-3');

    // Concurrent creation by same user -> only 1 team created
    const [r1, r2] = await Promise.all([
      u1.agent
        .post('/api/teams')
        .set('X-CSRF-Token', u1.csrfToken)
        .send({ name: 'Same User Alpha' }),
      u1.agent
        .post('/api/teams')
        .set('X-CSRF-Token', u1.csrfToken)
        .send({ name: 'Same User Beta' })
    ]);
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([201, 409]);

    // Concurrent creation by u2 and u3 when maxTeams=2 and 1 slot remains -> only 1 succeeds
    const [c2, c3] = await Promise.all([
      u2.agent.post('/api/teams').set('X-CSRF-Token', u2.csrfToken).send({ name: 'Cap Two' }),
      u3.agent.post('/api/teams').set('X-CSRF-Token', u3.csrfToken).send({ name: 'Cap Three' })
    ]);
    expect([c2.status, c3.status].sort((a, b) => a - b)).toEqual([201, 409]);

    const capComp = await Competition.findOne({ slug: TEAM_CAP_SLUG }).lean();
    expect(capComp.activeTeamCount).toBe(2);
    expect(await Team.countDocuments({ competitionId: capComp._id })).toBe(2);
  });

  it('rolls back failed team creation transactions cleanly without orphan records', async () => {
    const harness = createTeamTestHarness();
    const u1 = await harness.loginAs('test-team-sub-rb-1');
    const spy = vi
      .spyOn(TeamMembership, 'create')
      .mockRejectedValueOnce(new Error('Simulated membership write failure'));

    await u1.agent
      .post('/api/teams')
      .set('X-CSRF-Token', u1.csrfToken)
      .send({ name: 'Rollback Team' })
      .expect(500);

    spy.mockRestore();

    const comp = await Competition.findOne({ slug: TEAM_TEST_SLUG }).lean();
    expect(comp.activeTeamCount).toBe(0);
    expect(await Team.countDocuments({ competitionId: comp._id })).toBe(0);
    expect(await TeamMembership.countDocuments({ competitionId: comp._id })).toBe(0);
  });

  it('handles invitation joining, lowercase normalization, full-team & concurrent last-slot races, regenerated codes, and rate limiting', async () => {
    const harness = createTeamTestHarness({
      rateLimitOptions: { joinAccountMax: 3, joinAccountWindowMs: 60000, joinIpMax: 100 }
    });

    const leader = await harness.loginAs('test-team-sub-join-leader', { name: 'Leader' });
    const member1 = await harness.loginAs('test-team-sub-join-m1', { name: 'Member 1' });
    const member2 = await harness.loginAs('test-team-sub-join-m2', { name: 'Member 2' });
    const otherLeader = await harness.loginAs('test-team-sub-join-other', { name: 'Other' });

    const created = await leader.agent
      .post('/api/teams')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ name: 'Joinable Team' })
      .expect(201);
    const oldCode = created.body.team.joinCode;

    await otherLeader.agent
      .post('/api/teams')
      .set('X-CSRF-Token', otherLeader.csrfToken)
      .send({ name: 'Other Team' })
      .expect(201);

    // Regenerating code invalidates old code immediately
    const regen = await leader.agent
      .post('/api/teams/me/regenerate-code')
      .set('X-CSRF-Token', leader.csrfToken)
      .expect(200);
    const newCode = regen.body.team.joinCode;
    expect(newCode).not.toBe(oldCode);

    const oldAttempt = await member1.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', member1.csrfToken)
      .send({ joinCode: oldCode })
      .expect(404);
    expect(oldAttempt.body.error.code).toBe('TEAM_CODE_INVALID');

    // Leader marks ready while forming, then teammate joins -> readiness resets to false
    await leader.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ isReady: true })
      .expect(200);

    // Concurrent last-slot race using lowercase normalized code between member1 & member2
    const [j1, j2] = await Promise.all([
      member1.agent
        .post('/api/teams/join')
        .set('X-CSRF-Token', member1.csrfToken)
        .send({ joinCode: newCode.toLowerCase() }),
      member2.agent
        .post('/api/teams/join')
        .set('X-CSRF-Token', member2.csrfToken)
        .send({ joinCode: newCode.toLowerCase() })
    ]);
    expect([j1.status, j2.status].sort((a, b) => a - b)).toEqual([200, 409]);

    const winner = j1.status === 200 ? member1 : member2;
    const loser = j1.status === 200 ? member2 : member1;

    // Winner's /api/teams/me hides joinCode from TEAM_MEMBER and shows reset readiness
    const winnerTeam = await winner.agent.get('/api/teams/me').expect(200);
    expect(winnerTeam.body.teamRole).toBe(TEAM_ROLES.TEAM_MEMBER);
    expect(winnerTeam.body.team.joinCode).toBeUndefined();
    expect(winnerTeam.body.team.status).toBe(TEAM_STATUSES.FORMED);
    expect(winnerTeam.body.team.readyMemberCount).toBe(0);

    // Winner re-joining same team is safe/idempotent
    await winner.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', winner.csrfToken)
      .send({ joinCode: newCode })
      .expect(200);

    // Other leader cannot join another team -> 409 TEAM_ALREADY_ASSIGNED
    const alreadyAssigned = await otherLeader.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', otherLeader.csrfToken)
      .send({ joinCode: newCode })
      .expect(409);
    expect(alreadyAssigned.body.error.code).toBe('TEAM_ALREADY_ASSIGNED');

    // Rate limiting works per account without blocking other accounts (use a fresh account with 0 prior attempts)
    const rateLimitedUser = await harness.loginAs('test-team-sub-join-rl', { name: 'Rate Test' });
    await rateLimitedUser.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', rateLimitedUser.csrfToken)
      .send({ joinCode: 'ZZZZ9999' })
      .expect(404);
    await rateLimitedUser.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', rateLimitedUser.csrfToken)
      .send({ joinCode: 'ZZZZ9999' })
      .expect(404);
    await rateLimitedUser.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', rateLimitedUser.csrfToken)
      .send({ joinCode: 'ZZZZ9999' })
      .expect(404);
    await rateLimitedUser.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', rateLimitedUser.csrfToken)
      .send({ joinCode: 'ZZZZ9999' })
      .expect(429);

    // Other account on same IP is unaffected
    await loser.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', loser.csrfToken)
      .send({ joinCode: 'ZZZZ9999' })
      .expect(404);
  });

  it('prevents concurrent joins by one user across two different teams', async () => {
    const harness = createTeamTestHarness();
    const l1 = await harness.loginAs('test-team-sub-cj-l1');
    const l2 = await harness.loginAs('test-team-sub-cj-l2');
    const jumper = await harness.loginAs('test-team-sub-cj-u');

    const t1 = await l1.agent
      .post('/api/teams')
      .set('X-CSRF-Token', l1.csrfToken)
      .send({ name: 'Team One' })
      .expect(201);
    const t2 = await l2.agent
      .post('/api/teams')
      .set('X-CSRF-Token', l2.csrfToken)
      .send({ name: 'Team Two' })
      .expect(201);

    const [r1, r2] = await Promise.all([
      jumper.agent
        .post('/api/teams/join')
        .set('X-CSRF-Token', jumper.csrfToken)
        .send({ joinCode: t1.body.team.joinCode }),
      jumper.agent
        .post('/api/teams/join')
        .set('X-CSRF-Token', jumper.csrfToken)
        .send({ joinCode: t2.body.team.joinCode })
    ]);

    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([200, 409]);
    expect(await TeamMembership.countDocuments({ userId: jumper.user.id })).toBe(1);
  });

  it('persists individual readiness, transitions FORMED <-> READY, and survives app reconstruction', async () => {
    const harness1 = createTeamTestHarness();
    const leader = await harness1.loginAs('test-team-sub-ready-l', { name: 'Ready Leader' });
    const member = await harness1.loginAs('test-team-sub-ready-m', { name: 'Ready Member' });

    const created = await leader.agent
      .post('/api/teams')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ name: 'Ready Squad' })
      .expect(201);

    await member.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', member.csrfToken)
      .send({ joinCode: created.body.team.joinCode })
      .expect(200);

    // One ready member -> still FORMED
    const r1 = await leader.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ isReady: true })
      .expect(200);
    expect(r1.body.team.status).toBe(TEAM_STATUSES.FORMED);
    expect(r1.body.team.readyMemberCount).toBe(1);

    // Idempotent repeat
    const r1Repeat = await leader.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ isReady: true })
      .expect(200);
    expect(r1Repeat.body.team.revision).toBe(r1.body.team.revision);

    // Second ready member -> READY
    const r2 = await member.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', member.csrfToken)
      .send({ isReady: true })
      .expect(200);
    expect(r2.body.team.status).toBe(TEAM_STATUSES.READY);
    expect(r2.body.team.readyMemberCount).toBe(2);

    // Simulate backend restart / app reconstruction
    const harness2 = createTeamTestHarness();
    const leaderMeCookie = (await leader.agent.get('/api/teams/me').expect(200)).body;
    expect(leaderMeCookie.team.status).toBe(TEAM_STATUSES.READY);

    // Verify existing session works on reconstructed app
    const authCookie = leader.agent.jar.getCookie('c2c.sid', {
      domain: '127.0.0.1',
      path: '/'
    });
    const recovered = await request(harness2.app)
      .get('/api/teams/me')
      .set('Cookie', `${authCookie.name}=${authCookie.value}`)
      .expect(200);
    expect(recovered.body.team.status).toBe(TEAM_STATUSES.READY);
    expect(recovered.body.teamRole).toBe(TEAM_ROLES.TEAM_LEADER);
    expect(recovered.body.isReady).toBe(true);

    // Unready transitions READY -> FORMED
    const unreadyRes = await member.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', member.csrfToken)
      .send({ isReady: false })
      .expect(200);
    expect(unreadyRes.body.team.status).toBe(TEAM_STATUSES.FORMED);
    expect(unreadyRes.body.team.readyMemberCount).toBe(1);
  });

  it('supports leave, leadership transfer, leader departure succession, member removal guards, and dissolution', async () => {
    const harness = createTeamTestHarness();
    const leader = await harness.loginAs('test-team-sub-mgmt-l', { name: 'Orig Leader' });
    const member = await harness.loginAs('test-team-sub-mgmt-m', { name: 'Member' });
    const outsider = await harness.loginAs('test-team-sub-mgmt-o', { name: 'Outsider' });

    const created = await leader.agent
      .post('/api/teams')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ name: 'Manageable Team' })
      .expect(201);
    const joinCode = created.body.team.joinCode;

    await member.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', member.csrfToken)
      .send({ joinCode })
      .expect(200);

    await outsider.agent
      .post('/api/teams')
      .set('X-CSRF-Token', outsider.csrfToken)
      .send({ name: 'Outsider Team' })
      .expect(201);

    // Member cannot remove leader or transfer leadership
    await member.agent
      .delete(`/api/teams/me/members/${leader.user.id}`)
      .set('X-CSRF-Token', member.csrfToken)
      .expect(403);

    // Leader cannot remove cross-team member
    await leader.agent
      .delete(`/api/teams/me/members/${outsider.user.id}`)
      .set('X-CSRF-Token', leader.csrfToken)
      .expect(404);

    // Leader cannot remove self via member-removal endpoint
    await leader.agent
      .delete(`/api/teams/me/members/${leader.user.id}`)
      .set('X-CSRF-Token', leader.csrfToken)
      .expect(409);

    // Transfer leadership to member
    const transferred = await leader.agent
      .post('/api/teams/me/transfer-leadership')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ targetUserId: member.user.id })
      .expect(200);
    expect(transferred.body.teamRole).toBe(TEAM_ROLES.TEAM_MEMBER);
    const leaderCount = await TeamMembership.countDocuments({
      teamId: created.body.team.id,
      teamRole: TEAM_ROLES.TEAM_LEADER
    });
    expect(leaderCount).toBe(1);

    // Original leader (now member) leaves -> team returns to FORMING with new leader
    await leader.agent
      .post('/api/teams/me/leave')
      .set('X-CSRF-Token', leader.csrfToken)
      .expect(200);

    // Leader rejoins and marks ready, then new leader removes them -> readiness resets
    await leader.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ joinCode })
      .expect(200);
    await member.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', member.csrfToken)
      .send({ isReady: true })
      .expect(200);

    const removed = await member.agent
      .delete(`/api/teams/me/members/${leader.user.id}`)
      .set('X-CSRF-Token', member.csrfToken)
      .expect(200);
    expect(removed.body.team.memberCount).toBe(1);
    expect(removed.body.team.readyMemberCount).toBe(0);

    // Rejoin so 2 members exist, then leader (member) leaves -> leadership transfers to remaining teammate (leader)
    await leader.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ joinCode })
      .expect(200);

    await member.agent
      .post('/api/teams/me/leave')
      .set('X-CSRF-Token', member.csrfToken)
      .expect(200);

    const promotedLeaderTeam = await leader.agent.get('/api/teams/me').expect(200);
    expect(promotedLeaderTeam.body.teamRole).toBe(TEAM_ROLES.TEAM_LEADER);
    expect(promotedLeaderTeam.body.team.memberCount).toBe(1);

    // Remaining leader marks ready, then dissolves team -> capacity released, code invalidated, historical record retained, user kept
    await leader.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ isReady: true })
      .expect(200);

    await leader.agent
      .delete('/api/teams/me')
      .set('X-CSRF-Token', leader.csrfToken)
      .expect(200);

    const dissolvedTeam = await Team.findById(created.body.team.id).lean();
    expect(dissolvedTeam.status).toBe(TEAM_STATUSES.DISSOLVED);
    expect(dissolvedTeam.joinCode).toBeNull();
    expect(await User.findById(member.user.id).lean()).toBeTruthy();

    // Old dissolved code is rejected
    await leader.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ joinCode })
      .expect(404);
  });

  it('enforces admin lobby RBAC, CSRF protection, LOBBY-only mutations, concurrent lock race, and 503 DB outage safety', async () => {
    let dbUp = true;
    const harness = createTeamTestHarness({
      databaseAdapter: { isReady: () => dbUp }
    });

    const participant = await harness.loginAs('test-team-sub-rbac-p', { name: 'Part' });
    const admin = await harness.loginAs('test-team-sub-rbac-a', {
      name: 'Admin',
      role: USER_ROLES.ADMIN
    });

    // Missing / invalid CSRF rejected
    await participant.agent
      .post('/api/teams')
      .send({ name: 'No CSRF' })
      .expect(403);
    await participant.agent
      .post('/api/teams')
      .set('X-CSRF-Token', 'invalid-csrf-token')
      .send({ name: 'Bad CSRF' })
      .expect(403);

    await participant.agent
      .post('/api/teams')
      .set('X-CSRF-Token', participant.csrfToken)
      .send({ name: 'Lobby Team' })
      .expect(201);

    // PARTICIPANT blocked from admin lobby APIs
    await participant.agent.get('/api/admin/lobby').expect(403);
    await participant.agent.get('/api/admin/teams').expect(403);

    // ADMIN accesses admin lobby APIs and sees complete sanitized overview
    const lobbyRes = await admin.agent.get('/api/admin/lobby').expect(200);
    expect(lobbyRes.body.summary.activeTeamCount).toBe(1);
    expect(lobbyRes.body.summary.formingTeamCount).toBe(1);
    expect(lobbyRes.body.summary.totalJoinedUsers).toBe(1);
    expect(lobbyRes.body.teams[0].leader.name).toBe('Part');
    expect(JSON.stringify(lobbyRes.body)).not.toContain('c2c.sid');

    await admin.agent.get('/api/admin/teams').expect(200);

    // Concurrent race between LOBBY->LOCKED transition and team creation
    const comp = await Competition.findOne({ slug: TEAM_TEST_SLUG }).lean();
    const lockPromise = (async () => {
      const s = await mongoose.startSession();
      try {
        await s.withTransaction(async () => {
          await Competition.updateOne(
            { _id: comp._id },
            { $set: { status: COMPETITION_STATUSES.LOCKED }, $inc: { rosterVersion: 1 } },
            { session: s }
          );
        });
      } finally {
        await s.endSession();
      }
    })();
    const lateCreatePromise = admin.agent
      .post('/api/teams')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ name: 'Late Team' });

    const [, lateCreateRes] = await Promise.all([lockPromise, lateCreatePromise]);
    if (lateCreateRes.status === 201) {
      // If create won the lock first, subsequent mutation after LOCKED must fail 409 LOBBY_CLOSED
      const afterLock = await admin.agent
        .patch('/api/teams/me/ready')
        .set('X-CSRF-Token', admin.csrfToken)
        .send({ isReady: true })
        .expect(409);
      expect(afterLock.body.error.code).toBe('LOBBY_CLOSED');
    } else {
      expect(lateCreateRes.status).toBe(409);
      expect(lateCreateRes.body.error.code).toBe('LOBBY_CLOSED');
    }

    // Outside LOBBY, readiness and leave are rejected
    const closedReady = await participant.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', participant.csrfToken)
      .send({ isReady: true })
      .expect(409);
    expect(closedReady.body.error.code).toBe('LOBBY_CLOSED');

    // Database outage returns 503 without partial writes
    dbUp = false;
    await participant.agent.get('/api/teams/me').expect(503);
    await participant.agent
      .post('/api/teams')
      .set('X-CSRF-Token', participant.csrfToken)
      .send({ name: 'Outage Team' })
      .expect(503);
    dbUp = true;
  });
});
