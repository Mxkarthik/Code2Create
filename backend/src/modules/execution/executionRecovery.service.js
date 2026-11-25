import {
  ACTIVE_SUBMISSION_STATUSES,
  DEFAULT_EXECUTION_CAPACITY_KEY,
  EXECUTION_JOB_STATUSES,
  SUBMISSION_VERDICTS
} from '../submissions/submission.constants.js';
import { Submission } from '../submissions/submission.model.js';
import { ExecutionJob } from './executionJob.model.js';
import { reconcileSubmissionProgress } from './executionQueue.service.js';
import { reconcileCapacityWithJobs, releaseCapacitySlot } from './executionScheduler.js';

/**
 * Recover persistent execution queue state safely on startup and periodic ticks:
 * 1. Expired DISPATCHING leases (without saved token) -> ADMISSION_UNCERTAIN (never re-POSTs blindly).
 * 2. Expired SUBMITTED/POLLING leases (with saved token) -> release lease to resume polling immediately.
 * 3. Aged ADMISSION_UNCERTAIN jobs past uncertainReconcileMs -> conservative SYSTEM_FAILED + release capacity.
 * 4. Reconstruct ExecutionCapacity.activeJobIds from authoritative ExecutionJob states.
 * 5. Finalize any active Submissions whose jobs already finished before a crash.
 */
