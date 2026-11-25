import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OAUTH_STATE_TTL_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_MAX_AGE_MS,
  validateEnv
} from '../../src/config/env.js';

describe('Environment validation (unit)', () => {
  const validBase = {
    NODE_ENV: 'development',
    PORT: '5000',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/code2create_test',
    LOG_LEVEL: 'info',
    GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret-value',
    SESSION_SECRET: 'a-very-strong-session-secret-with-at-least-32-chars'
  };

  it('parses valid Phase 01 + Phase 02 variables and applies development defaults', () => {
    const env = validateEnv({
      MONGODB_URI: validBase.MONGODB_URI,
      GOOGLE_CLIENT_ID: validBase.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: validBase.GOOGLE_CLIENT_SECRET,
      SESSION_SECRET: validBase.SESSION_SECRET
    });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(5000);
    expect(env.MONGODB_URI).toBe(validBase.MONGODB_URI);
    expect(env.PARTICIPANT_FRONTEND_URL).toBe('http://localhost:5173');
    expect(env.ADMIN_FRONTEND_URL).toBe('http://localhost:5174');
    expect(env.GOOGLE_CALLBACK_URL).toBe('http://localhost:5000/api/auth/google/callback');
    expect(env.CORS_ORIGINS).toEqual([
      'http://localhost:5173',
      'http://localhost:5174'
    ]);
    expect(env.SESSION_MAX_AGE_MS).toBe(DEFAULT_SESSION_MAX_AGE_MS);
    expect(env.SESSION_IDLE_TIMEOUT_MS).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(env.OAUTH_STATE_TTL_MS).toBe(DEFAULT_OAUTH_STATE_TTL_MS);
    expect(env.MONGODB_DNS_FALLBACK).toBe(true);
    expect(env.LOG_FORMAT).toBe('minimal');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('defaults LOG_FORMAT to json in production and respects debug mode', () => {
    const prodEnv = validateEnv({
      ...validBase,
      NODE_ENV: 'production',
      LOG_LEVEL: undefined,
      PARTICIPANT_FRONTEND_URL: 'https://play.code2create.dev',
      ADMIN_FRONTEND_URL: 'https://admin.code2create.dev',
      GOOGLE_CALLBACK_URL: 'https://api.code2create.dev/api/auth/google/callback'
    });
    expect(prodEnv.LOG_FORMAT).toBe('json');
    expect(prodEnv.LOG_LEVEL).toBe('info');

    const debugEnv = validateEnv({
      ...validBase,
      LOG_LEVEL: undefined,
      LOG_FORMAT: 'debug'
    });
    expect(debugEnv.LOG_FORMAT).toBe('debug');
    expect(debugEnv.LOG_LEVEL).toBe('debug');
  });

  it('supports legacy MONGO_URI fallback without modifying .env', () => {
    const env = validateEnv({
      MONGO_URI: 'mongodb+srv://user:pass@cluster.example.net/c2c',
      GOOGLE_CLIENT_ID: validBase.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: validBase.GOOGLE_CLIENT_SECRET,
      SESSION_SECRET: validBase.SESSION_SECRET
    });

    expect(env.MONGODB_URI).toBe('mongodb+srv://user:pass@cluster.example.net/c2c');
  });

  it('throws when required MONGODB_URI, Google OAuth, or SESSION_SECRET are missing', () => {
    expect(() => validateEnv({ NODE_ENV: 'development', PORT: '5000' })).toThrow(
      /MONGODB_URI/
    );

    expect(() =>
      validateEnv({
        MONGODB_URI: validBase.MONGODB_URI
      })
    ).toThrow(/GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET.*SESSION_SECRET/);
  });

  it('requires explicit frontend/callback URLs and disables DNS fallback by default in production', () => {
    expect(() =>
      validateEnv({
        ...validBase,
        NODE_ENV: 'production'
      })
    ).toThrow(/PARTICIPANT_FRONTEND_URL.*ADMIN_FRONTEND_URL.*GOOGLE_CALLBACK_URL/);

    const prodEnv = validateEnv({
      ...validBase,
      NODE_ENV: 'production',
      PARTICIPANT_FRONTEND_URL: 'https://play.code2create.dev/',
      ADMIN_FRONTEND_URL: 'https://admin.code2create.dev/',
      GOOGLE_CALLBACK_URL: 'https://api.code2create.dev/api/auth/google/callback'
    });

    expect(prodEnv.MONGODB_DNS_FALLBACK).toBe(false);
    expect(prodEnv.CORS_ORIGINS).toEqual([
      'https://play.code2create.dev',
      'https://admin.code2create.dev'
    ]);
  });

  it('rejects weak SESSION_SECRET, invalid timeouts, and invalid DNS servers without exposing secrets', () => {
    const secretUri = 'mongodb://supersecretuser:supersecretpass@host:27017/db';

    try {
      validateEnv({
        NODE_ENV: 'production',
        PORT: '99999',
        MONGODB_URI: 'invalid://cluster/db',
        MONGODB_DNS_SERVERS: 'not-an-ip',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        SESSION_SECRET: 'too-short',
        SESSION_MAX_AGE_MS: '1000',
        SESSION_IDLE_TIMEOUT_MS: '2000'
      });
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.message).not.toContain(secretUri);
      expect(err.message).toContain('MONGODB_URI');
      expect(err.message).toContain('SESSION_SECRET');
      expect(err.message).toContain('SESSION_IDLE_TIMEOUT_MS');
      expect(err.message).toContain('MONGODB_DNS_SERVERS');
    }
  });
});
