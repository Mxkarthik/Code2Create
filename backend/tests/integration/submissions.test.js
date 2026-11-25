import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { loadEnv } from '../../src/config/env.js';
import { JUDGE0_ERROR_CODES, Judge0Error } from '../../src/integrations/judge0/judge0.errors.js';
import { EXECUTION_STATUSES } from '../../src/integrations/judge0/judge0.mapper.js';
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
import { ExecutionCapacity } from '../../src/modules/execution/executionCapacity.model.js';
import { ExecutionJob } from '../../src/modules/execution/executionJob.model.js';
import {
  claimDuePollingJobs,
  claimNextJobsForDispatch,
  dispatchClaimedJob,
  getQueueMonitoringStats,
  pollClaimedJob,
  reconcileSubmissionProgress
} from '../../src/modules/execution/executionQueue.service.js';
import { recoverExecutionQueue } from '../../src/modules/execution/executionRecovery.service.js';
import {
  PROBLEM_STATUSES,
  Problem
} from '../../src/modules/problems/problem.model.js';
import { buildProblemExecutionLimits } from '../../src/modules/problems/language.config.js';
import { TEST_CASE_TYPES, TestCase } from '../../src/modules/problems/testCase.model.js';
import {
  EXECUTION_JOB_STATUSES,
  SUBMISSION_MODES,
  SUBMISSION_SETTLEMENT_STATUSES,
  SUBMISSION_STATUSES,
  SUBMISSION_VERDICTS
} from '../../src/modules/submissions/submission.constants.js';
import { Submission } from '../../src/modules/submissions/submission.model.js';
import {
  admitSubmission,
  getSubmissionForTeam,
  settleSubmissionInternal
} from '../../src/modules/submissions/submission.service.js';
import { Team, TEAM_STATUSES } from '../../src/modules/teams/team.model.js';
import { USER_ROLES, User } from '../../src/modules/users/user.model.js';
import { createLogger } from '../../src/utils/logger.js';
import { createExecutionWorker } from '../../src/workers/execution.worker.js';

const env = loadEnv();
const COMP_TEST_SLUG = 'code-rush-phase07-it';
const TEST_CAP_KEY = 'phase07-it-capacity';

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

async function cleanPhase07Fixture() {
  const comps = await Competition.find({ slug: COMP_TEST_SLUG }).select('_id').lean();
  const compIds = comps.map((c) => c._id);

  if (compIds.length > 0) {
    await Promise.all([
      ExecutionJob.deleteMany({ competitionId: { $in: compIds } }),
      Submission.deleteMany({ competitionId: { $in: compIds } }),
      TeamRoundState.deleteMany({ competitionId: { $in: compIds } }),
      FrozenRosterEntry.deleteMany({ competitionId: { $in: compIds } }),
      TestCase.deleteMany({ competitionId: { $in: compIds } }),
      Problem.deleteMany({ competitionId: { $in: compIds } }),
      Team.deleteMany({ competitionId: { $in: compIds } }),
      Competition.deleteMany({ _id: { $in: compIds } })
    ]);
  }
  await ExecutionCapacity.deleteMany({ _id: TEST_CAP_KEY });
  await User.deleteMany({ googleSub: /^test-p7-sub-/ });
}

