import dns from 'node:dns';
import mongoose from 'mongoose';
import { LOG_FORMATS, sanitizeConnectionString } from '../utils/logger.js';

const DEFAULT_CONNECT_OPTIONS = Object.freeze({
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  maxPoolSize: 25
});

const PUBLIC_DNS_FALLBACK_SERVERS = Object.freeze(['1.1.1.1', '8.8.8.8']);

const READY_STATE_LABELS = Object.freeze({
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting'
});

let listenersAttached = false;
let hasEstablishedConnection = false;
let isIntentionalDisconnect = false;
let activeLogger;

function attachConnectionListeners() {
  if (listenersAttached) {
    return;
  }

  mongoose.connection.on('disconnected', () => {
    if (!hasEstablishedConnection || isIntentionalDisconnect) {
      return;
    }
    activeLogger?.warn('MongoDB connection interrupted');
  });

  mongoose.connection.on('reconnected', () => {
    if (!hasEstablishedConnection) {
      return;
    }
    if (typeof activeLogger?.success === 'function') {
      activeLogger.success('MongoDB reconnected');
    } else {
      activeLogger?.info('MongoDB reconnected');
    }
  });

  mongoose.connection.on('error', (err) => {
    if (!hasEstablishedConnection) {
      return;
    }
    activeLogger?.error(
      { errorName: err?.name, errorMessage: err?.message },
      'MongoDB connection error'
    );
  });

  listenersAttached = true;
}

/**
 * Connect to MongoDB with bounded timeouts, strict TLS defaults, and clean lifecycle logs.
 * Recoverable Windows c-ares SRV refusals emit at most one concise warning when fallback is enabled.
 */
export async function connectDatabase(
  uri,
  {
    logger,
    options = {},
    dnsServers = [],
    allowDnsFallback = process.env.NODE_ENV !== 'production',
    silentInitialSuccess = false
  } = {}
) {
  if (!uri || typeof uri !== 'string') {
    throw new Error('MongoDB connection URI is required');
  }

  activeLogger = logger;
  isIntentionalDisconnect = false;
  attachConnectionListeners();

  if (Array.isArray(dnsServers) && dnsServers.length > 0) {
    dns.setServers(dnsServers);
    if (logger?.format && logger.format !== LOG_FORMATS.MINIMAL) {
      logger.info({ dnsServerCount: dnsServers.length }, 'Configured custom MongoDB DNS resolvers');
    }
  }

  const sanitizedUri = sanitizeConnectionString(uri);
  if (logger?.format && logger.format !== LOG_FORMATS.MINIMAL) {
    logger.info({ target: sanitizedUri }, 'Connecting to MongoDB');
  }

  const connectOptions = {
    ...DEFAULT_CONNECT_OPTIONS,
    ...options
  };

  try {
    await mongoose.connect(uri, connectOptions);
    hasEstablishedConnection = true;

    if (!silentInitialSuccess) {
      const logMeta = {
        target: sanitizedUri,
        database: mongoose.connection.name || undefined
      };
      if (typeof logger?.success === 'function') {
        logger.success(logMeta, 'MongoDB connected successfully');
      } else {
        logger?.info(logMeta, 'MongoDB connected successfully');
      }
    }

    return getDatabaseStatus();
  } catch (err) {
    const isLocalhostSrvRefusal =
      allowDnsFallback === true &&
      process.platform === 'win32' &&
      uri.startsWith('mongodb+srv://') &&
      err?.code === 'ECONNREFUSED' &&
      err?.syscall === 'querySrv' &&
      dns.getServers().length === 1 &&
      dns.getServers()[0] === '127.0.0.1';

    if (isLocalhostSrvRefusal) {
      logger?.warn(
        { target: sanitizedUri },
        'Local DNS refused MongoDB SRV lookup; retrying with configured public DNS fallback'
      );
      dns.setServers([...PUBLIC_DNS_FALLBACK_SERVERS]);
      try {
        await mongoose.connect(uri, connectOptions);
        hasEstablishedConnection = true;

        if (!silentInitialSuccess) {
          const logMeta = {
            target: sanitizedUri,
            database: mongoose.connection.name || undefined
          };
          if (typeof logger?.success === 'function') {
            logger.success(logMeta, 'MongoDB connected successfully');
          } else {
            logger?.info(logMeta, 'MongoDB connected successfully');
          }
        }

        return getDatabaseStatus();
      } catch (retryErr) {
        logger?.error(
          {
            target: sanitizedUri,
            errorName: retryErr?.name,
            errorMessage: retryErr?.message
          },
          'Failed to connect to MongoDB'
        );
        throw retryErr;
      }
    }

    logger?.error(
      {
        target: sanitizedUri,
        errorName: err?.name,
        errorMessage: err?.message
      },
      'Failed to connect to MongoDB'
    );
    throw err;
  }
}

