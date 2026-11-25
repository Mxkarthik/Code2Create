import {
  ACTIVE_SUBMISSION_STATUSES,
  CAPACITY_OCCUPYING_JOB_STATUSES,
  DEFAULT_EXECUTION_CAPACITY_KEY,
  EXECUTION_JOB_STATUSES,
  SUBMISSION_MODES,
  SUBMISSION_STATUSES
} from '../submissions/submission.constants.js';
import { Submission } from '../submissions/submission.model.js';
import { ExecutionCapacity } from './executionCapacity.model.js';
import { ExecutionJob } from './executionJob.model.js';

export async function ensureExecutionCapacityDoc({
  capacityKey = DEFAULT_EXECUTION_CAPACITY_KEY,
  maxInFlight = 8
} = {}) {
  try {
    return await ExecutionCapacity.findOneAndUpdate(
      { _id: capacityKey },
      {
        $setOnInsert: {
          _id: capacityKey,
          maxInFlight,
          activeJobIds: []
        }
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).lean();
  } catch (err) {
    if (err?.code === 11000) {
      return ExecutionCapacity.findById(capacityKey).lean();
    }
    throw err;
  }
}

export async function reserveCapacitySlot({
  capacityKey = DEFAULT_EXECUTION_CAPACITY_KEY,
  jobId,
  maxInFlight = 8,
  session
}) {
  const updated = await ExecutionCapacity.findOneAndUpdate(
    {
      _id: capacityKey,
      $expr: { $lt: [{ $size: '$activeJobIds' }, maxInFlight] }
    },
    {
      $addToSet: { activeJobIds: jobId },
      $set: { maxInFlight }
    },
    {
      ...(session ? { session } : {}),
      returnDocument: 'after'
    }
  ).lean();

  return Boolean(updated);
}

export async function releaseCapacitySlot({
  capacityKey = DEFAULT_EXECUTION_CAPACITY_KEY,
  jobId,
  session
}) {
  await ExecutionCapacity.updateOne(
    { _id: capacityKey },
    { $pull: { activeJobIds: jobId } },
    session ? { session } : undefined
  );
}

export async function reconcileCapacityWithJobs({
  capacityKey = DEFAULT_EXECUTION_CAPACITY_KEY,
  maxInFlight = 8
} = {}) {
  await ensureExecutionCapacityDoc({ capacityKey, maxInFlight });

  const activeJobs = await ExecutionJob.find({
    capacityKey,
    status: { $in: CAPACITY_OCCUPYING_JOB_STATUSES }
  })
    .select('_id')
    .lean();

  const activeJobIds = activeJobs.map((j) => j._id);

  await ExecutionCapacity.updateOne(
    { _id: capacityKey },
    {
      $set: {
        maxInFlight,
        activeJobIds
      }
    }
  );

  return activeJobIds.length;
}

/**
 * Select next QUEUED jobs to dispatch while respecting global maxInFlight and per-team fairness.
 *
 * Policy:
 * - Pass 1 (Fairness): Oldest-recently-served round-robin across teams that have 0 in-flight jobs.
 *   Guarantees Team A with 8 cases never starves Team B's first case.
 * - Pass 2 (Idle Utilization): If global capacity still has headroom, grant bounded additional slots
 *   round-robin up to perTeamBurstCap (for RUN or submissions where >= 1 case already passed,
 *   avoiding unnecessary speculative jobs if case #1 is a COMPILATION_ERROR).
 */
export async function selectNextFairQueuedJobs({
  capacityKey = DEFAULT_EXECUTION_CAPACITY_KEY,
  maxInFlight = 8,
  nowMs = Date.now(),
  maxTeamBurstCap = 4
} = {}) {
  const capacityDoc = await ensureExecutionCapacityDoc({ capacityKey, maxInFlight });
  const occupiedCount = capacityDoc?.activeJobIds?.length ?? 0;
  let availableSlots = Math.max(0, maxInFlight - occupiedCount);

  if (availableSlots <= 0) {
    return [];
  }

  // O(maxInFlight) small query to track current in-flight jobs per team
  const activeJobs = await ExecutionJob.find({
    capacityKey,
    status: { $in: CAPACITY_OCCUPYING_JOB_STATUSES }
  })
    .select('teamId submissionId')
    .limit(Math.max(1, maxInFlight * 2))
    .lean();

  const inFlightByTeam = new Map();
  for (const job of activeJobs) {
    const key = job.teamId.toString();
    inFlightByTeam.set(key, (inFlightByTeam.get(key) ?? 0) + 1);
  }

  // Bounded query over active submissions (max 50 competing teams => <= 50 active submissions)
  const activeSubmissions = await Submission.find({
    status: { $in: [SUBMISSION_STATUSES.QUEUED, SUBMISSION_STATUSES.PROCESSING] }
  })
    .sort({ lastDispatchedAt: 1, admittedAt: 1, _id: 1 })
    .limit(100)
    .lean();

  if (activeSubmissions.length === 0) {
    return [];
  }

  const nowDate = new Date(nowMs);
  const queuedJobsBySubmission = new Map();

  // Fetch ready QUEUED jobs bounded by submission list (each submission typically <= 10 cases)
  const submissionIds = activeSubmissions.map((s) => s._id);
  const readyQueuedJobs = await ExecutionJob.find({
    submissionId: { $in: submissionIds },
    capacityKey,
    status: EXECUTION_JOB_STATUSES.QUEUED,
    $or: [{ nextPollAt: null }, { nextPollAt: { $lte: nowDate } }]
  })
    .sort({ testCaseOrder: 1, _id: 1 })
    .limit(Math.max(50, maxInFlight * 10))
    .lean();

  for (const job of readyQueuedJobs) {
    const subKey = job.submissionId.toString();
    if (!queuedJobsBySubmission.has(subKey)) {
      queuedJobsBySubmission.set(subKey, []);
    }
    queuedJobsBySubmission.get(subKey).push(job);
  }

  const selected = [];
  const selectedIds = new Set();

  // Pass 1: Strict 1-per-team round-robin across idle teams first
  for (const sub of activeSubmissions) {
    if (availableSlots <= 0) {
      break;
    }
    const teamKey = sub.teamId.toString();
    if ((inFlightByTeam.get(teamKey) ?? 0) > 0) {
      continue;
    }

    const candidates = queuedJobsBySubmission.get(sub._id.toString()) ?? [];
    const nextJob = candidates.find((j) => !selectedIds.has(j._id.toString()));
    if (!nextJob) {
      continue;
    }

    selected.push(nextJob);
    selectedIds.add(nextJob._id.toString());
    inFlightByTeam.set(teamKey, (inFlightByTeam.get(teamKey) ?? 0) + 1);
    availableSlots -= 1;
  }

  // Pass 2: Utilize remaining idle Judge0 slots up to bounded per-team burst cap
  const effectiveBurstCap = Math.max(1, Math.min(maxTeamBurstCap, maxInFlight));
  let madeProgress = true;
  while (availableSlots > 0 && madeProgress) {
    madeProgress = false;
    for (const sub of activeSubmissions) {
      if (availableSlots <= 0) {
        break;
      }

      const canParallelize =
        sub.mode === SUBMISSION_MODES.RUN ||
        sub.passedCaseCount >= 1 ||
        sub.totalCaseCount <= 1;
      if (!canParallelize) {
        continue;
      }

      const teamKey = sub.teamId.toString();
      if ((inFlightByTeam.get(teamKey) ?? 0) >= effectiveBurstCap) {
        continue;
      }

      const candidates = queuedJobsBySubmission.get(sub._id.toString()) ?? [];
      const nextJob = candidates.find((j) => !selectedIds.has(j._id.toString()));
      if (!nextJob) {
        continue;
      }

      selected.push(nextJob);
      selectedIds.add(nextJob._id.toString());
      inFlightByTeam.set(teamKey, (inFlightByTeam.get(teamKey) ?? 0) + 1);
      availableSlots -= 1;
      madeProgress = true;
    }
  }

  void ACTIVE_SUBMISSION_STATUSES;
  return selected;
}
