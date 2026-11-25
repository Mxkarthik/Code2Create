import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { loadEnv } from '../src/config/env.js';
import { createJudge0Service } from '../src/integrations/judge0/judge0.service.js';
import { COMPETITION_STATUSES, Competition } from '../src/modules/competition/competition.model.js';
import { FrozenRosterEntry } from '../src/modules/competition/frozenRoster.model.js';
import { TeamRoundState } from '../src/modules/competition/teamRoundState.model.js';
import { ExecutionCapacity } from '../src/modules/execution/executionCapacity.model.js';
import { ExecutionJob } from '../src/modules/execution/executionJob.model.js';
import { getQueueMonitoringStats } from '../src/modules/execution/executionQueue.service.js';
import { recoverExecutionQueue } from '../src/modules/execution/executionRecovery.service.js';
import { Problem, PROBLEM_STATUSES } from '../src/modules/problems/problem.model.js';
import { buildProblemExecutionLimits } from '../src/modules/problems/language.config.js';
import { TEST_CASE_TYPES, TestCase } from '../src/modules/problems/testCase.model.js';
import {
  SUBMISSION_MODES,
  SUBMISSION_STATUSES,
  SUBMISSION_VERDICTS
} from '../src/modules/submissions/submission.constants.js';
import { Submission } from '../src/modules/submissions/submission.model.js';
import {
  admitSubmission,
  getSubmissionForTeam,
  settleSubmissionInternal
} from '../src/modules/submissions/submission.service.js';
import { TEAM_STATUSES, Team } from '../src/modules/teams/team.model.js';
import { USER_ROLES, User } from '../src/modules/users/user.model.js';
import { formatSeverityBadge, resolveColorSupport } from '../src/utils/logger.js';
import { createExecutionWorker } from '../src/workers/execution.worker.js';

const SMOKE_COMP_SLUG = 'code-rush-phase07-live-smoke';
const SMOKE_CAP_KEY = 'phase07-live-smoke-cap';
const useColor = resolveColorSupport(process.stdout);

function logLine(kind, msg) {
  console.log(`${formatSeverityBadge(kind, useColor)} ${msg}`);
}

