import { loadEnv } from '../src/config/env.js';
import { createJudge0Client } from '../src/integrations/judge0/judge0.client.js';
import { JUDGE0_ERROR_CODES } from '../src/integrations/judge0/judge0.errors.js';
import { EXECUTION_STATUSES } from '../src/integrations/judge0/judge0.mapper.js';
import { createJudge0Service } from '../src/integrations/judge0/judge0.service.js';
import { evaluateTestCaseResult } from '../src/modules/execution/testCaseEvaluator.js';
import { EXECUTION_POLICY, LANGUAGE_CONFIG } from '../src/modules/problems/language.config.js';
import { formatSeverityBadge, resolveColorSupport } from '../src/utils/logger.js';

const useColor = resolveColorSupport(process.stdout);

function logLine(kind, message) {
  const badge = formatSeverityBadge(kind, useColor);
  console.log(`${badge} ${message}`);
}

const DIAGNOSTIC_PROGRAMS = [
  {
    key: 'C',
    label: 'C',
    stdin: '7 5\n',
    expectedOutput: '12',
    sourceCode: `#include <stdio.h>

int main(void) {
    int a, b;
    if (scanf("%d %d", &a, &b) != 2) return 1;
    printf("%d  \\r\\n", a + b);
    return 0;
}
`
  },
  {
    key: 'CPP',
    label: 'C++',
    stdin: '19 23\n',
    expectedOutput: '42',
    sourceCode: `#include <iostream>
using namespace std;

int main() {
    long long a, b;
    if (!(cin >> a >> b)) return 1;
    cout << (a + b) << " \\n\\n";
    return 0;
}
`
  },
  {
    key: 'PYTHON',
    label: 'Python',
    stdin: '15 27\n',
    expectedOutput: '42',
    sourceCode: `import sys
a, b = map(int, sys.stdin.read().split())
print(a + b)
`
  },
  {
    key: 'JAVA',
    label: 'Java',
    stdin: '8 34\n',
    expectedOutput: '42',
    sourceCode: `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int a = sc.nextInt();
        int b = sc.nextInt();
        System.out.println(a + b);
    }
}
`
  }
];

async function runAndEvaluate({ judge0Service, language, sourceCode, stdin = '', expectedOutput = '' }) {
  const startMs = Date.now();
  const admission = await judge0Service.createSubmission({
    language,
    sourceCode,
    stdin
  });
  const mappedResult = await judge0Service.waitForResult({
    token: admission.token
  });
  const durationMs = Date.now() - startMs;
  const verdict = evaluateTestCaseResult({
    mappedResult,
    testCase: {
      id: 'diag',
      type: 'SAMPLE',
      displayOrder: 1,
      input: stdin,
      expectedOutput
    }
  });
  return { mappedResult, verdict, durationMs };
}

