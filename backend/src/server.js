import http from 'node:http';
import { createApp } from './app.js';
import {
  checkTransactionSupport,
  connectDatabase,
  defaultDatabaseAdapter,
  disconnectDatabase
} from './config/database.js';
import { loadEnv } from './config/env.js';
import { createDefaultMongoStore } from './config/session.js';
import { Competition } from './modules/competition/competition.model.js';
import {
  ensureDefaultCompetition,
  reconcileCompetitionDeadline
} from './modules/competition/competition.service.js';
import { FrozenRosterEntry } from './modules/competition/frozenRoster.model.js';
import { TeamRoundState } from './modules/competition/teamRoundState.model.js';
import { ExecutionCapacity } from './modules/execution/executionCapacity.model.js';
import { ExecutionJob } from './modules/execution/executionJob.model.js';
import { Problem } from './modules/problems/problem.model.js';
import { TestCase } from './modules/problems/testCase.model.js';
import { Submission } from './modules/submissions/submission.model.js';
import { Team } from './modules/teams/team.model.js';
import { TeamMembership } from './modules/teams/teamMembership.model.js';
import { User } from './modules/users/user.model.js';
import { createJudge0Service } from './integrations/judge0/judge0.service.js';
import { createExecutionWorker } from './workers/execution.worker.js';
import { createLogger } from './utils/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10000;
const LIFECYCLE_RECONCILE_INTERVAL_MS = 15000;

async function startServer() {
  const env = loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    format: env.LOG_FORMAT
  });

  const startupChecks = [];

  await connectDatabase(env.MONGODB_URI, {
    logger,
    dnsServers: env.MONGODB_DNS_SERVERS,
    allowDnsFallback: env.MONGODB_DNS_FALLBACK,
    silentInitialSuccess: true
  });
  startupChecks.push({ level: 'SUCCESS', message: 'MongoDB connected successfully' });

  try {
    const txStatus = await checkTransactionSupport({ logger, silent: true });
    if (txStatus.supported) {
      startupChecks.push({
        level: 'SUCCESS',
        message: 'Database transactions supported'
      });
    } else {
      startupChecks.push({
        level: 'WARN',
        message: `Database transactions not supported (${txStatus.topology})`
      });
    }
  } catch (err) {
    startupChecks.push({
      level: 'WARN',
      message: `Unable to verify database transactions: ${err?.message || 'unknown error'}`
    });
  }

  const sessionStore = createDefaultMongoStore(env);

  await User.syncIndexes();
  await Competition.syncIndexes();
  await Team.syncIndexes();
  await TeamMembership.syncIndexes();
  await FrozenRosterEntry.syncIndexes();
  await TeamRoundState.syncIndexes();
  await Problem.syncIndexes();
  await TestCase.syncIndexes();
  await Submission.syncIndexes();
  await ExecutionJob.syncIndexes();
  await ExecutionCapacity.syncIndexes();
  await ensureDefaultCompetition();
  await reconcileCompetitionDeadline({ logger });

  const lifecycleReconcileTimer = setInterval(() => {
    void reconcileCompetitionDeadline({ logger }).catch((err) => {
      logger.warn(
        { errorName: err?.name, errorMessage: err?.message },
        'Competition deadline reconciliation check failed'
      );
    });
  }, LIFECYCLE_RECONCILE_INTERVAL_MS);
  lifecycleReconcileTimer.unref();

  const app = createApp({
    env,
    logger,
    database: defaultDatabaseAdapter,
    sessionStore
  });
  startupChecks.push({ level: 'SUCCESS', message: 'Authentication initialized' });

  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const actualPort = server.address()?.port ?? env.PORT;
  startupChecks.push({
    level: 'SUCCESS',
    message: `Server started on port ${actualPort}`
  });

  logger.printStartupSummary({
    environment: env.NODE_ENV,
    port: actualPort,
    checks: startupChecks
  });

  let executionWorker = null;
  if (env.EXECUTION_WORKER_ENABLED && env.JUDGE0_AUTH_TOKEN) {
    const judge0Service = createJudge0Service({ config: env });
    executionWorker = createExecutionWorker({
      judge0Service,
      databaseAdapter: defaultDatabaseAdapter,
      maxInFlight: env.JUDGE0_MAX_IN_FLIGHT,
      pollIntervalMs: env.EXECUTION_WORKER_POLL_INTERVAL_MS,
      judge0PollIntervalMs: env.JUDGE0_POLL_INTERVAL_MS,
      judge0PollTimeoutMs: env.JUDGE0_POLL_TIMEOUT_MS,
      leaseDurationMs: env.EXECUTION_LEASE_DURATION_MS,
      retryMaxAttempts: env.EXECUTION_RETRY_MAX_ATTEMPTS,
      uncertainReconcileMs: env.EXECUTION_UNCERTAIN_RECONCILE_MS,
      shutdownTimeoutMs: env.EXECUTION_SHUTDOWN_TIMEOUT_MS,
      logger
    });
    await executionWorker.start();
  } else if (env.EXECUTION_WORKER_ENABLED && !env.JUDGE0_AUTH_TOKEN) {
    logger.warn('Execution worker skipped: JUDGE0_AUTH_TOKEN is not configured');
  }

  let isShuttingDown = false;

  async function shutdown(signal) {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    logger.info({ signal }, `Shutdown signal received (${signal}), closing server`);

    const forceTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
      clearInterval(lifecycleReconcileTimer);

      if (executionWorker) {
        await executionWorker.stop({ timeoutMs: env.EXECUTION_SHUTDOWN_TIMEOUT_MS });
      }

      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
        server.closeIdleConnections?.();
      });

      if (typeof sessionStore.close === 'function') {
        await sessionStore.close();
      }

      await disconnectDatabase({ logger });
      clearTimeout(forceTimer);
      logger.success('Graceful shutdown completed');
      process.exitCode = 0;
    } catch (err) {
      clearTimeout(forceTimer);
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
}

startServer().catch((err) => {
  console.error(`[ERROR] Failed to start backend server: ${err.message}`);
  process.exit(1);
});
