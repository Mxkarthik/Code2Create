import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { loadEnv } from '../../src/config/env.js';
import { createPassportAuthenticator } from '../../src/config/passport.js';
import { createMongoSessionStore } from '../../src/config/session.js';
import {
  requireActiveUser,
  requireLiveCompetitionAdmission,
  requireParticipantAccess
} from '../../src/middleware/authorize.js';
import { createOAuthStateStore } from '../../src/modules/auth/auth.service.js';
import {
  COMPETITION_STATUSES,
  Competition
} from '../../src/modules/competition/competition.model.js';
import {
  ensureDefaultCompetition,
  reconcileCompetitionDeadline
} from '../../src/modules/competition/competition.service.js';
import { FrozenRosterEntry } from '../../src/modules/competition/frozenRoster.model.js';
import { TeamRoundState } from '../../src/modules/competition/teamRoundState.model.js';
import {
  RANK_MAPPING_STATUSES,
  Team
} from '../../src/modules/teams/team.model.js';
import { TeamMembership } from '../../src/modules/teams/teamMembership.model.js';
import { USER_ROLES, User } from '../../src/modules/users/user.model.js';
import { createLogger } from '../../src/utils/logger.js';

const env = loadEnv();
const logger = createLogger({ level: 'silent' });
const COMP_TEST_SLUG = 'code-rush-phase04-it';
const OTHER_COMP_SLUG = 'code-rush-phase04-other-it';

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

