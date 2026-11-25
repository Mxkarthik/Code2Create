import { describe, expect, it, vi } from 'vitest';
import { createJudge0Client } from '../../src/integrations/judge0/judge0.client.js';
import { validateJudge0Config } from '../../src/integrations/judge0/judge0.config.js';
import { JUDGE0_ERROR_CODES } from '../../src/integrations/judge0/judge0.errors.js';
import {
  EXECUTION_STATUSES,
  JUDGE0_STATUS_IDS,
  decodeBase64Field,
  mapExecutionResult
} from '../../src/integrations/judge0/judge0.mapper.js';
import {
  buildJudge0SubmissionPayload,
  createJudge0Service
} from '../../src/integrations/judge0/judge0.service.js';
import { EXECUTION_POLICY, LANGUAGE_CONFIG } from '../../src/modules/problems/language.config.js';

function makeJsonResponse(status, bodyObj, headers = {}) {
  const json = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  return new Response(json, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

describe('Judge0 integration (unit)', () => {
  const baseConfig = {
    JUDGE0_URL: 'http://127.0.0.1:2358/',
    JUDGE0_AUTH_TOKEN: 'secret-test-judge0-token',
    JUDGE0_MAX_IN_FLIGHT: 8,
    JUDGE0_REQUEST_TIMEOUT_MS: 5000,
    JUDGE0_POLL_INTERVAL_MS: 100,
    JUDGE0_POLL_TIMEOUT_MS: 500
  };

  describe('Configuration validation', () => {
    it('normalizes trailing slashes and enforces required token and bounds', () => {
      const cfg = validateJudge0Config(baseConfig);
      expect(cfg.baseUrl).toBe('http://127.0.0.1:2358');
      expect(cfg.maxInFlight).toBe(8);

      expect(() =>
        validateJudge0Config({ JUDGE0_URL: 'http://127.0.0.1:2358' }, { requireAuthToken: true })
      ).toThrow(/JUDGE0_AUTH_TOKEN/);

      expect(() =>
        validateJudge0Config({ ...baseConfig, JUDGE0_URL: 'http://user:pass@127.0.0.1:2358' })
      ).toThrow(/embedded URL credentials/i);

      expect(() =>
        validateJudge0Config({ ...baseConfig, JUDGE0_URL: 'https://judge0-ce.p.rapidapi.com' })
      ).toThrow(/Public Judge0 hosts are prohibited/i);
    });
  });

  describe('HTTP client, retries & admission uncertainty', () => {
    it('sends X-Auth-Token, Content-Type, base64_encoded=true, wait=false, and strict redirect rejection', async () => {
      const calls = [];
      const fetchFn = vi.fn(async (url, init) => {
        calls.push({ url, init });
        return makeJsonResponse(201, { token: 'abc12345-sub-token' });
      });

      const client = createJudge0Client({ config: baseConfig, fetchFn, sleepFn: vi.fn() });
      const res = await client.postSubmission({
        source_code: Buffer.from('print(1)', 'utf8').toString('base64'),
        language_id: 71
      });

      expect(res.token).toBe('abc12345-sub-token');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://127.0.0.1:2358/submissions?base64_encoded=true&wait=false');
      expect(calls[0].init.redirect).toBe('manual');
      expect(calls[0].init.headers['X-Auth-Token']).toBe('secret-test-judge0-token');
      expect(calls[0].init.headers['Content-Type']).toBe('application/json');

      const redirectFetch = vi.fn(async () => ({
        status: 302,
        ok: false,
        type: 'default',
        headers: new Headers(),
        body: { cancel: vi.fn(async () => {}) }
      }));
      const redirectClient = createJudge0Client({ config: baseConfig, fetchFn: redirectFetch });
      await expect(redirectClient.getAbout()).rejects.toMatchObject({
        code: JUDGE0_ERROR_CODES.REDIRECT_REJECTED
      });
    });

    it('rejects 401/403 authentication failure without leaking token and handles 429 queue saturation', async () => {
      const authClient = createJudge0Client({
        config: baseConfig,
        fetchFn: vi.fn(async () => makeJsonResponse(401, { error: 'Unauthorized' }))
      });

      try {
        await authClient.postSubmission({ language_id: 71, source_code: 'cHJpbnQoMSk=' });
        throw new Error('Expected failure');
      } catch (err) {
        expect(err.code).toBe(JUDGE0_ERROR_CODES.AUTH_FAILED);
        expect(err.admissionUncertain).toBe(false);
        expect(err.message).not.toContain('secret-test-judge0-token');
      }

      const satClient = createJudge0Client({
        config: baseConfig,
        fetchFn: vi.fn(async () =>
          makeJsonResponse(503, { error: 'Queue size limit reached (max_queue_size)' })
        )
      });
      await expect(
        satClient.postSubmission({ language_id: 71, source_code: 'cHJpbnQoMSk=' })
      ).rejects.toMatchObject({
        code: JUDGE0_ERROR_CODES.QUEUE_SATURATED,
        admissionUncertain: false
      });
    });

    it('protects against oversized responses, invalid JSON, and unexpected schemas', async () => {
      const tinyClient = createJudge0Client({
        config: { ...baseConfig, maxResponseBytes: 512 },
        fetchFn: vi.fn(async () => {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('A'.repeat(400)));
              controller.enqueue(new TextEncoder().encode('B'.repeat(400)));
              controller.close();
            }
          });
          return new Response(stream, { status: 200 });
        })
      });

      await expect(tinyClient.getAbout()).rejects.toMatchObject({
        code: JUDGE0_ERROR_CODES.INVALID_RESPONSE
      });

      const badJsonClient = createJudge0Client({
        config: baseConfig,
        fetchFn: vi.fn(async () => makeJsonResponse(200, '{invalid-json'))
      });
      await expect(badJsonClient.getAbout()).rejects.toMatchObject({
        code: JUDGE0_ERROR_CODES.INVALID_RESPONSE
      });

      const badLanguagesClient = createJudge0Client({
        config: baseConfig,
        fetchFn: vi.fn(async () => makeJsonResponse(200, { notAnArray: true }))
      });
      await expect(badLanguagesClient.getLanguages()).rejects.toMatchObject({
        code: JUDGE0_ERROR_CODES.INVALID_RESPONSE
      });
    });

    it('retries safe GET requests with backoff/jitter on transient errors', async () => {
      const sleeps = [];
      let attempt = 0;
      const fetchFn = vi.fn(async () => {
        attempt += 1;
        if (attempt < 3) {
          return makeJsonResponse(502, { error: 'Bad gateway' });
        }
        return makeJsonResponse(200, { token: 'tok-12345678', status: { id: 3, description: 'Accepted' } });
      });

      const client = createJudge0Client({
        config: baseConfig,
        fetchFn,
        sleepFn: async (ms) => sleeps.push(ms),
        randomFn: () => 0.5
      });

      const data = await client.getSubmission('tok-12345678');
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(sleeps).toHaveLength(2);
      expect(data.token).toBe('tok-12345678');
    });

    it('NEVER retries POST on timeout, reset, malformed 201, or missing token and marks admissionUncertain', async () => {
      for (const scenario of [
        () => {
          const err = new Error('Timed out');
          err.name = 'TimeoutError';
          return Promise.reject(err);
        },
        () => {
          const err = new Error('Connection reset');
          err.cause = { code: 'ECONNRESET' };
          return Promise.reject(err);
        },
        () => Promise.resolve(makeJsonResponse(201, '{broken')),
        () => Promise.resolve(makeJsonResponse(201, { ok: true }))
      ]) {
        const fetchFn = vi.fn(scenario);
        const client = createJudge0Client({ config: baseConfig, fetchFn, sleepFn: vi.fn() });

        await expect(
          client.postSubmission({ language_id: 54, source_code: 'aW50IG1haW4oKXt9' })
        ).rejects.toMatchObject({
          code: JUDGE0_ERROR_CODES.SUBMISSION_ADMISSION_UNCERTAIN,
          admissionUncertain: true
        });
        expect(fetchFn).toHaveBeenCalledTimes(1);
      }

      // Contrast with explicit pre-connect ECONNREFUSED -> UNREACHABLE, not uncertain
      const unreachableFetch = vi.fn(async () => {
        const err = new Error('connect ECONNREFUSED');
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
      });
      const unreachableClient = createJudge0Client({ config: baseConfig, fetchFn: unreachableFetch });
      await expect(
        unreachableClient.postSubmission({ language_id: 54, source_code: 'aW50IG1haW4oKXt9' })
      ).rejects.toMatchObject({
        code: JUDGE0_ERROR_CODES.UNREACHABLE,
        admissionUncertain: false
      });
      expect(unreachableFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Language & resource policy', () => {
    it('constructs trusted Base64 requests for all 4 languages and rejects overrides/oversized source', () => {
      for (const [key, cfg] of Object.entries(LANGUAGE_CONFIG)) {
        const built = buildJudge0SubmissionPayload({
          language: key,
          sourceCode: 'code-here',
          stdin: '1 2\n'
        });

        expect(built.payload.language_id).toBe(cfg.judge0LanguageId);
        expect(Buffer.from(built.payload.source_code, 'base64').toString('utf8')).toBe('code-here');
        expect(Buffer.from(built.payload.stdin, 'base64').toString('utf8')).toBe('1 2\n');
        expect(built.payload.enable_network).toBe(false);
        expect(built.payload.number_of_runs).toBe(1);
        expect(built.payload.expected_output).toBeUndefined();
        expect(built.payload.cpu_time_limit).toBe(cfg.executionLimits.cpuTimeLimitSeconds);
        expect(built.payload.wall_time_limit).toBe(cfg.executionLimits.wallTimeLimitSeconds);
        expect(built.payload.memory_limit).toBe(cfg.executionLimits.memoryLimitKb);
      }

      expect(() =>
        buildJudge0SubmissionPayload({ language: 'RUST', sourceCode: 'fn main(){}' })
      ).toThrow(/Unsupported programming language/);

      // 4-byte emoji * 9000 = 36000 UTF-8 bytes > 32768 limit
      const oversizedUtf8 = '😀'.repeat(9000);
      expect(() =>
        buildJudge0SubmissionPayload({ language: 'PYTHON', sourceCode: oversizedUtf8 })
      ).toThrow(/exceeds maximum limit/);

      expect(() =>
        buildJudge0SubmissionPayload({
          language: 'C',
          sourceCode: 'int main(){}',
          extraOptions: { compiler_options: '-O3' }
        })
      ).toThrow(/Forbidden execution option override/);
    });
  });

  describe('Status mapping, Base64 decoding & bounded polling', () => {
    it('maps all Judge0 statuses accurately and never maps status 3 to ACCEPTED blindly', () => {
      expect(mapExecutionResult({ status: { id: JUDGE0_STATUS_IDS.IN_QUEUE } }).isTerminal).toBe(false);
      expect(mapExecutionResult({ status: { id: JUDGE0_STATUS_IDS.PROCESSING } }).status).toBe(
        EXECUTION_STATUSES.PROCESSING
      );

      const executed = mapExecutionResult({
        status: { id: JUDGE0_STATUS_IDS.ACCEPTED_EXECUTION },
        stdout: Buffer.from('42\n', 'utf8').toString('base64'),
        time: '0.012',
        memory: 2048
      });
      expect(executed.status).toBe(EXECUTION_STATUSES.EXECUTED);
      expect(executed.isExecutionSuccess).toBe(true);
      expect(executed.timeSeconds).toBe(0.012);
      expect(executed.memoryKb).toBe(2048);

      expect(mapExecutionResult({ status: { id: JUDGE0_STATUS_IDS.WRONG_ANSWER } }).status).toBe(
        EXECUTION_STATUSES.WRONG_ANSWER
      );
      expect(mapExecutionResult({ status: { id: JUDGE0_STATUS_IDS.COMPILATION_ERROR } }).status).toBe(
        EXECUTION_STATUSES.COMPILATION_ERROR
      );
      expect(mapExecutionResult({ status: { id: JUDGE0_STATUS_IDS.RUNTIME_ERROR_SIGSEGV } })).toMatchObject({
        status: EXECUTION_STATUSES.RUNTIME_ERROR,
        runtimeErrorSignal: 'SIGSEGV'
      });
      expect(mapExecutionResult({ status: { id: JUDGE0_STATUS_IDS.RUNTIME_ERROR_SIGXFSZ } }).status).toBe(
        EXECUTION_STATUSES.OUTPUT_LIMIT_EXCEEDED
      );
      expect(mapExecutionResult({ status: { id: JUDGE0_STATUS_IDS.TIME_LIMIT_EXCEEDED } }).status).toBe(
        EXECUTION_STATUSES.TIME_LIMIT_EXCEEDED
      );
      expect(mapExecutionResult({ status: { id: JUDGE0_STATUS_IDS.INTERNAL_ERROR } })).toMatchObject({
        status: EXECUTION_STATUSES.INFRASTRUCTURE_ERROR,
        isInfrastructureError: true
      });
      expect(mapExecutionResult({ status: { id: 999 } })).toMatchObject({
        status: EXECUTION_STATUSES.UNKNOWN_STATUS,
        isInfrastructureError: true
      });
    });

    it('decodes null, empty, non-UTF-8, invalid Base64, and oversized outputs safely', () => {
      expect(decodeBase64Field(null).text).toBe('');
      expect(decodeBase64Field('').text).toBe('');

      const nonUtf8 = Buffer.from([0xff, 0xfe, 0x41]).toString('base64');
      const decodedNonUtf8 = decodeBase64Field(nonUtf8);
      expect(decodedNonUtf8.nonUtf8Detected).toBe(true);
      expect(decodedNonUtf8.text).toContain('A');

      const oversizedBase64 = Buffer.from('X'.repeat(EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES + 50), 'utf8').toString('base64');
      const overs = mapExecutionResult({
        status: { id: JUDGE0_STATUS_IDS.ACCEPTED_EXECUTION },
        stdout: oversizedBase64
      });
      expect(overs.status).toBe(EXECUTION_STATUSES.OUTPUT_LIMIT_EXCEEDED);
      expect(overs.outputMetadata.stdoutTruncated).toBe(true);

      const corrupted = mapExecutionResult({
        status: { id: JUDGE0_STATUS_IDS.ACCEPTED_EXECUTION },
        stdout: 'not!valid!base64!'
      });
      expect(corrupted.status).toBe(EXECUTION_STATUSES.INFRASTRUCTURE_ERROR);
      expect(corrupted.isInfrastructureError).toBe(true);
    });

    it('enforces waitForResult polling timeout with Judge0 token preserved', async () => {
      let now = 1000;
      const service = createJudge0Service({
        config: baseConfig,
        nowFn: () => now,
        sleepFn: async (ms) => {
          now += ms;
        },
        client: {
          getSubmission: vi.fn(async () => ({
            token: 'pending-tok-1234',
            status: { id: JUDGE0_STATUS_IDS.PROCESSING }
          }))
        }
      });

      await expect(
        service.waitForResult({ token: 'pending-tok-1234', pollIntervalMs: 100, pollTimeoutMs: 250 })
      ).rejects.toMatchObject({
        code: JUDGE0_ERROR_CODES.POLL_TIMEOUT,
        judge0Token: 'pending-tok-1234'
      });
    });
  });
});