async function seedLiveFixture({
  teamCount = 2,
  hiddenCaseCount = 3,
  nowMs = Date.UTC(2026, 10, 25, 14, 0, 0)
} = {}) {
  const comp = await ensureDefaultCompetition({
    slug: COMP_TEST_SLUG,
    name: 'Phase 07 Queue IT'
  });

  const liveComp = await Competition.findOneAndUpdate(
    { _id: comp._id },
    {
      $set: {
        status: COMPETITION_STATUSES.LIVE,
        startedAt: new Date(nowMs - 60_000),
        endsAt: new Date(nowMs + 1_740_000)
      }
    },
    { returnDocument: 'after' }
  ).lean();

  const admin = await User.create({
    googleSub: 'test-p7-sub-admin',
    email: 'p7-admin@example.com',
    name: 'Phase 07 Admin',
    role: USER_ROLES.ADMIN,
    isActive: true
  });

  const problem = await Problem.create({
    competitionId: liveComp._id,
    title: 'Phase 07 Queue Problem',
    slug: 'phase07-queue-problem',
    difficulty: 'EASY',
    statement: 'Read two integers and print their sum.',
    inputFormat: 'Two space-separated integers',
    outputFormat: 'Single integer',
    constraints: '1 <= a, b <= 10^6',
    allowedLanguages: ['C', 'CPP', 'PYTHON', 'JAVA'],
    executionLimits: buildProblemExecutionLimits(['C', 'CPP', 'PYTHON', 'JAVA']),
    status: PROBLEM_STATUSES.PUBLISHED,
    displayOrder: 1,
    version: 1,
    createdBy: admin._id,
    updatedBy: admin._id,
    publishedAt: new Date(nowMs - 120_000)
  });

  const sampleCases = [
    await TestCase.create({
      competitionId: liveComp._id,
      problemId: problem._id,
      type: TEST_CASE_TYPES.SAMPLE,
      input: '2 3\n',
      expectedOutput: '5\n',
      explanation: '2 + 3 = 5',
      displayOrder: 1
    })
  ];

  const hiddenCases = [];
  for (let i = 1; i <= hiddenCaseCount; i += 1) {
    hiddenCases.push(
      await TestCase.create({
        competitionId: liveComp._id,
        problemId: problem._id,
        type: TEST_CASE_TYPES.HIDDEN,
        input: `${i * 10} ${i}\n`,
        expectedOutput: `${i * 10 + i}\n`,
        displayOrder: i
      })
    );
  }

  const teams = [];
  for (let t = 1; t <= teamCount; t += 1) {
    const leader = await User.create({
      googleSub: `test-p7-sub-t${t}-u1`,
      email: `p7-t${t}-u1@example.com`,
      name: `Team ${t} Leader`,
      role: USER_ROLES.PARTICIPANT,
      isActive: true
    });
    const mate = await User.create({
      googleSub: `test-p7-sub-t${t}-u2`,
      email: `p7-t${t}-u2@example.com`,
      name: `Team ${t} Mate`,
      role: USER_ROLES.PARTICIPANT,
      isActive: true
    });

    const team = await Team.create({
      competitionId: liveComp._id,
      name: `Team ${t}`,
      normalizedName: `team ${t}`,
      joinCode: `P7TM000${t}`,
      leaderId: leader._id,
      memberCount: 2,
      maxCapacity: 2,
      status: TEAM_STATUSES.READY,
      round1Rank: t,
      round1RankedTeamCount: teamCount
    });

    await FrozenRosterEntry.create({
      competitionId: liveComp._id,
      teamId: team._id,
      teamName: team.name,
      frozenLeaderId: leader._id,
      frozenMemberIds: [leader._id, mate._id],
      round1Rank: t,
      round1RankedTeamCount: teamCount,
      headStartDistance: 20 - (t - 1) * 5,
      rosterVersion: 1,
      lockedAt: new Date(nowMs - 90_000)
    });

    const attemptId = new mongoose.Types.ObjectId();
    const roundState = await TeamRoundState.create({
      competitionId: liveComp._id,
      teamId: team._id,
      frozenLeaderId: leader._id,
      frozenMemberIds: [leader._id, mate._id],
      round1Rank: t,
      headStartDistance: 20 - (t - 1) * 5,
      earnedDistance: 0,
      totalDistance: 20 - (t - 1) * 5,
      activeChallengeAttemptId: attemptId,
      pendingSubmissionId: null,
      stateVersion: 1
    });

    teams.push({ team, leader, mate, roundState, attemptId });
  }

  return { competition: liveComp, admin, problem, sampleCases, hiddenCases, teams, nowMs };
}

