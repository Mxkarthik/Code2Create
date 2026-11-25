import { Writable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';
import { requestIdMiddleware } from '../../src/middleware/requestId.js';
import {
  LOG_FORMATS,
  createHttpLogger,
  createLogger,
  sanitizeConnectionString
} from '../../src/utils/logger.js';

function createMemoryStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    }
  });
  return {
    stream,
    getRaw: () => chunks.join(''),
    getLines: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
  };
}

describe('Structured, minimal, and debug logging with secret redaction (unit)', () => {
  const originalNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  });

  it('redacts sensitive fields across json, minimal, and debug logging modes', () => {
    for (const format of [LOG_FORMATS.JSON, LOG_FORMATS.MINIMAL, LOG_FORMATS.DEBUG]) {
      const { stream, getRaw } = createMemoryStream();
      const logger = createLogger({
        level: 'debug',
        format,
        destination: stream,
        useColor: false
      });

      logger.info(
        {
          MONGODB_URI: 'mongodb+srv://dbuser:dbpass@cluster.mongodb.net/c2c',
          SESSION_SECRET: 'top-session-secret',
          GOOGLE_CLIENT_SECRET: 'google-secret-value',
          JUDGE0_AUTH_TOKEN: 'judge0-secret-token',
          csrfToken: 'secret-csrf-token',
          nested: {
            password: 'user-password',
            accessToken: 'oauth-access-token'
          },
          safeField: 'visible-value'
        },
        'Testing secret redaction'
      );

      const raw = getRaw();
      expect(raw).not.toContain('dbpass');
      expect(raw).not.toContain('top-session-secret');
      expect(raw).not.toContain('google-secret-value');
      expect(raw).not.toContain('judge0-secret-token');
      expect(raw).not.toContain('secret-csrf-token');
      expect(raw).not.toContain('user-password');
      expect(raw).not.toContain('oauth-access-token');

      if (format === LOG_FORMATS.JSON) {
        const parsed = JSON.parse(raw.trim());
        expect(parsed.MONGODB_URI).toBe('[REDACTED]');
        expect(parsed.SESSION_SECRET).toBe('[REDACTED]');
        expect(parsed.nested.password).toBe('[REDACTED]');
        expect(parsed.safeField).toBe('visible-value');
      } else {
        expect(raw).toContain('[INFO] Testing secret redaction');
        expect(raw.trim().startsWith('{')).toBe(false);
      }
    }
  });

  it('formats minimal human-readable severity indicators and respects NO_COLOR', () => {
    delete process.env.NO_COLOR;
    const colorCap = createMemoryStream();
    const colorLogger = createLogger({
      level: 'info',
      format: LOG_FORMATS.MINIMAL,
      destination: colorCap.stream,
      useColor: true
    });

    colorLogger.success('MongoDB connected successfully');
    colorLogger.info('Server closing');
    colorLogger.warn('Local DNS fallback triggered');
    colorLogger.error('Database failed');

    const colored = colorCap.getRaw();
    expect(colored).toContain('\x1b[32m[SUCCESS]\x1b[0m MongoDB connected successfully');
    expect(colored).toContain('\x1b[36m[INFO]\x1b[0m Server closing');
    expect(colored).toContain('\x1b[33m[WARN]\x1b[0m Local DNS fallback triggered');
    expect(colored).toContain('\x1b[31m[ERROR]\x1b[0m Database failed');

    process.env.NO_COLOR = '1';
    const plainCap = createMemoryStream();
    const plainLogger = createLogger({
      level: 'info',
      format: LOG_FORMATS.MINIMAL,
      destination: plainCap.stream,
      useColor: true
    });

    plainLogger.success('Plain output');
    expect(plainCap.getRaw()).toBe('[SUCCESS] Plain output\n');
    expect(plainCap.getRaw()).not.toContain('\x1b[');
  });

  it('prints compact startup summary with dynamic runtime port', () => {
    delete process.env.NO_COLOR;
    const { stream, getRaw } = createMemoryStream();
    const logger = createLogger({
      level: 'info',
      format: LOG_FORMATS.MINIMAL,
      destination: stream,
      useColor: false
    });

    logger.printStartupSummary({
      environment: 'development',
      port: 7123,
      checks: [
        { level: 'SUCCESS', message: 'MongoDB connected successfully' },
        { level: 'SUCCESS', message: 'Database transactions supported' },
        { level: 'SUCCESS', message: 'Authentication initialized' },
        { level: 'SUCCESS', message: 'Server started on port 7123' }
      ]
    });

    const output = getRaw();
    expect(output).toContain('CODE 2 CREATE — BACKEND');
    expect(output).toContain('[SUCCESS] Server started on port 7123');
    expect(output).toContain('Environment : Development');
    expect(output).toContain('Server      : http://localhost:7123');
    expect(output).toContain('Status      : Ready');
    expect(output).not.toContain('5000');
  });

  it('suppresses routine HTTP and 404 logs in minimal mode while retaining critical errors without duplication', async () => {
    const { stream, getRaw } = createMemoryStream();
    const logger = createLogger({
      level: 'info',
      format: LOG_FORMATS.MINIMAL,
      destination: stream,
      useColor: false
    });

    const app = createApp({
      env: {
        NODE_ENV: 'development',
        LOG_FORMAT: 'minimal',
        PARTICIPANT_FRONTEND_URL: 'http://localhost:5173',
        ADMIN_FRONTEND_URL: 'http://localhost:5174'
      },
      logger,
      database: { isReady: () => true },
      mountExtraRoutes: ({ app: targetApp }) => {
        targetApp.get('/api/boom', () => {
          throw new Error('Unexpected database failure');
        });
      }
    });

    // These should produce zero logs in minimal mode
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/ready').expect(200);
    await request(app).get('/api/does-not-exist').expect(404);
    expect(getRaw()).toBe('');

    // Wait: mountExtraRoutes runs only when SESSION_SECRET is set; test error deduplication directly
    const errorApp = express();
    errorApp.use(requestIdMiddleware);
    errorApp.use(createHttpLogger({ logger, format: LOG_FORMATS.MINIMAL }));
    errorApp.get('/api/boom', () => {
      throw new Error('Unexpected critical explosion');
    });
    errorApp.use(
      createErrorHandler({
        nodeEnv: 'development',
        logFormat: LOG_FORMATS.MINIMAL,
        logger
      })
    );

    await request(errorApp).get('/api/boom').expect(500);
    const lines = getRaw().trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[ERROR]');
    expect(lines[0]).toContain('Unexpected critical explosion');
  });

  it('avoids duplicate error logs in structured production json mode as well', async () => {
    const { stream, getLines } = createMemoryStream();
    const logger = createLogger({
      level: 'info',
      format: LOG_FORMATS.JSON,
      destination: stream
    });

    const errorApp = express();
    errorApp.use(requestIdMiddleware);
    errorApp.use(createHttpLogger({ logger, format: LOG_FORMATS.JSON }));
    errorApp.get('/api/prod-boom', () => {
      throw new Error('Production crash detail');
    });
    errorApp.use(
      createErrorHandler({
        nodeEnv: 'production',
        logFormat: LOG_FORMATS.JSON,
        logger
      })
    );

    await request(errorApp).get('/api/prod-boom').expect(500);
    const lines = getLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('error');
    expect(lines[0].errorCode).toBe('INTERNAL_SERVER_ERROR');
  });

  it('sanitizes database connection URIs', () => {
    expect(
      sanitizeConnectionString(
        'mongodb+srv://adminUser:superSecret123@cluster0.abcde.mongodb.net/code2create?retryWrites=true'
      )
    ).toBe('mongodb+srv://[REDACTED]@cluster0.abcde.mongodb.net/code2create');

    expect(sanitizeConnectionString('mongodb://127.0.0.1:27017/code2create_test')).toBe(
      'mongodb://127.0.0.1:27017/code2create_test'
    );

    expect(sanitizeConnectionString('not-a-valid-uri')).toBe('[REDACTED_URI]');
  });

  it('strips query strings and redacts auth/cookie headers in structured HTTP logs', async () => {
    const { stream, getLines } = createMemoryStream();
    const logger = createLogger({
      level: 'info',
      format: LOG_FORMATS.JSON,
      destination: stream
    });

    const miniApp = express();
    miniApp.use(requestIdMiddleware);
    miniApp.use(createHttpLogger({ logger, format: LOG_FORMATS.JSON }));
    miniApp.use(express.json());
    miniApp.post('/api/auth/google/callback', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    await request(miniApp)
      .post('/api/auth/google/callback?code=oauth-secret-code&state=state-123')
      .set('Authorization', 'Bearer secret-bearer-token')
      .set('Cookie', 'sid=secret-session-cookie')
      .send({ secretBodyField: 'must-not-be-logged' })
      .expect(200);

    const lines = getLines();
    const serialized = JSON.stringify(lines);

    expect(serialized).not.toContain('oauth-secret-code');
    expect(serialized).not.toContain('state-123');
    expect(serialized).not.toContain('secret-bearer-token');
    expect(serialized).not.toContain('secret-session-cookie');
    expect(serialized).not.toContain('must-not-be-logged');
    expect(lines[0].req.url).toBe('/api/auth/google/callback');
  });
});