async function main() {
  const startedAt = Date.now();
  const latencies = [];
  let failures = 0;

  console.log('CODE 2 CREATE — JUDGE0 DIAGNOSTIC VERIFICATION');
  console.log('------------------------------------------------');

  let env;
  try {
    env = loadEnv();
  } catch (err) {
    logLine('ERROR', `Environment validation failed: ${err.message}`);
    process.exit(1);
  }

  const judge0Config = {
    JUDGE0_URL: env.JUDGE0_URL,
    JUDGE0_AUTH_TOKEN: env.JUDGE0_AUTH_TOKEN,
    JUDGE0_MAX_IN_FLIGHT: env.JUDGE0_MAX_IN_FLIGHT,
    JUDGE0_REQUEST_TIMEOUT_MS: env.JUDGE0_REQUEST_TIMEOUT_MS,
    JUDGE0_POLL_INTERVAL_MS: env.JUDGE0_POLL_INTERVAL_MS,
    JUDGE0_POLL_TIMEOUT_MS: env.JUDGE0_POLL_TIMEOUT_MS
  };

  const client = createJudge0Client({ config: judge0Config });
  const judge0Service = createJudge0Service({ config: judge0Config, client });

  try {
    const cfgSummary = client.getConfigSummary();
    if (!cfgSummary.hasAuthToken) {
      throw new Error('JUDGE0_AUTH_TOKEN is missing');
    }
    logLine('INFO', `Target Judge0 endpoint: ${cfgSummary.baseUrl}`);

    // 1-2. Authenticated connectivity check
    const about = await client.getAbout();
    logLine('SUCCESS', 'Judge0 connection established');
    logLine('SUCCESS', `Judge0 authentication verified (CE version ${about?.version ?? 'unknown'})`);

    // 3. Language verification + remote config audit
    const [languages, configInfo] = await Promise.all([
      client.getLanguages(),
      client.getConfigInfo().catch(() => null)
    ]);

    const byId = new Map(languages.map((l) => [l.id, l.name]));
    for (const [key, cfg] of Object.entries(LANGUAGE_CONFIG)) {
      const remoteName = byId.get(cfg.judge0LanguageId);
      if (!remoteName) {
        throw new Error(`Configured language ${key} (ID ${cfg.judge0LanguageId}) not found on Judge0`);
      }
      logLine('INFO', `Language verified: ${key} -> ID ${cfg.judge0LanguageId} (${remoteName})`);
    }

    if (configInfo) {
      logLine(
        'INFO',
        `Remote limits: cpu_extra_time=${configInfo.cpu_extra_time}s, max_queue_size=${configInfo.max_queue_size}, max_file_size=${configInfo.max_file_size}KB, enable_network=${configInfo.enable_network}`
      );
    }

    // 4-8. Language smoke execution & normalized output checks
    for (const sample of DIAGNOSTIC_PROGRAMS) {
      const res = await runAndEvaluate({
        judge0Service,
        language: sample.key,
        sourceCode: sample.sourceCode,
        stdin: sample.stdin,
        expectedOutput: sample.expectedOutput
      });
      latencies.push(res.durationMs);

      if (res.verdict.verdict !== EXECUTION_STATUSES.ACCEPTED) {
        throw new Error(
          `${sample.label} execution failed with verdict ${res.verdict.verdict} (statusId=${res.mappedResult.judge0StatusId})`
        );
      }
      logLine('SUCCESS', `${sample.label} execution verified (${res.durationMs}ms)`);
    }

    // 9. Wrong answer check
    {
      const res = await runAndEvaluate({
        judge0Service,
        language: 'PYTHON',
        sourceCode: 'print(999)\n',
        expectedOutput: '42'
      });
      latencies.push(res.durationMs);
      if (res.verdict.verdict !== EXECUTION_STATUSES.WRONG_ANSWER) {
        throw new Error(`Expected WRONG_ANSWER, got ${res.verdict.verdict}`);
      }
      logLine('SUCCESS', `Wrong Answer classification verified (${res.durationMs}ms)`);
    }

    // 10. Compilation error check
    {
      const res = await runAndEvaluate({
        judge0Service,
        language: 'CPP',
        sourceCode: 'int main() { broken_syntax_here }\n',
        expectedOutput: ''
      });
      latencies.push(res.durationMs);
      if (res.verdict.verdict !== EXECUTION_STATUSES.COMPILATION_ERROR) {
        throw new Error(`Expected COMPILATION_ERROR, got ${res.verdict.verdict}`);
      }
      logLine('SUCCESS', `Compilation Error classification verified (${res.durationMs}ms)`);
    }

    // 11. Runtime error check
    {
      const res = await runAndEvaluate({
        judge0Service,
        language: 'PYTHON',
        sourceCode: 'import sys\nsys.exit(2)\n',
        expectedOutput: ''
      });
      latencies.push(res.durationMs);
      if (res.verdict.verdict !== EXECUTION_STATUSES.RUNTIME_ERROR) {
        throw new Error(`Expected RUNTIME_ERROR, got ${res.verdict.verdict}`);
      }
      logLine('SUCCESS', `Runtime Error classification verified (${res.durationMs}ms)`);
    }

    // 12. Time Limit Exceeded check
    {
      const res = await runAndEvaluate({
        judge0Service,
        language: 'C',
        sourceCode: 'int main(void) { volatile int x = 0; while (1) { x++; } return 0; }\n',
        expectedOutput: ''
      });
      latencies.push(res.durationMs);
      if (res.verdict.verdict !== EXECUTION_STATUSES.TIME_LIMIT_EXCEEDED) {
        throw new Error(`Expected TIME_LIMIT_EXCEEDED, got ${res.verdict.verdict}`);
      }
      logLine('SUCCESS', `Time Limit Exceeded classification verified (${res.durationMs}ms)`);
    }

    // 13. Bounded output truncation check (> 262144 bytes)
    {
      const res = await runAndEvaluate({
        judge0Service,
        language: 'PYTHON',
        sourceCode: 'print("A" * 300000)\n',
        expectedOutput: 'A'
      });
      latencies.push(res.durationMs);
      if (
        res.verdict.verdict !== EXECUTION_STATUSES.OUTPUT_LIMIT_EXCEEDED ||
        Buffer.byteLength(res.verdict.actualOutput, 'utf8') > EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES
      ) {
        throw new Error(
          `Expected OUTPUT_LIMIT_EXCEEDED bounded to ${EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES} bytes, got ${res.verdict.verdict}`
        );
      }
      logLine(
        'SUCCESS',
        `Bounded output protection verified (${res.mappedResult.outputMetadata.stdoutBytes} raw bytes capped at ${EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES} bytes)`
      );
    }

    // 14. Invalid auth check
    {
      let rejectedAsExpected = false;
      try {
        await client.getAbout({ tokenOverride: 'invalid-diagnostic-auth-token' });
      } catch (err) {
        if (err.code === JUDGE0_ERROR_CODES.AUTH_FAILED) {
          rejectedAsExpected = true;
        }
      }
      if (!rejectedAsExpected) {
        throw new Error('Expected JUDGE0_AUTH_FAILED for invalid X-Auth-Token');
      }
      logLine('SUCCESS', 'Invalid authentication rejection verified');
    }
  } catch (err) {
    failures += 1;
    logLine('ERROR', `Judge0 verification failed: ${err.message}`);
  }

  const totalMs = Date.now() - startedAt;
  if (latencies.length > 0) {
    const minMs = Math.min(...latencies);
    const maxMs = Math.max(...latencies);
    const avgMs = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    logLine(
      'INFO',
      `Job latency across ${latencies.length} real jobs: min=${minMs}ms, avg=${avgMs}ms, max=${maxMs}ms (total ${totalMs}ms)`
    );
  }

  if (failures === 0) {
    logLine('SUCCESS', 'Execution verification completed');
    console.log('------------------------------------------------');
    process.exit(0);
  }

  console.log('------------------------------------------------');
  process.exit(1);
}

await main();