describe.skipIf(!isIsolatedTestDb)(
  'Phase 07 Persistent submission queue, scheduling, recovery & settlement (real MongoDB integration)',
  () => {
    beforeAll(async () => {
      await connectDatabase(env.MONGODB_TEST_URI, {
        dnsServers: env.MONGODB_DNS_SERVERS,
        allowDnsFallback: env.MONGODB_DNS_FALLBACK,
        silentInitialSuccess: true
      });
      await Competition.syncIndexes();
      await User.syncIndexes();
      await Problem.syncIndexes();
      await TestCase.syncIndexes();
      await Submission.syncIndexes();
      await ExecutionJob.syncIndexes();
      await ExecutionCapacity.syncIndexes();
      await TeamRoundState.syncIndexes();
      await FrozenRosterEntry.syncIndexes();
    });

    afterAll(async () => {
      await cleanPhase07Fixture();
      await disconnectDatabase();
    });

    beforeEach(async () => {
      await cleanPhase07Fixture();
    });

    it('admits submissions atomically, handles idempotency, concurrent teammate races, rollback, deadline, and SETTLING survival', async () => {
      const fixture = await seedLiveFixture({ teamCount: 2, hiddenCaseCount: 2 });
      const { competition, problem, teams, nowMs } = fixture;
      const t1 = teams[0];

      // 1. Ineligible user (not in frozen roster) cannot admit
      const outsider = await User.create({
        googleSub: 'test-p7-sub-outsider',
        email: 'outsider@example.com',
        name: 'Outsider',
        role: USER_ROLES.PARTICIPANT,
        isActive: true
      });
      await expect(
        admitSubmission({
          user: outsider,
          teamId: t1.team._id,
          challengeAttemptId: t1.attemptId,
          problemId: problem._id,
          problemVersion: problem.version,
          mode: SUBMISSION_MODES.SUBMIT,
          language: 'PYTHON',
          sourceCode: 'print(sum(map(int, input().split())))',
          idempotencyKey: 'idem-outsider-1',
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => nowMs
        })
      ).rejects.toMatchObject({ statusCode: 403, code: 'TEAM_NOT_ELIGIBLE' });

      // 2. Concurrent teammates racing to submit with distinct keys: strictly ONE succeeds
      const [resA, resB] = await Promise.allSettled([
        admitSubmission({
          user: t1.leader,
          teamId: t1.team._id,
          challengeAttemptId: t1.attemptId,
          problemId: problem._id,
          problemVersion: problem.version,
          mode: SUBMISSION_MODES.SUBMIT,
          language: 'PYTHON',
          sourceCode: 'print(sum(map(int, input().split())))',
          idempotencyKey: 'idem-leader-1',
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => nowMs
        }),
        admitSubmission({
          user: t1.mate,
          teamId: t1.team._id,
          challengeAttemptId: t1.attemptId,
          problemId: problem._id,
          problemVersion: problem.version,
          mode: SUBMISSION_MODES.SUBMIT,
          language: 'PYTHON',
          sourceCode: 'print(sum(map(int, input().split())))',
          idempotencyKey: 'idem-mate-1',
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => nowMs
        })
      ]);

      const succeeded = [resA, resB].filter((r) => r.status === 'fulfilled');
      const rejected = [resA, resB].filter((r) => r.status === 'rejected');
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.code).toBe('EXECUTION_ALREADY_PENDING');

      const winningSub = succeeded[0].value.submission;
      const winningUser =
        winningSub.submittedByUserId === t1.leader._id.toString() ? t1.leader : t1.mate;
      const winningKey =
        winningUser._id.toString() === t1.leader._id.toString()
          ? 'idem-leader-1'
          : 'idem-mate-1';

      // Verify TeamRoundState reservation + 2 durable ExecutionJob records
      const roundAfter = await TeamRoundState.findOne({
        competitionId: competition._id,
        teamId: t1.team._id
      }).lean();
      expect(roundAfter.pendingSubmissionId.toString()).toBe(winningSub.id);
      const jobsAfter = await ExecutionJob.find({ submissionId: winningSub.id }).lean();
      expect(jobsAfter).toHaveLength(2);

      // 3. Same Idempotency-Key + identical payload returns exact existing submission
      const deduped = await admitSubmission({
        user: winningUser,
        teamId: t1.team._id,
        challengeAttemptId: t1.attemptId,
        problemId: problem._id,
        problemVersion: problem.version,
        mode: SUBMISSION_MODES.SUBMIT,
        language: 'PYTHON',
        sourceCode: 'print(sum(map(int, input().split())))',
        idempotencyKey: winningKey,
        competitionSlug: COMP_TEST_SLUG,
        capacityKey: TEST_CAP_KEY,
        nowFn: () => nowMs + 100
      });
      expect(deduped.deduplicated).toBe(true);
      expect(deduped.submission.id).toBe(winningSub.id);

      // 4. Same Idempotency-Key + modified source rejects with 409 IDEMPOTENCY_KEY_CONFLICT
      await expect(
        admitSubmission({
          user: winningUser,
          teamId: t1.team._id,
          challengeAttemptId: t1.attemptId,
          problemId: problem._id,
          problemVersion: problem.version,
          mode: SUBMISSION_MODES.SUBMIT,
          language: 'PYTHON',
          sourceCode: 'print(0)',
          idempotencyKey: winningKey,
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => nowMs + 200
        })
      ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' });

      // 5. Rollback leaves zero orphan submissions/jobs on team 2 if problem version fails or TX aborts
      const t2 = teams[1];
      await expect(
        admitSubmission({
          user: t2.leader,
          teamId: t2.team._id,
          challengeAttemptId: t2.attemptId,
          problemId: problem._id,
          problemVersion: 999,
          mode: SUBMISSION_MODES.SUBMIT,
          language: 'PYTHON',
          sourceCode: 'print(1)',
          idempotencyKey: 'idem-bad-version',
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => nowMs
        })
      ).rejects.toMatchObject({ code: 'PROBLEM_VERSION_CONFLICT' });

      const t2Subs = await Submission.countDocuments({ teamId: t2.team._id });
      const t2State = await TeamRoundState.findOne({ teamId: t2.team._id }).lean();
      expect(t2Subs).toBe(0);
      expect(t2State.pendingSubmissionId).toBeNull();

      // 6. Queue backpressure rejects new admission when maxQueuedSubmissions limit hit
      await expect(
        admitSubmission({
          user: t2.leader,
          teamId: t2.team._id,
          challengeAttemptId: t2.attemptId,
          problemId: problem._id,
          problemVersion: problem.version,
          mode: SUBMISSION_MODES.RUN,
          language: 'PYTHON',
          sourceCode: 'print(1)',
          idempotencyKey: 'idem-t2-backpressure',
          competitionSlug: COMP_TEST_SLUG,
          maxQueuedSubmissions: 1,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => nowMs
        })
      ).rejects.toMatchObject({ statusCode: 503, code: 'EXECUTION_QUEUE_FULL' });

      // 7. Deadline reached rejects new submissions, while Team 1's admitted submission survives SETTLING
      const afterDeadlineMs = new Date(competition.endsAt).getTime();
      await reconcileCompetitionDeadline({
        competitionSlug: COMP_TEST_SLUG,
        nowFn: () => afterDeadlineMs
      });

      await expect(
        admitSubmission({
          user: t2.leader,
          teamId: t2.team._id,
          challengeAttemptId: t2.attemptId,
          problemId: problem._id,
          problemVersion: problem.version,
          mode: SUBMISSION_MODES.RUN,
          language: 'PYTHON',
          sourceCode: 'print(1)',
          idempotencyKey: 'idem-t2-after-deadline',
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => afterDeadlineMs
        })
      ).rejects.toMatchObject({ statusCode: 409, code: 'COMPETITION_DEADLINE_REACHED' });

      const t1SubStillQueued = await Submission.findById(winningSub.id).lean();
      expect(t1SubStillQueued.status).toBe(SUBMISSION_STATUSES.QUEUED);
    });

    it('enforces global maxInFlight limit and fair round-robin per-team scheduling without starvation', async () => {
      const fixture = await seedLiveFixture({ teamCount: 2, hiddenCaseCount: 4 });
      const { problem, teams, nowMs } = fixture;

      // Team 1 admits 4 hidden cases slightly earlier; Team 2 admits 4 hidden cases right after
      const sub1 = (
        await admitSubmission({
          user: teams[0].leader,
          teamId: teams[0].team._id,
          challengeAttemptId: teams[0].attemptId,
          problemId: problem._id,
          mode: SUBMISSION_MODES.SUBMIT,
          language: 'PYTHON',
          sourceCode: 'print(1)',
          idempotencyKey: 'idem-fair-t1',
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => nowMs
        })
      ).submission;

      const sub2 = (
        await admitSubmission({
          user: teams[1].leader,
          teamId: teams[1].team._id,
          challengeAttemptId: teams[1].attemptId,
          problemId: problem._id,
          mode: SUBMISSION_MODES.SUBMIT,
          language: 'PYTHON',
          sourceCode: 'print(2)',
          idempotencyKey: 'idem-fair-t2',
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => nowMs + 10
        })
      ).submission;

      // Duplicate logical testCaseOrder rejected by unique constraint
      await expect(
        ExecutionJob.create({
          competitionId: fixture.competition._id,
          submissionId: sub1.id,
          teamId: teams[0].team._id,
          problemId: problem._id,
          problemVersion: 1,
          testCaseId: fixture.hiddenCases[0]._id,
          testCaseOrder: 1,
          testCaseType: TEST_CASE_TYPES.HIDDEN,
          mode: SUBMISSION_MODES.SUBMIT,
          language: 'PYTHON',
          judge0LanguageId: 71,
          executionLimits: {
            cpuTimeLimitSeconds: 2,
            wallTimeLimitSeconds: 5,
            memoryLimitKb: 128000,
            maxSourceCodeBytes: 32768,
            maxOutputBytes: 262144
          },
          capacityKey: TEST_CAP_KEY
        })
      ).rejects.toThrow(/duplicate key|E11000/i);

      // Claim with global maxInFlight = 2 -> MUST give 1 slot to Team 1 and 1 slot to Team 2!
      const claimed = await claimNextJobsForDispatch({
        workerId: 'worker-fair-1',
        capacityKey: TEST_CAP_KEY,
        maxInFlight: 2,
        nowFn: () => nowMs + 50
      });

      expect(claimed).toHaveLength(2);
      const claimedTeams = new Set(claimed.map((j) => j.teamId.toString()));
      expect(claimedTeams.size).toBe(2);
      expect(claimedTeams.has(teams[0].team._id.toString())).toBe(true);
      expect(claimedTeams.has(teams[1].team._id.toString())).toBe(true);

      // Global cap saturated at 2 -> claiming again returns []
      const extra = await claimNextJobsForDispatch({
        workerId: 'worker-fair-2',
        capacityKey: TEST_CAP_KEY,
        maxInFlight: 2,
        nowFn: () => nowMs + 60
      });
      expect(extra).toHaveLength(0);

      const capDoc = await ExecutionCapacity.findById(TEST_CAP_KEY).lean();
      expect(capDoc.activeJobIds).toHaveLength(2);
      void sub2;
    });

    it('recovers crashes before token persistence as ADMISSION_UNCERTAIN, resumes known tokens, fences stale workers, and reconciles idempotently', async () => {
      const fixture = await seedLiveFixture({ teamCount: 2, hiddenCaseCount: 2 });
      const { competition, problem, teams } = fixture;
      let virtualNowMs = fixture.nowMs;

      const sub1 = (
        await admitSubmission({
          user: teams[0].leader,
          teamId: teams[0].team._id,
          challengeAttemptId: teams[0].attemptId,
          problemId: problem._id,
          mode: SUBMISSION_MODES.RUN,
          language: 'PYTHON',
          sourceCode: 'print(sum(map(int, input().split())))',
          idempotencyKey: 'idem-crash-1',
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => virtualNowMs
        })
      ).submission;

      const sub2 = (
        await admitSubmission({
          user: teams[1].leader,
          teamId: teams[1].team._id,
          challengeAttemptId: teams[1].attemptId,
          problemId: problem._id,
          mode: SUBMISSION_MODES.RUN,
          language: 'PYTHON',
          sourceCode: 'print(sum(map(int, input().split())))',
          idempotencyKey: 'idem-crash-2',
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => virtualNowMs + 5
        })
      ).submission;

      // Worker 1 claims 2 jobs with a short 500ms lease
      const claimed = await claimNextJobsForDispatch({
        workerId: 'worker-crashed',
        capacityKey: TEST_CAP_KEY,
        maxInFlight: 4,
        leaseDurationMs: 500,
        nowFn: () => virtualNowMs
      });
      expect(claimed).toHaveLength(2);

      // Job 0 simulates crash AFTER POST token persisted (moved to POLLING with lease still owned by crashed worker)
      await ExecutionJob.updateOne(
        { _id: claimed[0]._id },
        {
          $set: {
            status: EXECUTION_JOB_STATUSES.POLLING,
            judge0Token: 'persisted-tok-recovery-1',
            nextPollAt: new Date(virtualNowMs + 100)
          },
          $inc: { fencingVersion: 1 }
        }
      );

      // Job 1 stays in DISPATCHING (simulates crash AFTER dispatch intent / possibly POST without token persistence)
      // Advance clock past lease expiry (500ms) -> run recovery
      virtualNowMs += 2000;
      const recovery = await recoverExecutionQueue({
        capacityKey: TEST_CAP_KEY,
        maxInFlight: 4,
        uncertainReconcileMs: 60000,
        nowFn: () => virtualNowMs
      });

      expect(recovery.movedToUncertain).toBe(1); // Job 1 moved to ADMISSION_UNCERTAIN, never re-POSTed
      expect(recovery.recoveredPollingJobs).toBe(1); // Job 0 lease released for polling resume
      expect(recovery.activeCapacityCount).toBe(2); // Capacity remains reserved for both!

      const job1Recovered = await ExecutionJob.findById(claimed[1]._id).lean();
      expect(job1Recovered.status).toBe(EXECUTION_JOB_STATUSES.ADMISSION_UNCERTAIN);

      // Stale worker tries to write DISPATCHING -> POLLING on superseded fencingVersion -> MUST fail!
      const staleAttempt = await dispatchClaimedJob({
        job: claimed[1],
        workerId: 'worker-crashed',
        judge0Service: {
          createSubmission: vi.fn(async () => ({ token: 'late-stale-token' }))
        },
        nowFn: () => virtualNowMs
      });
      expect(staleAttempt.outcome).toBe('STALE_FENCED');
      expect((await ExecutionJob.findById(claimed[1]._id).lean()).status).toBe(
        EXECUTION_JOB_STATUSES.ADMISSION_UNCERTAIN
      );

      // Worker 2 claims recovered Job 0 for polling using the EXISTING persisted token (0 new POSTs)
      const createSubmissionSpy = vi.fn();
      const pollWorker = {
        createSubmission: createSubmissionSpy,
        getSubmissionResult: vi.fn(async ({ token }) => {
          expect(token).toBe('persisted-tok-recovery-1');
          return {
            token,
            status: EXECUTION_STATUSES.EXECUTED,
            isTerminal: true,
            isInfrastructureError: false,
            stdout: '5\n',
            stderr: '',
            compileOutput: '',
            timeSeconds: 0.01,
            memoryKb: 1024,
            outputMetadata: {}
          };
        })
      };

      const duePollJobs = await claimDuePollingJobs({
        workerId: 'worker-2',
        capacityKey: TEST_CAP_KEY,
        batchLimit: 4,
        leaseDurationMs: 5000,
        nowFn: () => virtualNowMs
      });
      expect(duePollJobs).toHaveLength(1);
      expect(duePollJobs[0].judge0Token).toBe('persisted-tok-recovery-1');

      const pollOutcome = await pollClaimedJob({
        job: duePollJobs[0],
        workerId: 'worker-2',
        judge0Service: pollWorker,
        nowFn: () => virtualNowMs
      });
      expect(pollOutcome.outcome).toBe(SUBMISSION_VERDICTS.ACCEPTED);
      expect(createSubmissionSpy).not.toHaveBeenCalled();

      // Reconcile submission 1 twice -> idempotent counters
      await reconcileSubmissionProgress({ submissionId: sub1.id, nowFn: () => virtualNowMs });
      const finalSub1 = await reconcileSubmissionProgress({
        submissionId: sub1.id,
        nowFn: () => virtualNowMs
      });
      expect(finalSub1.status).toBe(SUBMISSION_STATUSES.EXECUTION_COMPLETED);
      expect(finalSub1.verdict).toBe(SUBMISSION_VERDICTS.ACCEPTED);
      expect(finalSub1.passedCaseCount).toBe(1);
      expect(finalSub1.settlementStatus).toBe(SUBMISSION_SETTLEMENT_STATUSES.PENDING_SETTLEMENT);

      // Advance past conservative uncertainReconcileMs (60000ms) -> ADMISSION_UNCERTAIN reconciles to SYSTEM_FAILED & frees capacity
      virtualNowMs += 70000;
      const recovery2 = await recoverExecutionQueue({
        capacityKey: TEST_CAP_KEY,
        maxInFlight: 4,
        uncertainReconcileMs: 60000,
        nowFn: () => virtualNowMs
      });
      expect(recovery2.reconciledUncertainTimeout).toBe(1);
      expect(recovery2.activeCapacityCount).toBe(0);

      const finalSub2 = await Submission.findById(sub2.id).lean();
      expect(finalSub2.status).toBe(SUBMISSION_STATUSES.SYSTEM_FAILED);
      expect(finalSub2.verdict).toBe(SUBMISSION_VERDICTS.SYSTEM_ERROR);
      expect(finalSub2.settlementStatus).toBe(SUBMISSION_SETTLEMENT_STATUSES.PENDING_SETTLEMENT);

      void competition;
    });

    it('processes end-to-end worker verdicts (WA early skip, CE, infra failures), confidentiality, shutdown, and atomic settlement contract', async () => {
      const fixture = await seedLiveFixture({ teamCount: 2, hiddenCaseCount: 3 });
      const { competition, problem, teams, nowMs } = fixture;

      // Capture logs cleanly to verify source code / hidden outputs NEVER appear in logger output
      const logMessages = [];
      const capturingLogger = createLogger({
        level: 'info',
        format: 'json',
        destination: { write: (line) => logMessages.push(line) }
      });

      const subFailEarly = (
        await admitSubmission({
          user: teams[0].leader,
          teamId: teams[0].team._id,
          challengeAttemptId: teams[0].attemptId,
          problemId: problem._id,
          mode: SUBMISSION_MODES.SUBMIT,
          language: 'PYTHON',
          sourceCode: 'SECRET_SOURCE_MARKER_9911 = 1\nprint(999)',
          idempotencyKey: 'idem-e2e-submit-wa',
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => nowMs,
          logger: capturingLogger
        })
      ).submission;

      // Also test uncertain POST behavior (no auto-retry!) on Team 2
      const subUncertain = (
        await admitSubmission({
          user: teams[1].leader,
          teamId: teams[1].team._id,
          challengeAttemptId: teams[1].attemptId,
          problemId: problem._id,
          mode: SUBMISSION_MODES.RUN,
          language: 'PYTHON',
          sourceCode: 'print(5)',
          idempotencyKey: 'idem-e2e-run-uncertain',
          competitionSlug: COMP_TEST_SLUG,
          capacityKey: TEST_CAP_KEY,
          nowFn: () => nowMs + 10,
          logger: capturingLogger
        })
      ).submission;

      const createCallsByTeam = [];
      let transientGetOnce = true;

      const mockJudge0 = {
        createSubmission: vi.fn(async ({ stdin }) => {
          createCallsByTeam.push(stdin);
          if (stdin === '2 3\n') {
            throw new Judge0Error('Ambiguous POST timeout', {
              code: JUDGE0_ERROR_CODES.SUBMISSION_ADMISSION_UNCERTAIN,
              admissionUncertain: true
            });
          }
          return { token: `tok-${createCallsByTeam.length}-abcdef12` };
        }),
        getSubmissionResult: vi.fn(async ({ token }) => {
          if (transientGetOnce) {
            transientGetOnce = false;
            throw new Judge0Error('Temporary poll timeout', {
              code: JUDGE0_ERROR_CODES.TIMEOUT,
              isRetryable: true
            });
          }
          return {
            token,
            status: EXECUTION_STATUSES.EXECUTED,
            isTerminal: true,
            isInfrastructureError: false,
            stdout: '999\n',
            stderr: 'hidden-runtime-note',
            compileOutput: '',
            timeSeconds: 0.02,
            memoryKb: 2048,
            outputMetadata: {}
          };
        }),
        checkAvailability: vi.fn(async () => ({ available: true, authenticated: true }))
      };

      let tickNowMs = nowMs + 20;
      const worker = createExecutionWorker({
        judge0Service: mockJudge0,
        capacityKey: TEST_CAP_KEY,
        maxInFlight: 8,
        pollIntervalMs: 50,
        judge0PollIntervalMs: 100,
        judge0PollTimeoutMs: 10000,
        retryMaxAttempts: 2,
        uncertainReconcileMs: 5000,
        logger: capturingLogger,
        nowFn: () => tickNowMs
      });

      // Tick 1: dispatches Team 1 case #1 (case #2/#3 held back until case #1 passes) and Team 2 uncertain POST
      await worker.runOnce({ recoverExpired: false });
      expect(createCallsByTeam).toHaveLength(2); // Team 2 POST was NOT retried!

      // Tick 2: transient poll timeout on Team 1 case #1 -> scheduled retry, NOT WRONG_ANSWER
      tickNowMs += 300;
      await worker.runOnce({ recoverExpired: false });
      const midSub1 = await Submission.findById(subFailEarly.id).lean();
      expect(midSub1.status).toBe(SUBMISSION_STATUSES.PROCESSING);
      expect(midSub1.verdict).toBeNull();

      // Tick 3: poll succeeds -> WRONG_ANSWER on case #1 -> case #2/#3 immediately SKIPPED!
      tickNowMs += 300;
      await worker.runOnce({ recoverExpired: false });

      const participantView1 = await getSubmissionForTeam({
        competitionId: competition._id,
        teamId: teams[0].team._id,
        submissionId: subFailEarly.id
      });
      expect(participantView1.status).toBe(SUBMISSION_STATUSES.EXECUTION_COMPLETED);
      expect(participantView1.verdict).toBe(SUBMISSION_VERDICTS.WRONG_ANSWER);
      expect(participantView1.skippedCaseCount).toBe(2);
      expect(participantView1.settlementStatus).toBe(SUBMISSION_SETTLEMENT_STATUSES.PENDING_SETTLEMENT);
      expect(participantView1.sampleResults).toBeUndefined();
      expect(JSON.stringify(participantView1)).not.toContain('SECRET_SOURCE_MARKER_9911');
      expect(JSON.stringify(participantView1)).not.toContain('hidden-runtime-note');

      // Pending reservation survives before settlement, and unrelated submission ID cannot clear it
      const preSettleState = await TeamRoundState.findOne({ teamId: teams[0].team._id }).lean();
      expect(preSettleState.pendingSubmissionId.toString()).toBe(subFailEarly.id);

      await expect(
        settleSubmissionInternal({
          competitionId: competition._id,
          teamId: teams[0].team._id,
          submissionId: new mongoose.Types.ObjectId()
        })
      ).rejects.toMatchObject({ statusCode: 404 });

      // Matching settlement clears pendingSubmissionId once, and second call rejects as already settled
      const settled = await settleSubmissionInternal({
        competitionId: competition._id,
        teamId: teams[0].team._id,
        submissionId: subFailEarly.id
      });
      expect(settled.submission.settlementStatus).toBe(SUBMISSION_SETTLEMENT_STATUSES.SETTLED);
      expect(settled.teamRoundState.pendingSubmissionId).toBeNull();

      await expect(
        settleSubmissionInternal({
          competitionId: competition._id,
          teamId: teams[0].team._id,
          submissionId: subFailEarly.id
        })
      ).rejects.toMatchObject({ statusCode: 409, code: 'SUBMISSION_ALREADY_SETTLED' });

      // Check queue monitoring stats contain no secrets
      const stats = await getQueueMonitoringStats({
        competitionId: competition._id,
        capacityKey: TEST_CAP_KEY,
        maxInFlight: 8,
        judge0Service: mockJudge0,
        nowFn: () => tickNowMs
      });
      expect(stats.awaitingReconciliationSubmissions).toBe(1);
      expect(stats.uncertainExecutionJobs).toBe(1);
      expect(JSON.stringify(stats)).not.toContain('SECRET_SOURCE_MARKER_9911');
      expect(JSON.stringify(logMessages)).not.toContain('SECRET_SOURCE_MARKER_9911');

      // Verify clean worker startup + graceful shutdown preserves subUncertain
      await worker.start();
      expect(worker.isRunning).toBe(true);
      await worker.stop();
      expect(worker.isRunning).toBe(false);
      const stillUncertain = await Submission.findById(subUncertain.id).lean();
      expect(stillUncertain.status).toBe(SUBMISSION_STATUSES.AWAITING_RECONCILIATION);
    });
  }
);