/**
 * Gracefully close the active MongoDB connection without triggering interruption warnings.
 */
export async function disconnectDatabase({ logger } = {}) {
  if (mongoose.connection.readyState === 0) {
    return;
  }

  isIntentionalDisconnect = true;
  try {
    await mongoose.disconnect();
    hasEstablishedConnection = false;
    logger?.info('MongoDB connection closed');
  } finally {
    isIntentionalDisconnect = false;
  }
}

/**
 * Return true when Mongoose reports an active connected state.
 */
export function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

/**
 * Return sanitized readiness metadata without exposing credentials.
 */
export function getDatabaseStatus() {
  const readyState = mongoose.connection.readyState;
  return {
    connected: readyState === 1,
    readyState,
    stateLabel: READY_STATE_LABELS[readyState] ?? 'unknown',
    databaseName: mongoose.connection.name || null
  };
}

/**
 * Verify read-only whether the connected MongoDB topology supports multi-document ACID transactions.
 */
export async function checkTransactionSupport({ logger, silent = false } = {}) {
  if (!isDatabaseReady() || !mongoose.connection.db) {
    return {
      supported: false,
      topology: 'disconnected',
      reason: 'Database is not connected'
    };
  }

  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  const isReplicaSet = Boolean(hello.setName);
  const isSharded = hello.msg === 'isdbgrid';
  const hasLogicalSessions =
    typeof hello.logicalSessionTimeoutMinutes === 'number' &&
    hello.logicalSessionTimeoutMinutes > 0;

  const supported = (isReplicaSet || isSharded) && hasLogicalSessions;
  const topology = isSharded
    ? 'sharded'
    : isReplicaSet
      ? 'replica_set'
      : 'standalone';

  const result = {
    supported,
    topology,
    hasLogicalSessions,
    reason: supported
      ? 'Topology supports multi-document ACID transactions'
      : 'Standalone or sessionless MongoDB deployments do not support multi-document transactions'
  };

  if (!silent && logger?.format && logger.format !== LOG_FORMATS.MINIMAL) {
    logger.info(result, 'Verified MongoDB transaction capability');
  }

  return result;
}

/**
 * Detect whether an error indicates temporary MongoDB / session-store unavailability.
 */
export function isDatabaseInfrastructureError(err) {
  if (!err) {
    return false;
  }

  const infraErrorNames = new Set([
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
    'MongoServerSelectionError',
    'MongooseServerSelectionError',
    'MongoNotConnectedError',
    'MongoTopologyClosedError'
  ]);

  if (infraErrorNames.has(err.name)) {
    return true;
  }

  if (err.code === 'SESSION_STORE_UNAVAILABLE' || err.code === 'AUTH_INFRASTRUCTURE_UNAVAILABLE') {
    return true;
  }

  const msg = typeof err.message === 'string' ? err.message : '';
  return (
    msg.includes('Client must be connected before running operations') ||
    msg.includes('Topology is closed') ||
    msg.includes('buffering timed out')
  );
}

/**
 * Default database adapter injected into the Express application.
 */
export const defaultDatabaseAdapter = Object.freeze({
  isReady: isDatabaseReady,
  getStatus: getDatabaseStatus
});
