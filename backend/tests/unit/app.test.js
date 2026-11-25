import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createApp } from '../../src/app.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';
import { requestIdMiddleware } from '../../src/middleware/requestId.js';
import { createLogger } from '../../src/utils/logger.js';

const baseEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  PARTICIPANT_FRONTEND_URL: 'http://localhost:5173',
  ADMIN_FRONTEND_URL: 'http://localhost:5174',
  CORS_ORIGINS: ['http://localhost:5173', 'http://localhost:5174']
};

describe('Express application foundation (unit / mocked dependencies)', () => {
  it('initializes Express application without binding a port and sets security headers', async () => {
    const app = createApp({
      env: baseEnv,
      database: { isReady: () => true }
    });

    const response = await request(app).get('/api/health').expect(200);

    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('returns 200 on GET /api/health with process liveness metadata', async () => {
    const app = createApp({
      env: baseEnv,
      database: { isReady: () => false }
    });

    const response = await request(app).get('/api/health').expect(200);

    expect(response.body).toMatchObject({
      success: true,
      status: 'ok',
      service: 'code2create-backend',
      environment: 'test'
    });
    expect(typeof response.body.timestamp).toBe('string');
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(typeof response.body.requestId).toBe('string');
  });

  it('returns 200 on GET /api/ready when database is available', async () => {
    const app = createApp({
      env: baseEnv,
      database: { isReady: () => true }
    });

    const response = await request(app).get('/api/ready').expect(200);

    expect(response.body).toMatchObject({
      success: true,
      status: 'ready',
      checks: {
        database: { status: 'up' }
      }
    });
  });

  it('returns 503 on GET /api/ready when database is unavailable', async () => {
    const app = createApp({
      env: baseEnv,
      database: { isReady: () => false }
    });

    const response = await request(app).get('/api/ready').expect(503);

    expect(response.body).toMatchObject({
      success: false,
      status: 'not_ready',
      checks: {
        database: { status: 'down' }
      }
    });
  });

  it('returns 404 JSON for unknown routes', async () => {
    const app = createApp({
      env: baseEnv,
      database: { isReady: () => true }
    });

    const response = await request(app).get('/api/non-existent-route').expect(404);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Route not found: GET /api/non-existent-route'
      }
    });
    expect(typeof response.body.error.requestId).toBe('string');
  });

  it('returns 400 INVALID_JSON for malformed JSON payloads', async () => {
    const app = createApp({
      env: baseEnv,
      database: { isReady: () => true }
    });

    const response = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{"broken": ')
      .expect(400);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_JSON',
        message: 'Malformed JSON request body'
      }
    });
  });

  it('allows configured frontend CORS origins with credentials and never emits wildcard', async () => {
    const app = createApp({
      env: baseEnv,
      database: { isReady: () => true }
    });

    const participantRes = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(participantRes.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173'
    );
    expect(participantRes.headers['access-control-allow-credentials']).toBe('true');

    const adminRes = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5174')
      .expect(200);

    expect(adminRes.headers['access-control-allow-origin']).toBe(
      'http://localhost:5174'
    );
    expect(adminRes.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects disallowed CORS origins with 403 and no Allow-Origin header', async () => {
    const app = createApp({
      env: baseEnv,
      database: { isReady: () => true }
    });

    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'https://untrusted.example.com')
      .expect(403);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'CORS_ORIGIN_DENIED'
      }
    });
  });

  it('assigns, echoes valid, and replaces invalid request correlation IDs', async () => {
    const app = createApp({
      env: baseEnv,
      database: { isReady: () => true }
    });

    const generated = await request(app).get('/api/health').expect(200);
    expect(generated.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(generated.body.requestId).toBe(generated.headers['x-request-id']);

    const customId = 'req-trace_2026.01';
    const echoed = await request(app)
      .get('/api/health')
      .set('X-Request-Id', customId)
      .expect(200);
    expect(echoed.headers['x-request-id']).toBe(customId);
    expect(echoed.body.requestId).toBe(customId);

    const sanitized = await request(app)
      .get('/api/health')
      .set('X-Request-Id', 'bad header value with spaces!')
      .expect(200);
    expect(sanitized.headers['x-request-id']).not.toBe('bad header value with spaces!');
  });

  it('sanitizes unexpected errors in production mode without leaking internal details', async () => {
    const logger = createLogger({ level: 'silent' });
    const testApp = express();
    testApp.use(requestIdMiddleware);
    testApp.get('/boom', () => {
      throw new Error('Sensitive internal MongoDB stack detail');
    });
    testApp.use(createErrorHandler({ nodeEnv: 'production', logger }));

    const response = await request(testApp).get('/boom').expect(500);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error'
      }
    });
    expect(response.body.error.stack).toBeUndefined();
    expect(response.body.error.details).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(
      'Sensitive internal MongoDB stack detail'
    );
  });

  it('calls database readiness adapter cleanly', async () => {
    const isReady = vi.fn().mockReturnValue(true);
    const app = createApp({
      env: baseEnv,
      database: { isReady }
    });

    await request(app).get('/api/ready').expect(200);
    expect(isReady).toHaveBeenCalledTimes(1);
  });
});