function extractDbName(uri) {
  try {
    return new URL(uri).pathname.replace(/^\//, '') || 'test';
  } catch {
    return '';
  }
}

async function cleanupSmokeFixtures() {
  const comps = await Competition.find({ slug: SMOKE_COMP_SLUG }).select('_id').lean();
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
  await ExecutionCapacity.deleteMany({ _id: SMOKE_CAP_KEY });
  await User.deleteMany({ googleSub: /^smoke-p7-/ });
}

async function waitForSubmissionTerminal({ submissionId, timeoutMs = 45000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const doc = await Submission.findById(submissionId).lean();
    if (
      doc &&
      (doc.status === SUBMISSION_STATUSES.EXECUTION_COMPLETED ||
        doc.status === SUBMISSION_STATUSES.SYSTEM_FAILED)
    ) {
      return doc;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for submission ${submissionId}`);
}

async function main() {
  const totalStartMs = Date.now();
  console.log('CODE 2 CREATE — PERSISTENT QUEUE + LIVE JUDGE0 SMOKE TEST');
  console.log('-----------------------------------------------------------');

  const env = loadEnv();
  if (!env.MONGODB_TEST_URI || extractDbName(env.MONGODB_TEST_URI) !== 'code2create_test') {
    logLine('ERROR', 'MONGODB_TEST_URI pointing to code2create_test is required for queue:verify');
    process.exit(1);
  }

  const judge0Service = createJudge0Service({ config: env });
  const avail = await judge0Service.checkAvailability();
  if (!avail.available) {
    logLine('ERROR', `Judge0 unavailable (${avail.errorCode}): start IAP tunnel before queue:verify`);
    process.exit(1);
  }
  logLine('SUCCESS', `Judge0 reachable (CE ${avail.version}, maxInFlight=${env.JUDGE0_MAX_IN_FLIGHT})`);

  await connectDatabase(env.MONGODB_TEST_URI, {
    dnsServers: env.MONGODB_DNS_SERVERS,
    allowDnsFallback: env.MONGODB_DNS_FALLBACK,
    silentInitialSuccess: true
  });

  await Competition.syncIndexes();
  await Submission.syncIndexes();
  await ExecutionJob.syncIndexes();
  await ExecutionCapacity.syncIndexes();

  try {
    await cleanupSmokeFixtures();

    const nowMs = Date.now();
    const comp = await Competition.create({
      slug: SMOKE_COMP_SLUG,
      name: 'Phase 07 Live Smoke',
      status: COMPETITION_STATUSES.LIVE,
      startedAt: new Date(nowMs - 30_000),
      endsAt: new Date(nowMs + 1_800_000)
    });

    const admin = await User.create({
      googleSub: 'smoke-p7-admin',
      email: 'smoke-p7-admin@example.com',
      name: 'Smoke Admin',
      role: USER_ROLES.ADMIN,
      isActive: true
    });

    const problem = await Problem.create({
      competitionId: comp._id,
      title: 'Smoke Sum',
      slug: 'smoke-sum',
      difficulty: 'EASY',
      statement: 'Print a + b',
      inputFormat: 'Two integers',
      outputFormat: 'Integer sum',
      constraints: '1..1000',
      allowedLanguages: ['C', 'CPP', 'PYTHON', 'JAVA'],
      executionLimits: buildProblemExecutionLimits(['C', 'CPP', 'PYTHON', 'JAVA']),
      status: PROBLEM_STATUSES.PUBLISHED,
      displayOrder: 1,
      version: 1,
      createdBy: admin._id,
      updatedBy: admin._id,
      publishedAt: new Date(nowMs)
    });

    await TestCase.create({
      competitionId: comp._id,
      problemId: problem._id,
      type: TEST_CASE_TYPES.SAMPLE,
      input: '3 4\n',
      expectedOutput: '7\n',
      explanation: '3+4=7',
      displayOrder: 1
    });

    for (let i = 1; i <= 3; i += 1) {
      await TestCase.create({
        competitionId: comp._id,
        problemId: problem._id,
        type: TEST_CASE_TYPES.HIDDEN,
        input: `${i * 5} ${i * 2}\n`,
        expectedOutput: `${i * 7}\n`,
        displayOrder: i
      });
    }

    const teams = [];
    for (let t = 1; t <= 3; t += 1) {
      const user = await User.create({
        googleSub: `smoke-p7-u${t}`,
        email: `smoke-p7-u${t}@example.com`,
        name: `Smoke User ${t}`,
        role: USER_ROLES.PARTICIPANT,
        isActive: true
      });
      const team = await Team.create({
        competitionId: comp._id,
        name: `Smoke Team ${t}`,
        normalizedName: `smoke team ${t}`,
        joinCode: `SMK0000${t}`,
        leaderId: user._id,
        memberCount: 1,
        maxCapacity: 2,
        status: TEAM_STATUSES.READY,
        round1Rank: t,
        round1RankedTeamCount: 3
      });
      await FrozenRosterEntry.create({
        competitionId: comp._id,
        teamId: team._id,
        teamName: team.name,
        frozenLeaderId: user._id,
        frozenMemberIds: [user._id],
        round1Rank: t,
        round1RankedTeamCount: 3,
        headStartDistance: 20,
        rosterVersion: 1,
        lockedAt: new Date(nowMs)
      });
      const attemptId = new mongoose.Types.ObjectId();
      await TeamRoundState.create({
        competitionId: comp._id,
        teamId: team._id,
        frozenLeaderId: user._id,
        frozenMemberIds: [user._id],
        round1Rank: t,
        headStartDistance: 20,
        totalDistance: 20,
        activeChallengeAttemptId: attemptId
      });
      teams.push({ user, team, attemptId });
    }

    // Track peak active capacity seen during execution
    let peakActiveCap = 0;
    const monitorTimer = setInterval(async () => {
      const cap = await ExecutionCapacity.findById(SMOKE_CAP_KEY).lean().catch(() => null);
      if (cap) {
        peakActiveCap = Math.max(peakActiveCap, cap.activeJobIds?.length ?? 0);
      }
    }, 100);

    const worker1 = createExecutionWorker({
      judge0Service,
      capacityKey: SMOKE_CAP_KEY,
      maxInFlight: env.JUDGE0_MAX_IN_FLIGHT,
      pollIntervalMs: 150,
      judge0PollIntervalMs: 350
    });

    // 1. Admit valid Python RUN + idempotency duplicate check
    const admitT0 = Date.now();
    const runRes = await admitSubmission({
      user: teams[0].user,
      teamId: teams[0].team._id,
      challengeAttemptId: teams[0].attemptId,
      problemId: problem._id,
      mode: SUBMISSION_MODES.RUN,
      language: 'PYTHON',
      sourceCode: 'print(sum(map(int, input().split())))',
      idempotencyKey: 'smoke-run-py-1',
      competitionSlug: SMOKE_COMP_SLUG,
      capacityKey: SMOKE_CAP_KEY
    });
    const admitLatencyMs = Date.now() - admitT0;

    const dupRes = await admitSubmission({
      user: teams[0].user,
      teamId: teams[0].team._id,
      challengeAttemptId: teams[0].attemptId,
      problemId: problem._id,
      mode: SUBMISSION_MODES.RUN,
      language: 'PYTHON',
      sourceCode: 'print(sum(map(int, input().split())))',
      idempotencyKey: 'smoke-run-py-1',
      competitionSlug: SMOKE_COMP_SLUG,
      capacityKey: SMOKE_CAP_KEY
    });
    if (!dupRes.deduplicated || dupRes.submission.id !== runRes.submission.id) {
      throw new Error('Idempotency check failed on duplicate admission');
    }

    // 2. Mixed-language multi-team submissions (Java ACCEPTED SUBMIT + C++ WRONG_ANSWER SUBMIT)
    const javaSubmit = await admitSubmission({
      user: teams[1].user,
      teamId: teams[1].team._id,
      challengeAttemptId: teams[1].attemptId,
      problemId: problem._id,
      mode: SUBMISSION_MODES.SUBMIT,
      language: 'JAVA',
      sourceCode:
        'import java.util.*; public class Main { public static void main(String[] args) { Scanner sc = new Scanner(System.in); System.out.println(sc.nextInt() + sc.nextInt()); } }',
      idempotencyKey: 'smoke-submit-java-1',
      competitionSlug: SMOKE_COMP_SLUG,
      capacityKey: SMOKE_CAP_KEY
    });

    const cppWaSubmit = await admitSubmission({
      user: teams[2].user,
      teamId: teams[2].team._id,
      challengeAttemptId: teams[2].attemptId,
      problemId: problem._id,
      mode: SUBMISSION_MODES.SUBMIT,
      language: 'CPP',
      sourceCode: '#include <iostream>\nint main(){ std::cout << 999 << std::endl; return 0; }',
      idempotencyKey: 'smoke-submit-cpp-wa',
      competitionSlug: SMOKE_COMP_SLUG,
      capacityKey: SMOKE_CAP_KEY
    });

    // Run ONE worker tick to dispatch initial jobs & persist Judge0 tokens, then simulate restart!
    await worker1.runOnce({ recoverExpired: false });
    const persistedTokensBeforeRestart = await ExecutionJob.find({
      competitionId: comp._id,
      judge0Token: { $ne: null }
    })
      .select('+judge0Token')
      .lean();

    if (persistedTokensBeforeRestart.length === 0) {
      throw new Error('Expected persisted Judge0 tokens after initial dispatch tick');
    }
    logLine(
      'INFO',
      `Persisted ${persistedTokensBeforeRestart.length} Judge0 tokens before worker restart test (admission=${admitLatencyMs}ms)`
    );

    // Recover queue into worker 2 and run until all 3 complete
    const worker2 = createExecutionWorker({
      judge0Service,
      capacityKey: SMOKE_CAP_KEY,
      maxInFlight: env.JUDGE0_MAX_IN_FLIGHT,
      pollIntervalMs: 150,
      judge0PollIntervalMs: 350
    });
    await worker2.start();

    const [donePy, doneJava, doneCpp] = await Promise.all([
      waitForSubmissionTerminal({ submissionId: runRes.submission.id }),
      waitForSubmissionTerminal({ submissionId: javaSubmit.submission.id }),
      waitForSubmissionTerminal({ submissionId: cppWaSubmit.submission.id })
    ]);

    await worker2.stop();

    const postRestartTokenDoc = await ExecutionJob.findById(persistedTokensBeforeRestart[0]._id)
      .select('+judge0Token')
      .lean();
    if (postRestartTokenDoc?.judge0Token !== persistedTokensBeforeRestart[0].judge0Token) {
      throw new Error('Persisted Judge0 token changed unexpectedly across worker restart');
    }

    if (donePy.verdict !== SUBMISSION_VERDICTS.ACCEPTED) {
      throw new Error(`Expected Python RUN ACCEPTED, got ${donePy.verdict}`);
    }
    if (doneJava.verdict !== SUBMISSION_VERDICTS.ACCEPTED || doneJava.passedCaseCount !== 3) {
      throw new Error(`Expected Java SUBMIT 3/3 ACCEPTED, got ${doneJava.verdict} (${doneJava.passedCaseCount})`);
    }
    if (doneCpp.verdict !== SUBMISSION_VERDICTS.WRONG_ANSWER || doneCpp.skippedCaseCount < 1) {
      throw new Error(`Expected C++ SUBMIT WRONG_ANSWER with skipped cases, got ${doneCpp.verdict}`);
    }

    // Test Compilation Error after settling Team 0 cleanly
    await settleSubmissionInternal({
      competitionId: comp._id,
      teamId: teams[0].team._id,
      submissionId: runRes.submission.id
    });
    const ceRes = await admitSubmission({
      user: teams[0].user,
      teamId: teams[0].team._id,
      challengeAttemptId: teams[0].attemptId,
      problemId: problem._id,
      mode: SUBMISSION_MODES.SUBMIT,
      language: 'C',
      sourceCode: 'int main(void) { broken_syntax }',
      idempotencyKey: 'smoke-submit-c-ce',
      competitionSlug: SMOKE_COMP_SLUG,
      capacityKey: SMOKE_CAP_KEY
    });

    const worker3 = createExecutionWorker({
      judge0Service,
      capacityKey: SMOKE_CAP_KEY,
      maxInFlight: env.JUDGE0_MAX_IN_FLIGHT,
      pollIntervalMs: 150,
      judge0PollIntervalMs: 350
    });
    await worker3.start();
    const doneCe = await waitForSubmissionTerminal({ submissionId: ceRes.submission.id });
    await worker3.stop();

    clearInterval(monitorTimer);

    if (doneCe.verdict !== SUBMISSION_VERDICTS.COMPILATION_ERROR) {
      throw new Error(`Expected COMPILATION_ERROR, got ${doneCe.verdict}`);
    }

    const safeView = await getSubmissionForTeam({
      competitionId: comp._id,
      teamId: teams[1].team._id,
      submissionId: javaSubmit.submission.id
    });
    if (JSON.stringify(safeView).includes('Scanner')) {
      throw new Error('Participant serializer leaked sourceCode');
    }

    const stats = await getQueueMonitoringStats({
      competitionId: comp._id,
      capacityKey: SMOKE_CAP_KEY,
      maxInFlight: env.JUDGE0_MAX_IN_FLIGHT
    });
    if (peakActiveCap > env.JUDGE0_MAX_IN_FLIGHT || stats.outstandingJudge0Jobs !== 0) {
      throw new Error(
        `Capacity check failed: peak=${peakActiveCap}, finalOutstanding=${stats.outstandingJudge0Jobs}`
      );
    }

    const recoveryFinal = await recoverExecutionQueue({
      capacityKey: SMOKE_CAP_KEY,
      maxInFlight: env.JUDGE0_MAX_IN_FLIGHT
    });

    const totalDurationMs = Date.now() - totalStartMs;
    logLine('SUCCESS', `Python RUN passed (admit=${admitLatencyMs}ms), Java SUBMIT 3/3 ACCEPTED`);
    logLine('SUCCESS', `C++ WRONG_ANSWER (skipped=${doneCpp.skippedCaseCount}), C COMPILATION_ERROR`);
    logLine(
      'SUCCESS',
      `Worker restart recovery & capacity verified (peakInFlight=${peakActiveCap}/${env.JUDGE0_MAX_IN_FLIGHT}, finalOutstanding=${recoveryFinal.activeCapacityCount}, total=${totalDurationMs}ms)`
    );
  } finally {
    await cleanupSmokeFixtures();
    await disconnectDatabase();
  }
}

await main();
