import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import {
  checkTransactionSupport,
  connectDatabase,
  defaultDatabaseAdapter,
  disconnectDatabase,
  isDatabaseReady
} from '../../src/config/database.js';
import { loadEnv } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';

const env = loadEnv();
const logger = createLogger({ level: 'silent' });

function extractDbName(uri) {
  try {
    const parsed = new URL(uri);
    return parsed.pathname.replace(/^\//, '') || 'test';
  } catch {
    return '';
  }
}

const appDbName = extractDbName(env.MONGODB_URI);
const testDbName = env.MONGODB_TEST_URI ? extractDbName(env.MONGODB_TEST_URI) : '';
const hasIsolatedTestDb =
  Boolean(env.MONGODB_TEST_URI) &&
  testDbName === 'code2create_test' &&
  testDbName !== appDbName;

describe('MongoDB connectivity, readiness, isolation, and transactions (real integration)', () => {
  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await disconnectDatabase({ logger });
    }
  });

  it('verifies MONGODB_TEST_URI isolation against code2create_test and differs from application DB', () => {
    expect(Boolean(env.MONGODB_TEST_URI)).toBe(true);
    expect(testDbName).toBe('code2create_test');
    expect(testDbName).not.toBe(appDbName);
    expect(hasIsolatedTestDb).toBe(true);
  });

  it('connects to isolated test DB, reports /api/ready 200, checks transactions read-only, and disconnects to 503', async () => {
    if (!hasIsolatedTestDb) {
      throw new Error('Isolated MONGODB_TEST_URI is required for write/integration tests');
    }

    await connectDatabase(env.MONGODB_TEST_URI, {
      logger,
      dnsServers: env.MONGODB_DNS_SERVERS,
      allowDnsFallback: env.MONGODB_DNS_FALLBACK
    });
    expect(isDatabaseReady()).toBe(true);
    expect(mongoose.connection.name).toBe('code2create_test');

    const app = createApp({
      env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      logger,
      database: defaultDatabaseAdapter
    });

    const readyRes = await request(app).get('/api/ready').expect(200);
    expect(readyRes.body).toMatchObject({
      success: true,
      status: 'ready',
      checks: { database: { status: 'up' } }
    });

    const txResult = await checkTransactionSupport({ logger });
    expect(txResult.supported).toBe(true);
    expect(txResult.topology).toBe('replica_set');

    await disconnectDatabase({ logger });
    expect(isDatabaseReady()).toBe(false);

    const notReadyRes = await request(app).get('/api/ready').expect(503);
    expect(notReadyRes.body).toMatchObject({
      success: false,
      status: 'not_ready',
      checks: { database: { status: 'down' } }
    });
  });

  it('performs isolated test collection write and cleanup without dropDatabase', async () => {
    if (!hasIsolatedTestDb) {
      throw new Error('Isolated MONGODB_TEST_URI is required for write tests');
    }

    await connectDatabase(env.MONGODB_TEST_URI, {
      logger,
      dnsServers: env.MONGODB_DNS_SERVERS,
      allowDnsFallback: env.MONGODB_DNS_FALLBACK
    });
    const testCollection = mongoose.connection.db.collection('_phase01_healthcheck');

    await testCollection.deleteMany({ marker: 'phase01-test' });
    await testCollection.insertOne({ marker: 'phase01-test', createdAt: new Date() });
    const countAfterInsert = await testCollection.countDocuments({
      marker: 'phase01-test'
    });
    expect(countAfterInsert).toBe(1);

    await testCollection.deleteMany({ marker: 'phase01-test' });
    const countAfterCleanup = await testCollection.countDocuments({
      marker: 'phase01-test'
    });
    expect(countAfterCleanup).toBe(0);

    await disconnectDatabase({ logger });
  });

  it('commits a real MongoDB multi-document transaction on the isolated test database', async () => {
    if (!hasIsolatedTestDb) {
      throw new Error('Isolated MONGODB_TEST_URI is required for transaction tests');
    }

    await connectDatabase(env.MONGODB_TEST_URI, {
      logger,
      dnsServers: env.MONGODB_DNS_SERVERS,
      allowDnsFallback: env.MONGODB_DNS_FALLBACK
    });

    const collection = mongoose.connection.db.collection('_phase02_tx_test');
    const marker = `tx-commit-${Date.now()}`;
    await collection.deleteMany({ marker });

    // Pre-create collection outside transaction as required by MongoDB replica sets
    await mongoose.connection.db.createCollection('_phase02_tx_test').catch(() => {});

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await collection.insertOne({ marker, step: 1 }, { session });
        await collection.insertOne({ marker, step: 2 }, { session });
      });
    } finally {
      await session.endSession();
    }

    const committedCount = await collection.countDocuments({ marker });
    expect(committedCount).toBe(2);

    await collection.deleteMany({ marker });
    await disconnectDatabase({ logger });
  });

  it('rolls back a real MongoDB multi-document transaction on error', async () => {
    if (!hasIsolatedTestDb) {
      throw new Error('Isolated MONGODB_TEST_URI is required for transaction tests');
    }

    await connectDatabase(env.MONGODB_TEST_URI, {
      logger,
      dnsServers: env.MONGODB_DNS_SERVERS,
      allowDnsFallback: env.MONGODB_DNS_FALLBACK
    });

    const collection = mongoose.connection.db.collection('_phase02_tx_test');
    const marker = `tx-rollback-${Date.now()}`;
    await collection.deleteMany({ marker });
    await mongoose.connection.db.createCollection('_phase02_tx_test').catch(() => {});

    const session = await mongoose.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          await collection.insertOne({ marker, step: 1 }, { session });
          throw new Error('Simulated settlement failure');
        })
      ).rejects.toThrow('Simulated settlement failure');
    } finally {
      await session.endSession();
    }

    const rolledBackCount = await collection.countDocuments({ marker });
    expect(rolledBackCount).toBe(0);

    await disconnectDatabase({ logger });
  });
});
