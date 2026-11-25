import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { loadEnv } from '../../src/config/env.js';
import { createPassportAuthenticator } from '../../src/config/passport.js';
import { createMongoSessionStore } from '../../src/config/session.js';
import { createOAuthStateStore } from '../../src/modules/auth/auth.service.js';
import { Competition } from '../../src/modules/competition/competition.model.js';
import { ensureDefaultCompetition } from '../../src/modules/competition/competition.service.js';
import { FrozenRosterEntry } from '../../src/modules/competition/frozenRoster.model.js';
import { TeamRoundState } from '../../src/modules/competition/teamRoundState.model.js';
import { Problem } from '../../src/modules/problems/problem.model.js';
import { getInternalExecutionProblem } from '../../src/modules/problems/problem.service.js';
import { TestCase } from '../../src/modules/problems/testCase.model.js';
import { Team } from '../../src/modules/teams/team.model.js';
import { TeamMembership } from '../../src/modules/teams/teamMembership.model.js';
import { USER_ROLES, User } from '../../src/modules/users/user.model.js';
import { createLogger } from '../../src/utils/logger.js';

const env = loadEnv();
const logger = createLogger({ level: 'silent' });
const PROB_TEST_SLUG = 'code-rush-phase05-it';

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

function createProblemsHarness({
  competitionSlug = PROB_TEST_SLUG,
  initialNowMs = Date.UTC(2026, 10, 25, 14, 0, 0)
} = {}) {
  let currentNowMs = initialNowMs;
  const clock = () => currentNowMs;

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
    database: { isReady: () => true },
    sessionStore,
    oauthStateStore,
    authenticator,
    competitionSlug,
    nowFn: clock
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

  return {
    app,
    loginAs,
    advanceTime(ms) {
      currentNowMs += ms;
    }
  };
}

const sampleProblemPayload = (overrides = {}) => ({
  title: 'Sum of Two Numbers',
  difficulty: 'EASY',
  statement: 'Given two integers A and B, print their sum A + B.',
  inputFormat: 'Two space-separated integers A and B.',
  outputFormat: 'Single integer representing A + B.',
  constraints: '-10^9 <= A, B <= 10^9',
  allowedLanguages: ['C', 'CPP', 'PYTHON', 'JAVA'],
  ...overrides
});

async function cleanupFixtures() {
  const comps = await Competition.find({ slug: PROB_TEST_SLUG }).select('_id').lean();
  const compIds = comps.map((c) => c._id);

  if (compIds.length > 0) {
    await TestCase.deleteMany({ competitionId: { $in: compIds } });
    await Problem.deleteMany({ competitionId: { $in: compIds } });
    await TeamRoundState.deleteMany({ competitionId: { $in: compIds } });
    await FrozenRosterEntry.deleteMany({ competitionId: { $in: compIds } });
    await TeamMembership.deleteMany({ competitionId: { $in: compIds } });
    await Team.deleteMany({ competitionId: { $in: compIds } });
    await Competition.deleteMany({ _id: { $in: compIds } });
  }
  await User.deleteMany({ googleSub: /^test-p5-sub-/ });
}