export async function recoverExecutionQueue({
  capacityKey = DEFAULT_EXECUTION_CAPACITY_KEY,
  maxInFlight = 8,
  uncertainReconcileMs = 90000,
  nowFn = () => Date.now(),
  logger,
  emitRecoveryLog = false
} = {}) {
  const nowMs = nowFn();
  const nowDate = new Date(nowMs);
  const touchedSubmissionIds = new Set();

  // 1. Expired DISPATCHING leases without a saved token -> ADMISSION_UNCERTAIN (no blind duplicate POST)
  const expiredDispatchJobs = await ExecutionJob.find({
    capacityKey,
    status: EXECUTION_JOB_STATUSES.DISPATCHING,
    leaseExpiresAt: { $lte: nowDate }
  })
    .select('_id submissionId fencingVersion judge0Token')
    .limit(100)
    .lean();

  let movedToUncertain = 0;
  let recoveredPollingJobs = 0;

  for (const job of expiredDispatchJobs) {
    // If a token exists despite status=DISPATCHING, safely resume polling instead of marking uncertain.
    if (job.judge0Token) {
      const resumed = await ExecutionJob.findOneAndUpdate(
        {
          _id: job._id,
          status: EXECUTION_JOB_STATUSES.DISPATCHING,
          fencingVersion: job.fencingVersion
        },
        {
          $set: {
            status: EXECUTION_JOB_STATUSES.POLLING,
            leaseOwner: null,
            leaseExpiresAt: null,
            nextPollAt: nowDate
          },
          $inc: { fencingVersion: 1 }
        }
      );
      if (resumed) {
        recoveredPollingJobs += 1;
        touchedSubmissionIds.add(job.submissionId.toString());
      }
      continue;
    }

    const updated = await ExecutionJob.findOneAndUpdate(
      {
        _id: job._id,
        status: EXECUTION_JOB_STATUSES.DISPATCHING,
        fencingVersion: job.fencingVersion
      },
      {
        $set: {
          status: EXECUTION_JOB_STATUSES.ADMISSION_UNCERTAIN,
          uncertainSince: nowDate,
          leaseOwner: null,
          leaseExpiresAt: null,
          sanitizedSystemError: {
            code: 'WORKER_CRASHED_DURING_DISPATCH',
            message: 'Worker lease expired during submission dispatch; admission state is uncertain'
          }
        },
        $inc: { fencingVersion: 1 }
      }
    );

    if (updated) {
      movedToUncertain += 1;
      touchedSubmissionIds.add(job.submissionId.toString());
    }
  }

  // 2. Expired SUBMITTED / POLLING leases -> release lease so next worker resumes polling existing token
  const expiredPollJobs = await ExecutionJob.find({
    capacityKey,
    status: { $in: [EXECUTION_JOB_STATUSES.SUBMITTED, EXECUTION_JOB_STATUSES.POLLING] },
    leaseOwner: { $ne: null },
    leaseExpiresAt: { $lte: nowDate }
  })
    .select('_id submissionId fencingVersion')
    .limit(100)
    .lean();

  for (const job of expiredPollJobs) {
    const recovered = await ExecutionJob.findOneAndUpdate(
      {
        _id: job._id,
        status: { $in: [EXECUTION_JOB_STATUSES.SUBMITTED, EXECUTION_JOB_STATUSES.POLLING] },
        fencingVersion: job.fencingVersion
      },
      {
        $set: {
          leaseOwner: null,
          leaseExpiresAt: null,
          nextPollAt: nowDate
        },
        $inc: { fencingVersion: 1 }
      }
    );
    if (recovered) {
      recoveredPollingJobs += 1;
      touchedSubmissionIds.add(job.submissionId.toString());
    }
  }

  // 3. Aged ADMISSION_UNCERTAIN jobs past conservative timeout -> SYSTEM_FAILED + free capacity
  const uncertainCutoff = new Date(nowMs - uncertainReconcileMs);
  const timedOutUncertain = await ExecutionJob.find({
    capacityKey,
    status: EXECUTION_JOB_STATUSES.ADMISSION_UNCERTAIN,
    uncertainSince: { $lte: uncertainCutoff }
  })
    .select('_id submissionId fencingVersion capacityKey')
    .limit(100)
    .lean();

  let reconciledUncertainTimeout = 0;
  for (const job of timedOutUncertain) {
    const failed = await ExecutionJob.findOneAndUpdate(
      {
        _id: job._id,
        status: EXECUTION_JOB_STATUSES.ADMISSION_UNCERTAIN,
        fencingVersion: job.fencingVersion
      },
      {
        $set: {
          status: EXECUTION_JOB_STATUSES.SYSTEM_FAILED,
          completedAt: nowDate,
          resultVerdict: SUBMISSION_VERDICTS.SYSTEM_ERROR,
          sanitizedSystemError: {
            code: 'JUDGE0_ADMISSION_UNRESOLVED_TIMEOUT',
            message: 'Uncertain Judge0 submission admission timed out under conservative reconciliation'
          }
        },
        $inc: { fencingVersion: 1 }
      }
    );
    if (failed) {
      await releaseCapacitySlot({ capacityKey: job.capacityKey, jobId: job._id });
      reconciledUncertainTimeout += 1;
      touchedSubmissionIds.add(job.submissionId.toString());
    }
  }

  // 4. Reconcile global ExecutionCapacity with authoritative active jobs
  const activeCapacityCount = await reconcileCapacityWithJobs({ capacityKey, maxInFlight });

  // 5. Reconcile unfinished active submissions (catches crash between job completion & aggregation)
  const pendingActiveSubs = await Submission.find({
    status: { $in: ACTIVE_SUBMISSION_STATUSES }
  })
    .select('_id')
    .limit(100)
    .lean();

  for (const sub of pendingActiveSubs) {
    touchedSubmissionIds.add(sub._id.toString());
  }

  let reconciledSubmissions = 0;
  for (const subId of touchedSubmissionIds) {
    const before = await Submission.findById(subId).select('status').lean();
    const after = await reconcileSubmissionProgress({ submissionId: subId, nowFn, logger });
    if (before && after && before.status !== after.status) {
      reconciledSubmissions += 1;
    }
  }

  const summary = {
    movedToUncertain,
    recoveredPollingJobs,
    reconciledUncertainTimeout,
    activeCapacityCount,
    reconciledSubmissions
  };

  if (emitRecoveryLog) {
    logger?.info?.(summary, 'Execution queue recovered');
  }

  return summary;
}
