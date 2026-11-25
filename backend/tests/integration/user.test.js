import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { loadEnv } from '../../src/config/env.js';
import { USER_ROLES, User } from '../../src/modules/users/user.model.js';
import { findOrCreateGoogleUser } from '../../src/modules/users/user.service.js';
import { createLogger } from '../../src/utils/logger.js';

const env = loadEnv();
const logger = createLogger({ level: 'silent' });

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

describe('User identity, atomic upsert, and role preservation (real MongoDB integration)', () => {
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
  });

  beforeEach(async () => {
    await User.deleteMany({ googleSub: /^test-sub-/ });
  });

  afterAll(async () => {
    await User.deleteMany({ googleSub: /^test-sub-/ });
    await disconnectDatabase({ logger });
  });

  it('defaults new accounts to PARTICIPANT and preserves the same user ID on repeated logins', async () => {
    const first = await findOrCreateGoogleUser({
      googleSub: 'test-sub-default-1',
      email: 'Student.One@Example.COM',
      emailVerified: true,
      name: 'Student One',
      avatar: 'https://example.com/a1.png'
    });

    expect(first.role).toBe(USER_ROLES.PARTICIPANT);
    expect(first.isActive).toBe(true);
    expect(first.email).toBe('student.one@example.com');

    const second = await findOrCreateGoogleUser({
      googleSub: 'test-sub-default-1',
      email: 'student.one@example.com',
      emailVerified: true,
      name: 'Student One Updated',
      avatar: 'https://example.com/a2.png'
    });

    expect(second._id.toString()).toBe(first._id.toString());
    expect(second.name).toBe('Student One Updated');
    expect(second.role).toBe(USER_ROLES.PARTICIPANT);
  });

  it('prevents duplicate user creation during concurrent simultaneous logins', async () => {
    const payload = {
      googleSub: 'test-sub-concurrent-1',
      email: 'concurrent@example.com',
      emailVerified: true,
      name: 'Concurrent User'
    };

    const results = await Promise.all([
      findOrCreateGoogleUser(payload),
      findOrCreateGoogleUser(payload),
      findOrCreateGoogleUser(payload),
      findOrCreateGoogleUser(payload)
    ]);

    const ids = new Set(results.map((u) => u._id.toString()));
    expect(ids.size).toBe(1);

    const count = await User.countDocuments({ googleSub: 'test-sub-concurrent-1' });
    expect(count).toBe(1);
  });

  it('preserves existing ADMIN role and supports multiple ADMIN accounts across logins', async () => {
    const admin1 = await findOrCreateGoogleUser({
      googleSub: 'test-sub-admin-1',
      email: 'admin1@example.com',
      emailVerified: true,
      name: 'Admin One'
    });
    const admin2 = await findOrCreateGoogleUser({
      googleSub: 'test-sub-admin-2',
      email: 'admin2@example.com',
      emailVerified: true,
      name: 'Admin Two'
    });

    await User.updateOne({ _id: admin1._id }, { $set: { role: USER_ROLES.ADMIN } });
    await User.updateOne({ _id: admin2._id }, { $set: { role: USER_ROLES.ADMIN } });

    const relogin1 = await findOrCreateGoogleUser({
      googleSub: 'test-sub-admin-1',
      email: 'admin1@example.com',
      emailVerified: true,
      name: 'Admin One Relogin'
    });
    const relogin2 = await findOrCreateGoogleUser({
      googleSub: 'test-sub-admin-2',
      email: 'admin2@example.com',
      emailVerified: true,
      name: 'Admin Two Relogin'
    });

    expect(relogin1.role).toBe(USER_ROLES.ADMIN);
    expect(relogin2.role).toBe(USER_ROLES.ADMIN);
    expect(
      await User.countDocuments({
        googleSub: { $in: ['test-sub-admin-1', 'test-sub-admin-2'] },
        role: USER_ROLES.ADMIN
      })
    ).toBe(2);
  });

  it('keeps disabled accounts disabled after OAuth profile updates and rejects login', async () => {
    const user = await findOrCreateGoogleUser({
      googleSub: 'test-sub-disabled-1',
      email: 'disabled@example.com',
      emailVerified: true,
      name: 'Active Initially'
    });

    await User.updateOne({ _id: user._id }, { $set: { isActive: false } });

    await expect(
      findOrCreateGoogleUser({
        googleSub: 'test-sub-disabled-1',
        email: 'disabled@example.com',
        emailVerified: true,
        name: 'Attempted Relogin'
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'ACCOUNT_DISABLED'
    });

    const refreshed = await User.findById(user._id).lean();
    expect(refreshed.isActive).toBe(false);
    expect(refreshed.name).toBe('Attempted Relogin');
  });

  it('rejects unverified Google email addresses', async () => {
    await expect(
      findOrCreateGoogleUser({
        googleSub: 'test-sub-unverified-1',
        email: 'unverified@example.com',
        emailVerified: false,
        name: 'Unverified User'
      })
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNVERIFIED_GOOGLE_EMAIL'
    });

    expect(await User.countDocuments({ googleSub: 'test-sub-unverified-1' })).toBe(0);
  });

  it('does not silently merge different Google subject identities sharing an email address', async () => {
    const userA = await findOrCreateGoogleUser({
      googleSub: 'test-sub-identity-a',
      email: 'shared.alias@example.com',
      emailVerified: true,
      name: 'Identity A'
    });

    const userB = await findOrCreateGoogleUser({
      googleSub: 'test-sub-identity-b',
      email: 'shared.alias@example.com',
      emailVerified: true,
      name: 'Identity B'
    });

    expect(userA._id.toString()).not.toBe(userB._id.toString());
    expect(
      await User.countDocuments({
        googleSub: { $in: ['test-sub-identity-a', 'test-sub-identity-b'] }
      })
    ).toBe(2);
  });

  it('ignores any client-supplied role properties during user upsert', async () => {
    const created = await findOrCreateGoogleUser({
      googleSub: 'test-sub-escalation-1',
      email: 'sneaky@example.com',
      emailVerified: true,
      name: 'Sneaky User',
      role: 'ADMIN'
    });

    expect(created.role).toBe(USER_ROLES.PARTICIPANT);
  });
});
