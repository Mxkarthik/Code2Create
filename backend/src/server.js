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
import { createLogger } from './utils/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10000;

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