describe('Phase 05 Problem bank, test cases, publication, security & lifecycle (real MongoDB integration)', () => {
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
    await FrozenRosterEntry.syncIndexes();
    await TeamRoundState.syncIndexes();
    await Problem.syncIndexes();
    await TestCase.syncIndexes();
  });

  beforeEach(async () => {
    await cleanupFixtures();
    await ensureDefaultCompetition({
      slug: PROB_TEST_SLUG,
      name: 'CODE RUSH P5',
      teamSize: 2,
      maxTeams: 50,
      durationSeconds: 30
    });
  });

  afterAll(async () => {
    await cleanupFixtures();
    await disconnectDatabase({ logger });
  });

  it('supports admin draft CRUD, test cases, empty inputs, cross-problem protection, version checks, and transactional draft deletion', async () => {
    const harness = createProblemsHarness();
    const admin = await harness.loginAs('test-p5-sub-crud-a', { role: USER_ROLES.ADMIN });
    const participant = await harness.loginAs('test-p5-sub-crud-p');

    // Participant rejected from admin problem APIs
    await participant.agent.get('/api/admin/problems').expect(403);
    await participant.agent
      .post('/api/admin/problems')
      .set('X-CSRF-Token', participant.csrfToken)
      .send(sampleProblemPayload())
      .expect(403);

    // Missing CSRF rejected
    await admin.agent
      .post('/api/admin/problems')
      .send(sampleProblemPayload())
      .expect(403);

    // Create two draft problems
    const p1Res = await admin.agent
      .post('/api/admin/problems')
      .set('X-CSRF-Token', admin.csrfToken)
      .send(sampleProblemPayload({ title: 'First Draft', displayOrder: 1 }))
      .expect(201);
    const p1 = p1Res.body.problem;
    expect(p1.status).toBe('DRAFT');
    expect(p1.rewardDistance).toBe(10);

    const p2Res = await admin.agent
      .post('/api/admin/problems')
      .set('X-CSRF-Token', admin.csrfToken)
      .send(sampleProblemPayload({ title: 'Second Draft', displayOrder: 2 }))
      .expect(201);
    const p2 = p2Res.body.problem;

    // Duplicate slug rejected
    const dupSlug = await admin.agent
      .post('/api/admin/problems')
      .set('X-CSRF-Token', admin.csrfToken)
      .send(sampleProblemPayload({ title: 'Another Name', slug: p1.slug }))
      .expect(409);
    expect(dupSlug.body.error.code).toBe('PROBLEM_SLUG_TAKEN');

    // Update enforces expectedVersion and rejects concurrent stale updates
    const upd1 = await admin.agent
      .patch(`/api/admin/problems/${p1.id}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ expectedVersion: p1.version, title: 'First Draft Updated' })
      .expect(200);
    expect(upd1.body.problem.version).toBe(2);

    await admin.agent
      .patch(`/api/admin/problems/${p1.id}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ expectedVersion: 1, title: 'Stale Overwrite' })
      .expect(409);

    // Add SAMPLE (with explanation) and HIDDEN (empty input) test cases
    const tcSample = await admin.agent
      .post(`/api/admin/problems/${p1.id}/test-cases`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        type: 'SAMPLE',
        input: '5 7\n',
        expectedOutput: '12\n',
        explanation: '5 + 7 = 12',
        displayOrder: 1
      })
      .expect(201);

    const tcHidden = await admin.agent
      .post(`/api/admin/problems/${p1.id}/test-cases`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        type: 'HIDDEN',
        input: '',
        expectedOutput: '0\n',
        displayOrder: 1
      })
      .expect(201);
    expect(tcHidden.body.testCase.input).toBe('');
    expect(tcHidden.body.problemVersion).toBe(4);

    // Cross-problem test case modification rejected
    await admin.agent
      .patch(`/api/admin/problems/${p2.id}/test-cases/${tcSample.body.testCase.id}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ expectedOutput: '999\n' })
      .expect(404);

    // Delete draft p1 -> deletes associated test cases transactionally
    await admin.agent
      .delete(`/api/admin/problems/${p1.id}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(200);

    expect(await Problem.findById(p1.id).lean()).toBeNull();
    expect(await TestCase.countDocuments({ problemId: p1.id })).toBe(0);
  });

  it('validates publication rules, immutability, unpublish/edit/republish, archival, readiness, and internal retrieval', async () => {
    const harness = createProblemsHarness();
    const admin = await harness.loginAs('test-p5-sub-pub-a', { role: USER_ROLES.ADMIN });

    const created = await admin.agent
      .post('/api/admin/problems')
      .set('X-CSRF-Token', admin.csrfToken)
      .send(sampleProblemPayload({ title: 'Publishable Sum', difficulty: 'MEDIUM' }))
      .expect(201);
    const problemId = created.body.problem.id;

    // Cannot publish without sample and hidden tests
    const failBoth = await admin.agent
      .post(`/api/admin/problems/${problemId}/publish`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(409);
    expect(failBoth.body.error.code).toBe('PROBLEM_PUBLICATION_INVALID');

    // Add sample only -> still cannot publish without hidden test
    await admin.agent
      .post(`/api/admin/problems/${problemId}/test-cases`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ type: 'SAMPLE', input: '1 2\n', expectedOutput: '3\n', displayOrder: 1 })
      .expect(201);

    await admin.agent
      .post(`/api/admin/problems/${problemId}/publish`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(409);

    // Add hidden test -> publishes cleanly
    await admin.agent
      .post(`/api/admin/problems/${problemId}/test-cases`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        type: 'HIDDEN',
        input: '10 20\n',
        expectedOutput: '30\n',
        displayOrder: 1
      })
      .expect(201);

    const pubRes = await admin.agent
      .post(`/api/admin/problems/${problemId}/publish`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(200);
    expect(pubRes.body.problem.status).toBe('PUBLISHED');
    expect(pubRes.body.problem.rewardDistance).toBe(25);

    // Published problem cannot be edited or deleted directly
    await admin.agent
      .patch(`/api/admin/problems/${problemId}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ expectedVersion: pubRes.body.problem.version, title: 'Direct Edit' })
      .expect(409);
    await admin.agent
      .delete(`/api/admin/problems/${problemId}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(409);

    // Unpublish -> edit -> republish works during LOBBY
    const unpub = await admin.agent
      .post(`/api/admin/problems/${problemId}/unpublish`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(200);
    const edited = await admin.agent
      .patch(`/api/admin/problems/${problemId}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ expectedVersion: unpub.body.problem.version, title: 'Refined Sum' })
      .expect(200);
    const repub = await admin.agent
      .post(`/api/admin/problems/${problemId}/publish`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(200);
    expect(repub.body.problem.title).toBe('Refined Sum');
    expect(repub.body.problem.version).toBeGreaterThan(edited.body.problem.version);

    // Readiness endpoint reports accurate counts and pending Judge0 verification
    const readiness = await admin.agent.get('/api/admin/problems/readiness').expect(200);
    expect(readiness.body.counts.totalPublished).toBe(1);
    expect(readiness.body.counts.publishedByDifficulty.MEDIUM).toBe(1);
    expect(readiness.body.structurallyReady).toBe(false);
    expect(readiness.body.executionVerificationPending).toBe(true);

    // Internal retrieval service exposes Judge0 IDs, limits, and sample + hidden tests
    const comp = await Competition.findOne({ slug: PROB_TEST_SLUG }).lean();
    const internal = await getInternalExecutionProblem({
      competitionId: comp._id,
      problemId
    });
    expect(internal.languageConfigs.JAVA.judge0LanguageId).toBe(62);
    expect(internal.sampleTestCases).toHaveLength(1);
    expect(internal.hiddenTestCases).toHaveLength(1);
    expect(internal.hiddenTestCases[0].expectedOutput).toBe('30\n');

    // Archive removes problem from published pool cleanly
    const arch = await admin.agent
      .post(`/api/admin/problems/${problemId}/archive`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(200);
    expect(arch.body.problem.status).toBe('ARCHIVED');
  });

  it('enforces lifecycle immutability after lock, participant pool visibility, deadline enforcement, and restart recovery', async () => {
    const startClockMs = Date.UTC(2026, 10, 25, 14, 0, 0);
    const harness1 = createProblemsHarness({ initialNowMs: startClockMs });
    const admin = await harness1.loginAs('test-p5-sub-vis-admin', { role: USER_ROLES.ADMIN });
    const leader = await harness1.loginAs('test-p5-sub-vis-l');
    const member = await harness1.loginAs('test-p5-sub-vis-m');
    const unassigned = await harness1.loginAs('test-p5-sub-vis-free');

    // Create ready team
    const tRes = await leader.agent
      .post('/api/teams')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ name: 'Visibility Squad' })
      .expect(201);
    await member.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', member.csrfToken)
      .send({ joinCode: tRes.body.team.joinCode })
      .expect(200);
    await leader.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ isReady: true })
      .expect(200);
    await member.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', member.csrfToken)
      .send({ isReady: true })
      .expect(200);

    // Create 1 published, 1 draft, and 1 archived problem
    const pubCreated = await admin.agent
      .post('/api/admin/problems')
      .set('X-CSRF-Token', admin.csrfToken)
      .send(
        sampleProblemPayload({
          title: 'Published Easy',
          difficulty: 'EASY',
          statement: 'SECRET_FULL_STATEMENT_TEXT_SHOULD_NOT_BE_IN_LIST'
        })
      )
      .expect(201);
    const pubId = pubCreated.body.problem.id;
    await admin.agent
      .post(`/api/admin/problems/${pubId}/test-cases`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ type: 'SAMPLE', input: '1\n', expectedOutput: '1\n', displayOrder: 1 })
      .expect(201);
    await admin.agent
      .post(`/api/admin/problems/${pubId}/test-cases`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        type: 'HIDDEN',
        input: '9\n',
        expectedOutput: 'HIDDEN_SECRET_VALUE',
        displayOrder: 1
      })
      .expect(201);
    await admin.agent
      .post(`/api/admin/problems/${pubId}/publish`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(200);

    await admin.agent
      .post('/api/admin/problems')
      .set('X-CSRF-Token', admin.csrfToken)
      .send(sampleProblemPayload({ title: 'Draft Hidden Problem' }))
      .expect(201);

    const archDraft = await admin.agent
      .post('/api/admin/problems')
      .set('X-CSRF-Token', admin.csrfToken)
      .send(sampleProblemPayload({ title: 'Archived Problem' }))
      .expect(201);
    await admin.agent
      .post(`/api/admin/problems/${archDraft.body.problem.id}/archive`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(200);

    // Before LIVE -> GET /api/problems returns 409 COMPETITION_NOT_LIVE
    const beforeLive = await leader.agent.get('/api/problems').expect(409);
    expect(beforeLive.body.error.code).toBe('COMPETITION_NOT_LIVE');

    // Rank import, confirm, lock, and start competition
    await admin.agent
      .post('/api/admin/teams/import-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ rankedTeamCount: 50, entries: [{ teamId: tRes.body.team.id, rank: 1 }] })
      .expect(200);
    await admin.agent
      .post('/api/admin/teams/confirm-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ rankImportVersion: 1 })
      .expect(200);
    const preview = await admin.agent
      .get('/api/admin/competition/roster-preview')
      .expect(200);
    await admin.agent
      .post('/api/admin/competition/lock')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        expectedRosterVersion: preview.body.rosterVersion,
        expectedRankImportVersion: preview.body.rankImportVersion
      })
      .expect(200);

    // Problem mutations rejected after lock
    const postLockCreate = await admin.agent
      .post('/api/admin/problems')
      .set('X-CSRF-Token', admin.csrfToken)
      .send(sampleProblemPayload({ title: 'Late Problem' }))
      .expect(409);
    expect(postLockCreate.body.error.code).toBe('LOBBY_CLOSED');

    await admin.agent
      .post(`/api/admin/problems/${pubId}/unpublish`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(409);

    // Start competition
    await admin.agent
      .post('/api/admin/competition/start')
      .set('X-CSRF-Token', admin.csrfToken)
      .expect(200);

    // Eligible participant sees only published summary metadata (no statement, no draft, no archived, no hidden)
    const listRes = await leader.agent.get('/api/problems').expect(200);
    expect(listRes.body.problems).toHaveLength(1);
    expect(listRes.body.problems[0].title).toBe('Published Easy');
    expect(listRes.body.problems[0].rewardDistance).toBe(10);
    expect(listRes.body.problems[0].statement).toBeUndefined();
    expect(JSON.stringify(listRes.body)).not.toContain(
      'SECRET_FULL_STATEMENT_TEXT_SHOULD_NOT_BE_IN_LIST'
    );
    expect(JSON.stringify(listRes.body)).not.toContain('HIDDEN_SECRET_VALUE');
    expect(JSON.stringify(listRes.body)).not.toContain('Draft Hidden Problem');
    expect(JSON.stringify(listRes.body)).not.toContain('Archived Problem');

    // Unassigned user cannot access live problem pool
    await unassigned.agent.get('/api/problems').expect(403);

    // Simulate backend reconstruction while LIVE -> records preserved
    const harness2 = createProblemsHarness({ initialNowMs: startClockMs + 5000 });
    const cookie = leader.agent.jar.getCookie('c2c.sid', {
      domain: '127.0.0.1',
      path: '/'
    });
    const listAfterRestart = await request(harness2.app)
      .get('/api/problems')
      .set('Cookie', `${cookie.name}=${cookie.value}`)
      .expect(200);
    expect(listAfterRestart.body.problems).toHaveLength(1);

    // After deadline expires -> 409 COMPETITION_DEADLINE_REACHED
    harness2.advanceTime(30000);
    const afterDeadline = await request(harness2.app)
      .get('/api/problems')
      .set('Cookie', `${cookie.name}=${cookie.value}`)
      .expect(409);
    expect(afterDeadline.body.error.code).toBe('COMPETITION_DEADLINE_REACHED');
  });

  it('serializes concurrent draft problem editing cleanly against roster locking', async () => {
    const harness = createProblemsHarness();
    const admin = await harness.loginAs('test-p5-sub-race-admin', { role: USER_ROLES.ADMIN });
    const leader = await harness.loginAs('test-p5-sub-race-l');
    const member = await harness.loginAs('test-p5-sub-race-m');

    const tRes = await leader.agent
      .post('/api/teams')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ name: 'Race Prob Squad' })
      .expect(201);
    await member.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', member.csrfToken)
      .send({ joinCode: tRes.body.team.joinCode })
      .expect(200);
    await leader.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ isReady: true })
      .expect(200);
    await member.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', member.csrfToken)
      .send({ isReady: true })
      .expect(200);

    const draft = await admin.agent
      .post('/api/admin/problems')
      .set('X-CSRF-Token', admin.csrfToken)
      .send(sampleProblemPayload({ title: 'Concurrent Edit Problem' }))
      .expect(201);

    await admin.agent
      .post('/api/admin/teams/import-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ rankedTeamCount: 50, entries: [{ teamId: tRes.body.team.id, rank: 1 }] })
      .expect(200);
    await admin.agent
      .post('/api/admin/teams/confirm-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ rankImportVersion: 1 })
      .expect(200);

    const preview = await admin.agent
      .get('/api/admin/competition/roster-preview')
      .expect(200);

    const [editRes, lockRes] = await Promise.all([
      admin.agent
        .patch(`/api/admin/problems/${draft.body.problem.id}`)
        .set('X-CSRF-Token', admin.csrfToken)
        .send({ expectedVersion: draft.body.problem.version, title: 'Edited Title' }),
      admin.agent
        .post('/api/admin/competition/lock')
        .set('X-CSRF-Token', admin.csrfToken)
        .send({
          expectedRosterVersion: preview.body.rosterVersion,
          expectedRankImportVersion: preview.body.rankImportVersion
        })
    ]);

    if (lockRes.status === 200) {
      expect(editRes.status).toBe(409);
      expect(editRes.body.error.code).toBe('LOBBY_CLOSED');
    } else {
      expect(editRes.status).toBe(200);
      expect(lockRes.status).toBe(409);
    }
  });
});