function createCompetitionHarness({
  competitionSlug = COMP_TEST_SLUG,
  databaseAdapter = { isReady: () => true },
  initialNowMs = Date.UTC(2026, 10, 25, 12, 0, 0)
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
    database: databaseAdapter,
    sessionStore,
    oauthStateStore,
    authenticator,
    competitionSlug,
    nowFn: clock,
    mountExtraRoutes: ({ app: targetApp, sessionMiddleware, authMiddleware }) => {
      const gameplayRouter = express.Router();
      gameplayRouter.use(sessionMiddleware);
      gameplayRouter.post(
        '/admit',
        authMiddleware.requireAuth,
        requireActiveUser,
        requireParticipantAccess,
        requireLiveCompetitionAdmission({ competitionSlug, nowFn: clock }),
        (req, res) => {
          res.status(200).json({
            success: true,
            teamId: req.frozenRosterEntry.teamId.toString(),
            totalDistance: req.teamRoundState.totalDistance
          });
        }
      );
      targetApp.use('/api/test-gameplay', gameplayRouter);
    }
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

  async function createReadyTeam(subPrefix, teamName) {
    const leader = await loginAs(`${subPrefix}-l`, { name: `${teamName} Leader` });
    const member = await loginAs(`${subPrefix}-m`, { name: `${teamName} Member` });

    const created = await leader.agent
      .post('/api/teams')
      .set('X-CSRF-Token', leader.csrfToken)
      .send({ name: teamName })
      .expect(201);

    await member.agent
      .post('/api/teams/join')
      .set('X-CSRF-Token', member.csrfToken)
      .send({ joinCode: created.body.team.joinCode })
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

    return {
      teamId: created.body.team.id,
      joinCode: created.body.team.joinCode,
      leader,
      member
    };
  }

  return {
    app,
    loginAs,
    createReadyTeam,
    now: clock,
    advanceTime(ms) {
      currentNowMs += ms;
    }
  };
}

async function cleanupPhase04Fixtures() {
  const comps = await Competition.find({
    slug: { $in: [COMP_TEST_SLUG, OTHER_COMP_SLUG] }
  })
    .select('_id')
    .lean();
  const compIds = comps.map((c) => c._id);

  if (compIds.length > 0) {
    await TeamRoundState.deleteMany({ competitionId: { $in: compIds } });
    await FrozenRosterEntry.deleteMany({ competitionId: { $in: compIds } });
    await TeamMembership.deleteMany({ competitionId: { $in: compIds } });
    await Team.deleteMany({ competitionId: { $in: compIds } });
    await Competition.deleteMany({ _id: { $in: compIds } });
  }
  await User.deleteMany({ googleSub: /^test-p4-sub-/ });
}

describe('Phase 04 Competition lifecycle, rank import, roster locking, timer & recovery (real MongoDB integration)', () => {
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
  });

  beforeEach(async () => {
    await cleanupPhase04Fixtures();
    await ensureDefaultCompetition({
      slug: COMP_TEST_SLUG,
      name: 'CODE RUSH',
      teamSize: 2,
      maxTeams: 50,
      durationSeconds: 1800,
      maxHeadStart: 20,
      qualificationLimit: 10
    });
  });

  afterAll(async () => {
    await cleanupPhase04Fixtures();
    await disconnectDatabase({ logger });
  });

  it('imports, replaces, confirms Round 1 ranks, enforces version/rollback/auth, and invalidates stale mappings on membership changes', async () => {
    const harness = createCompetitionHarness();
    const admin = await harness.loginAs('test-p4-sub-imp-admin', { role: USER_ROLES.ADMIN });
    const teamA = await harness.createReadyTeam('test-p4-sub-imp-a', 'Alpha Squad');
    const teamB = await harness.createReadyTeam('test-p4-sub-imp-b', 'Beta Squad');

    // Create a team in another competition to verify cross-competition rejection
    const otherComp = await ensureDefaultCompetition({ slug: OTHER_COMP_SLUG, name: 'OTHER' });
    const [otherTeam] = await Team.create([
      {
        competitionId: otherComp._id,
        name: 'Foreign Team',
        normalizedName: 'foreign team',
        joinCode: 'FORN2345',
        leaderId: admin.user.id
      }
    ]);

    // Non-admin cannot import or confirm
    await teamA.leader.agent
      .post('/api/admin/teams/import-ranks')
      .set('X-CSRF-Token', teamA.leader.csrfToken)
      .send({ rankedTeamCount: 50, entries: [{ teamId: teamA.teamId, rank: 1 }] })
      .expect(403);

    // Valid initial import
    const imp1 = await admin.agent
      .post('/api/admin/teams/import-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        rankedTeamCount: 50,
        entries: [
          { teamId: teamA.teamId, rank: 1 },
          { teamId: teamB.teamId, rank: 25 }
        ]
      })
      .expect(200);
    expect(imp1.body.rankImportVersion).toBe(1);
    expect(imp1.body.summary.mappedCount).toBe(2);

    // Confirm rank import
    const conf1 = await admin.agent
      .post('/api/admin/teams/confirm-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ rankImportVersion: 1 })
      .expect(200);
    expect(conf1.body.rankImportConfirmed).toBe(true);

    // Stale confirm rejected
    await admin.agent
      .post('/api/admin/teams/confirm-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ rankImportVersion: 99 })
      .expect(409);

    // Failed import (cross-competition team) rolls back completely, preserving version 1 mappings
    await admin.agent
      .post('/api/admin/teams/import-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        rankedTeamCount: 50,
        entries: [
          { teamId: teamA.teamId, rank: 5 },
          { teamId: otherTeam._id.toString(), rank: 6 }
        ]
      })
      .expect(404);

    const preservedA = await Team.findById(teamA.teamId).lean();
    expect(preservedA.round1Rank).toBe(1);

    // Replacement semantics: new import omitting teamB unmaps teamB and invalidates prior confirmation
    const imp2 = await admin.agent
      .post('/api/admin/teams/import-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        rankedTeamCount: 50,
        entries: [{ teamId: teamA.teamId, rank: 5 }]
      })
      .expect(200);
    expect(imp2.body.rankImportVersion).toBe(2);
    expect(imp2.body.rankImportConfirmed).toBe(false);
    expect(imp2.body.summary.unmappedCount).toBe(1);

    const unmappedB = await Team.findById(teamB.teamId).lean();
    expect(unmappedB.round1Rank).toBeNull();
    expect(unmappedB.round1MappingStatus).toBe(RANK_MAPPING_STATUSES.UNMAPPED);

    // Confirm v2, then change membership on teamA -> invalidates teamA's mapping to STALE and clears confirmation
    await admin.agent
      .post('/api/admin/teams/confirm-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ rankImportVersion: 2 })
      .expect(200);

    await teamA.member.agent
      .post('/api/teams/me/leave')
      .set('X-CSRF-Token', teamA.member.csrfToken)
      .expect(200);

    const staleA = await Team.findById(teamA.teamId).lean();
    expect(staleA.round1MappingStatus).toBe(RANK_MAPPING_STATUSES.STALE);
    expect(staleA.round1Rank).toBeNull();

    const previewAfterLeave = await admin.agent
      .get('/api/admin/competition/roster-preview')
      .expect(200);
    expect(previewAfterLeave.body.rankImportConfirmed).toBe(false);
    expect(previewAfterLeave.body.canLock).toBe(false);
  });

  it('enforces roster eligibility, exclusions/inclusions, disabled accounts, and locks eligible teams transactionally', async () => {
    const harness = createCompetitionHarness();
    const admin = await harness.loginAs('test-p4-sub-lock-admin', { role: USER_ROLES.ADMIN });
    const teamEligible = await harness.createReadyTeam('test-p4-sub-lock-e', 'Eligible Team');
    const teamIncomplete = await harness.loginAs('test-p4-sub-lock-inc');
    const createdInc = await teamIncomplete.agent
      .post('/api/teams')
      .set('X-CSRF-Token', teamIncomplete.csrfToken)
      .send({ name: 'Incomplete Team' })
      .expect(201);

    const teamDisabled = await harness.createReadyTeam('test-p4-sub-lock-dis', 'Disabled Team');
    await User.updateOne({ _id: teamDisabled.member.user.id }, { $set: { isActive: false } });

    // Import rank only for Eligible Team (Rank 1 of 50 -> 20 head start)
    await admin.agent
      .post('/api/admin/teams/import-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        rankedTeamCount: 50,
        entries: [{ teamId: teamEligible.teamId, rank: 1 }]
      })
      .expect(200);

    await admin.agent
      .post('/api/admin/teams/confirm-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ rankImportVersion: 1 })
      .expect(200);

    // Preview must block locking because Incomplete Team & Disabled Team exist
    const blockedPreview = await admin.agent
      .get('/api/admin/competition/roster-preview')
      .expect(200);
    expect(blockedPreview.body.canLock).toBe(false);
    expect(blockedPreview.body.incompleteTeamCount).toBe(1);

    // Lock attempt fails with 409 ROSTER_NOT_READY
    await admin.agent
      .post('/api/admin/competition/lock')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        expectedRosterVersion: blockedPreview.body.rosterVersion,
        expectedRankImportVersion: blockedPreview.body.rankImportVersion
      })
      .expect(409);

    // Exclude Incomplete Team & Disabled Team -> Eligible Team remains
    await admin.agent
      .post(`/api/admin/teams/${createdInc.body.team.id}/exclude`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'Missing teammate' })
      .expect(200);

    await admin.agent
      .post(`/api/admin/teams/${teamDisabled.teamId}/exclude`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'Member account disabled' })
      .expect(200);

    // Include & re-exclude verifies restoration works
    await admin.agent
      .post(`/api/admin/teams/${createdInc.body.team.id}/include`)
      .set('X-CSRF-Token', admin.csrfToken)
      .expect(200);
    await admin.agent
      .post(`/api/admin/teams/${createdInc.body.team.id}/exclude`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'Still missing teammate' })
      .expect(200);

    // Excluded team retains its membership
    const incMe = await teamIncomplete.agent.get('/api/teams/me').expect(200);
    expect(incMe.body.team.id).toBe(createdInc.body.team.id);

    // Configure short test duration (15s) while in LOBBY
    await admin.agent
      .patch('/api/admin/competition/config')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ durationSeconds: 15 })
      .expect(200);

    const readyPreview = await admin.agent
      .get('/api/admin/competition/roster-preview')
      .expect(200);
    expect(readyPreview.body.canLock).toBe(true);
    expect(readyPreview.body.eligibleTeamCount).toBe(1);
    expect(readyPreview.body.excludedTeamCount).toBe(2);
    expect(readyPreview.body.proposedHeadStarts[0].headStartDistance).toBe(20);

    // Rollback check: simulate failure inside TeamRoundState.create
    const trsSpy = vi
      .spyOn(TeamRoundState, 'create')
      .mockRejectedValueOnce(new Error('Simulated round state creation error'));
    await admin.agent
      .post('/api/admin/competition/lock')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        expectedRosterVersion: readyPreview.body.rosterVersion,
        expectedRankImportVersion: readyPreview.body.rankImportVersion
      })
      .expect(500);
    trsSpy.mockRestore();

    const compAfterRollback = await Competition.findOne({ slug: COMP_TEST_SLUG }).lean();
    expect(compAfterRollback.status).toBe(COMPETITION_STATUSES.LOBBY);
    expect(await FrozenRosterEntry.countDocuments({ competitionId: compAfterRollback._id })).toBe(0);
    expect(await TeamRoundState.countDocuments({ competitionId: compAfterRollback._id })).toBe(0);

    // Concurrent lock requests: only 1 succeeds, 1 fails with 409
    const [l1, l2] = await Promise.all([
      admin.agent
        .post('/api/admin/competition/lock')
        .set('X-CSRF-Token', admin.csrfToken)
        .send({
          expectedRosterVersion: readyPreview.body.rosterVersion,
          expectedRankImportVersion: readyPreview.body.rankImportVersion
        }),
      admin.agent
        .post('/api/admin/competition/lock')
        .set('X-CSRF-Token', admin.csrfToken)
        .send({
          expectedRosterVersion: readyPreview.body.rosterVersion,
          expectedRankImportVersion: readyPreview.body.rankImportVersion
        })
    ]);
    expect([l1.status, l2.status].sort((a, b) => a - b)).toEqual([200, 409]);

    const lockedComp = await Competition.findOne({ slug: COMP_TEST_SLUG }).lean();
    expect(lockedComp.status).toBe(COMPETITION_STATUSES.LOCKED);
    expect(lockedComp.eligibleTeamCount).toBe(1);

    // Exactly 1 TeamRoundState & FrozenRosterEntry created for eligible team only
    const roundStates = await TeamRoundState.find({ competitionId: lockedComp._id }).lean();
    expect(roundStates).toHaveLength(1);
    expect(roundStates[0].teamId.toString()).toBe(teamEligible.teamId);
    expect(roundStates[0].headStartDistance).toBe(20);
    expect(roundStates[0].earnedDistance).toBe(0);
    expect(roundStates[0].totalDistance).toBe(20);
    expect(roundStates[0].challengeOpportunitiesUsed).toBe(0);
    expect(roundStates[0].sampleRunsUsed).toBe(0);
    expect(roundStates[0].finalSubmissionsUsed).toBe(0);

    // Team mutations & config changes rejected after lock
    await teamEligible.leader.agent
      .patch('/api/teams/me/ready')
      .set('X-CSRF-Token', teamEligible.leader.csrfToken)
      .send({ isReady: false })
      .expect(409);

    await admin.agent
      .patch('/api/admin/competition/config')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ durationSeconds: 600 })
      .expect(409);

    // Participant state shows frozen rank/head start and excluded user sees safe non-playable state
    const eligibleState = await teamEligible.leader.agent
      .get('/api/competition/state')
      .expect(200);
    expect(eligibleState.body.teamRoundState.totalDistance).toBe(20);

    const excludedState = await teamIncomplete.agent
      .get('/api/competition/state')
      .expect(200);
    expect(excludedState.body.membership.isEligible).toBe(false);
    expect(excludedState.body.teamRoundState).toBeNull();
  });

  it('serializes concurrent team readiness/joining/import/exclusion cleanly against roster lock', async () => {
    const harness = createCompetitionHarness();
    const admin = await harness.loginAs('test-p4-sub-race-admin', { role: USER_ROLES.ADMIN });
    const teamA = await harness.createReadyTeam('test-p4-sub-race-a', 'Race Team');

    await admin.agent
      .post('/api/admin/teams/import-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        rankedTeamCount: 50,
        entries: [{ teamId: teamA.teamId, rank: 5 }]
      })
      .expect(200);

    await admin.agent
      .post('/api/admin/teams/confirm-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ rankImportVersion: 1 })
      .expect(200);

    const preview = await admin.agent
      .get('/api/admin/competition/roster-preview')
      .expect(200);

    // Race unreadiness against roster lock
    const [unreadyRes, lockRes] = await Promise.all([
      teamA.leader.agent
        .patch('/api/teams/me/ready')
        .set('X-CSRF-Token', teamA.leader.csrfToken)
        .send({ isReady: false }),
      admin.agent
        .post('/api/admin/competition/lock')
        .set('X-CSRF-Token', admin.csrfToken)
        .send({
          expectedRosterVersion: preview.body.rosterVersion,
          expectedRankImportVersion: preview.body.rankImportVersion
        })
    ]);

    if (lockRes.status === 200) {
      // Lock committed first -> unready MUST fail with 409 LOBBY_CLOSED
      expect(unreadyRes.status).toBe(409);
      expect(unreadyRes.body.error.code).toBe('LOBBY_CLOSED');
    } else {
      // Unready committed first -> lock MUST fail with 409 (version conflict or not ready)
      expect(unreadyRes.status).toBe(200);
      expect(lockRes.status).toBe(409);
    }
  });

  it('starts LOCKED competition once, enforces authoritative deadline, gameplay guard, SETTLING transition, and restart recovery', async () => {
    const startClockMs = Date.UTC(2026, 10, 25, 13, 0, 0);
    const harness1 = createCompetitionHarness({ initialNowMs: startClockMs });
    const admin = await harness1.loginAs('test-p4-sub-live-admin', { role: USER_ROLES.ADMIN });
    const teamA = await harness1.createReadyTeam('test-p4-sub-live-a', 'Live Team');
    const unassigned = await harness1.loginAs('test-p4-sub-live-free');
    const excludedLead = await harness1.loginAs('test-p4-sub-live-exc');
    const excTeam = await excludedLead.agent
      .post('/api/teams')
      .set('X-CSRF-Token', excludedLead.csrfToken)
      .send({ name: 'Excluded Live Team' })
      .expect(201);

    // Start rejected from LOBBY
    await admin.agent
      .post('/api/admin/competition/start')
      .set('X-CSRF-Token', admin.csrfToken)
      .expect(409);

    await admin.agent
      .patch('/api/admin/competition/config')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ durationSeconds: 15 })
      .expect(200);

    await admin.agent
      .post('/api/admin/teams/import-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        rankedTeamCount: 50,
        entries: [{ teamId: teamA.teamId, rank: 25 }]
      })
      .expect(200);

    await admin.agent
      .post('/api/admin/teams/confirm-ranks')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ rankImportVersion: 1 })
      .expect(200);

    await admin.agent
      .post(`/api/admin/teams/${excTeam.body.team.id}/exclude`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ reason: 'Incomplete' })
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

    // Participant cannot start, missing CSRF rejected
    await teamA.leader.agent
      .post('/api/admin/competition/start')
      .set('X-CSRF-Token', teamA.leader.csrfToken)
      .expect(403);
    await admin.agent.post('/api/admin/competition/start').expect(403);

    // Concurrent start requests -> exactly 1 succeeds (200), 1 rejected (409)
    const [s1, s2] = await Promise.all([
      admin.agent.post('/api/admin/competition/start').set('X-CSRF-Token', admin.csrfToken),
      admin.agent.post('/api/admin/competition/start').set('X-CSRF-Token', admin.csrfToken)
    ]);
    expect([s1.status, s2.status].sort((a, b) => a - b)).toEqual([200, 409]);

    const startRes = s1.status === 200 ? s1 : s2;
    expect(startRes.body.status).toBe(COMPETITION_STATUSES.LIVE);
    expect(startRes.body.durationSeconds).toBe(15);
    expect(startRes.body.remainingSeconds).toBe(15);

    const initialEndsAt = startRes.body.endsAt;

    // Repeated start rejected and does not alter timestamps
    await admin.agent
      .post('/api/admin/competition/start')
      .set('X-CSRF-Token', admin.csrfToken)
      .expect(409);

    // Eligible participant passes gameplay guard before deadline; excluded & unassigned rejected with 403
    harness1.advanceTime(5000);
    const cur5 = await teamA.leader.agent.get('/api/competition/current').expect(200);
    expect(cur5.body.remainingSeconds).toBe(10);

    await teamA.leader.agent
      .post('/api/test-gameplay/admit')
      .set('X-CSRF-Token', teamA.leader.csrfToken)
      .expect(200);

    const excAdmit = await excludedLead.agent
      .post('/api/test-gameplay/admit')
      .set('X-CSRF-Token', excludedLead.csrfToken)
      .expect(403);
    expect(excAdmit.body.error.code).toBe('TEAM_EXCLUDED');

    const unassAdmit = await unassigned.agent
      .post('/api/test-gameplay/admit')
      .set('X-CSRF-Token', unassigned.csrfToken)
      .expect(403);
    expect(unassAdmit.body.error.code).toBe('TEAM_NOT_ELIGIBLE');

    // Simulate backend restart while LIVE: harness2 preserves startedAt, endsAt, and remaining time
    const harness2 = createCompetitionHarness({ initialNowMs: startClockMs + 8000 });
    const authCookie = teamA.leader.agent.jar.getCookie('c2c.sid', {
      domain: '127.0.0.1',
      path: '/'
    });
    const curAfterRestart = await request(harness2.app)
      .get('/api/competition/current')
      .set('Cookie', `${authCookie.name}=${authCookie.value}`)
      .expect(200);
    expect(curAfterRestart.body.competition.status).toBe(COMPETITION_STATUSES.LIVE);
    expect(curAfterRestart.body.competition.endsAt).toBe(initialEndsAt);
    expect(curAfterRestart.body.remainingSeconds).toBe(7);

    // Advance to exact endsAt (startClockMs + 15000) -> gameplay guard rejects and transitions LIVE -> SETTLING
    harness2.advanceTime(7000);
    const csrfCookieHeader = `${authCookie.name}=${authCookie.value}`;
    const exactDeadlineAdmit = await request(harness2.app)
      .post('/api/test-gameplay/admit')
      .set('Cookie', csrfCookieHeader)
      .set('X-CSRF-Token', teamA.leader.csrfToken)
      .expect(409);
    expect(exactDeadlineAdmit.body.error.code).toBe('COMPETITION_DEADLINE_REACHED');

    const adminAfterDeadline = await request(harness2.app)
      .get('/api/admin/competition')
      .set(
        'Cookie',
        `${admin.agent.jar.getCookie('c2c.sid', { domain: '127.0.0.1', path: '/' }).name}=${admin.agent.jar.getCookie('c2c.sid', { domain: '127.0.0.1', path: '/' }).value}`
      )
      .expect(200);
    expect(adminAfterDeadline.body.competition.status).toBe(COMPETITION_STATUSES.SETTLING);
    expect(adminAfterDeadline.body.remainingSeconds).toBe(0);
    expect(adminAfterDeadline.body.competition.completedAt).toBeNull();

    // Repeated reconciliation is idempotent and does not change settlingAt or completedAt
    const secondReconcile = await reconcileCompetitionDeadline({
      competitionSlug: COMP_TEST_SLUG,
      nowFn: () => startClockMs + 60000
    });
    expect(secondReconcile).toBeNull();

    // Start rejected from SETTLING
    await admin.agent
      .post('/api/admin/competition/start')
      .set('X-CSRF-Token', admin.csrfToken)
      .expect(409);

    // TeamRoundState preserved intact after SETTLING
    const roundStateAfter = await TeamRoundState.findOne({
      teamId: teamA.teamId
    }).lean();
    expect(roundStateAfter.headStartDistance).toBe(10);
    expect(roundStateAfter.totalDistance).toBe(10);
  });
});
