import crypto from 'node:crypto';
import os from 'node:os';
import {
  claimDuePollingJobs,
  claimNextJobsForDispatch,
  dispatchClaimedJob,
  pollClaimedJob
} from '../modules/execution/executionQueue.service.js';
import { recoverExecutionQueue } from '../modules/execution/executionRecovery.service.js';
import { DEFAULT_EXECUTION_CAPACITY_KEY } from '../modules/submissions/submission.constants.js';

/**
 * Create a durable, lease-fenced Judge0 queue worker integrated with graceful server shutdown.
 */
export function createExecutionWorker({
  judge0Service,
  databaseAdapter = { isReady: () => true },
  capacityKey = DEFAULT_EXECUTION_CAPACITY_KEY,
  maxInFlight = 8,
  pollIntervalMs = 250,
  judge0PollIntervalMs = 750,
  judge0PollTimeoutMs = 60000,
  leaseDurationMs = 30000,
  retryMaxAttempts = 3,
  uncertainReconcileMs = 90000,
  shutdownTimeoutMs = 8000,
  workerId = `${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
  nowFn = () => Date.now(),
  logger
} = {}) {
  let running = false;
  let stopping = false;
  let loopTimer = null;
  let activeTickPromise = null;
  let judge0Healthy = true;

  async function runTick({ recoverExpired = true } = {}) {
    if (!databaseAdapter.isReady()) {
      return { skipped: 'DATABASE_NOT_READY' };
    }

    if (recoverExpired) {
      await recoverExecutionQueue({
        capacityKey,
        maxInFlight,
        uncertainReconcileMs,
        nowFn,
        logger
      });
    }

    if (stopping) {
      return { stopped: true };
    }

    // 1. Poll due jobs that already hold a Judge0 token
    const pollingJobs = await claimDuePollingJobs({
      workerId,
      capacityKey,
      batchLimit: maxInFlight,
      leaseDurationMs,
      nowFn
    });

    let pollInfraFailures = 0;
    let pollSuccesses = 0;

    if (pollingJobs.length > 0 && !stopping) {
      const pollResults = await Promise.all(
        pollingJobs.map((job) =>
          pollClaimedJob({
            job,
            workerId,
            judge0Service,
            pollIntervalMs: judge0PollIntervalMs,
            pollTimeoutMs: judge0PollTimeoutMs,
            retryMaxAttempts,
            nowFn,
            logger
          })
        )
      );
      for (const res of pollResults) {
        if (res.outcome === 'SYSTEM_FAILED' || res.outcome === 'POLL_RETRY_SCHEDULED') {
          pollInfraFailures += 1;
        } else if (res.outcome !== 'STALE_FENCED') {
          pollSuccesses += 1;
        }
      }
    }

    if (stopping) {
      return { polledCount: pollingJobs.length, dispatchedCount: 0 };
    }

    // 2. Fairly claim & dispatch queued jobs up to global maxInFlight
    const dispatchJobs = await claimNextJobsForDispatch({
      workerId,
      capacityKey,
      maxInFlight,
      leaseDurationMs,
      nowFn
    });

    let dispatchInfraFailures = 0;
    let dispatchSuccesses = 0;

    if (dispatchJobs.length > 0) {
      const dispatchResults = await Promise.all(
        dispatchJobs.map((job) =>
          dispatchClaimedJob({
            job,
            workerId,
            judge0Service,
            retryMaxAttempts,
            pollIntervalMs: judge0PollIntervalMs,
            nowFn,
            logger
          })
        )
      );
      for (const res of dispatchResults) {
        if (
          res.outcome === 'SYSTEM_FAILED' ||
          res.outcome === 'REQUEUED' ||
          res.outcome === 'ADMISSION_UNCERTAIN'
        ) {
          dispatchInfraFailures += 1;
        } else if (res.outcome === 'POLLING') {
          dispatchSuccesses += 1;
        }
      }
    }

    // Log connectivity state transitions concisely without per-poll noise
    const hadAnyFailure = pollInfraFailures > 0 || dispatchInfraFailures > 0;
    const hadAnySuccess = pollSuccesses > 0 || dispatchSuccesses > 0;

    if (hadAnyFailure && !hadAnySuccess && judge0Healthy) {
      judge0Healthy = false;
      logger?.warn?.({ workerId }, 'Judge0 temporarily unavailable');
    } else if (hadAnySuccess && !hadAnyFailure && !judge0Healthy) {
      judge0Healthy = true;
      logger?.success?.({ workerId }, 'Judge0 connectivity restored');
    }

    return {
      polledCount: pollingJobs.length,
      dispatchedCount: dispatchJobs.length
    };
  }

  function scheduleNextTick() {
    if (!running || stopping) {
      return;
    }

    loopTimer = setTimeout(async () => {
      loopTimer = null;
      if (!running || stopping) {
        return;
      }

      activeTickPromise = runTick({ recoverExpired: true }).catch((err) => {
        logger?.error?.(
          { err, workerId },
          'Execution worker failed'
        );
      });

      await activeTickPromise;
      activeTickPromise = null;
      scheduleNextTick();
    }, pollIntervalMs);

    loopTimer.unref?.();
  }

  return {
    workerId,

    get isRunning() {
      return running && !stopping;
    },

    async start() {
      if (running) {
        return;
      }
      stopping = false;
      running = true;

      if (databaseAdapter.isReady()) {
        await recoverExecutionQueue({
          capacityKey,
          maxInFlight,
          uncertainReconcileMs,
          nowFn,
          logger,
          emitRecoveryLog: true
        });
      }

      logger?.success?.({ workerId, maxInFlight }, 'Execution worker initialized');
      scheduleNextTick();
    },

    async runOnce({ recoverExpired = true } = {}) {
      if (stopping) {
        return { stopped: true };
      }
      activeTickPromise = runTick({ recoverExpired });
      try {
        return await activeTickPromise;
      } finally {
        activeTickPromise = null;
      }
    },

    async stop({ timeoutMs = shutdownTimeoutMs } = {}) {
      if (!running) {
        return;
      }
      stopping = true;
      if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
      }

      if (activeTickPromise) {
        await Promise.race([
          activeTickPromise.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, timeoutMs))
        ]);
      }

      running = false;
      logger?.info?.({ workerId }, 'Execution worker stopped');
    }
  };
}
