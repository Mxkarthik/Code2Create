import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { loadEnv } from '../src/config/env.js';
import { createJudge0Service } from '../src/integrations/judge0/judge0.service.js';
import { DEFAULT_COMPETITION_SLUG, Competition } from '../src/modules/competition/competition.model.js';
import { verifyReferenceSolution } from '../src/modules/execution/referenceVerification.service.js';
import { evaluateProblemSubmission } from '../src/modules/execution/execution.service.js';
import { EVALUATION_MODES, evaluateTestCaseResult } from '../src/modules/execution/testCaseEvaluator.js';
import { Problem } from '../src/modules/problems/problem.model.js';
import { TestCase } from '../src/modules/problems/testCase.model.js';
import { formatSeverityBadge, resolveColorSupport } from '../src/utils/logger.js';

const useColor = resolveColorSupport(process.stdout);

function logLine(kind, message) {
  console.log(`${formatSeverityBadge(kind, useColor)} ${message}`);
}

function parseCliArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (token === '--fixture') {
      args.fixture = true;
    } else if (token === '--persist') {
      args.persist = true;
    } else if (token.startsWith('--problem-id=')) {
      args.problemId = token.slice('--problem-id='.length);
    } else if (token.startsWith('--version=')) {
      args.version = Number(token.slice('--version='.length));
    } else if (token.startsWith('--language=')) {
      args.language = token.slice('--language='.length);
    } else if (token.startsWith('--file=')) {
      args.file = token.slice('--file='.length);
    }
  }
  return args;
}

async function runDisposableFixture(judge0Service) {
  logLine('INFO', 'Running disposable in-memory Two-Sum fixture verification (app DB untouched)');

  const cases = [
    { id: 's1', type: 'SAMPLE', displayOrder: 1, input: '4 9\n2 7 11 15\n', expectedOutput: '0 1' },
    { id: 'h1', type: 'HIDDEN', displayOrder: 1, input: '3 6\n3 2 4\n', expectedOutput: '1 2' },
    { id: 'h2', type: 'HIDDEN', displayOrder: 2, input: '2 6\n3 3\n', expectedOutput: '0 1' }
  ];

  const sourceCode = `import sys
data = list(map(int, sys.stdin.read().split()))
n, target = data[0], data[1]
nums = data[2:2+n]
seen = {}
for i, val in enumerate(nums):
    need = target - val
    if need in seen:
        print(f"{seen[need]} {i}")
        break
    seen[val] = i
`;

  let passed = 0;
  for (const tc of cases) {
    const admission = await judge0Service.createSubmission({
      language: 'PYTHON',
      sourceCode,
      stdin: tc.input
    });
    const mapped = await judge0Service.waitForResult({ token: admission.token });
    const verdict = evaluateTestCaseResult({ mappedResult: mapped, testCase: tc });
    if (!verdict.passed) {
      throw new Error(`Fixture case ${tc.type}#${tc.displayOrder} failed: ${verdict.verdict}`);
    }
    passed += 1;
  }

  logLine('SUCCESS', `Disposable fixture verified (${passed}/${cases.length} sample+hidden cases passed)`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const env = loadEnv();
  const judge0Service = createJudge0Service({
    config: {
      JUDGE0_URL: env.JUDGE0_URL,
      JUDGE0_AUTH_TOKEN: env.JUDGE0_AUTH_TOKEN,
      JUDGE0_MAX_IN_FLIGHT: env.JUDGE0_MAX_IN_FLIGHT,
      JUDGE0_REQUEST_TIMEOUT_MS: env.JUDGE0_REQUEST_TIMEOUT_MS,
      JUDGE0_POLL_INTERVAL_MS: env.JUDGE0_POLL_INTERVAL_MS,
      JUDGE0_POLL_TIMEOUT_MS: env.JUDGE0_POLL_TIMEOUT_MS
    }
  });

  if (args.fixture || !args.problemId) {
    await runDisposableFixture(judge0Service);
    return;
  }

  if (!args.language || !args.file || !Number.isInteger(args.version)) {
    logLine(
      'ERROR',
      'Usage: node scripts/verify-reference.js --problem-id=<id> --version=<n> --language=<C|CPP|PYTHON|JAVA> --file=<path> [--persist] | --fixture'
    );
    process.exit(1);
  }

  const referenceSourceCode = await fs.readFile(path.resolve(args.file), 'utf8');

  await connectDatabase(env.MONGODB_URI, {
    dnsServers: env.MONGODB_DNS_SERVERS,
    allowDnsFallback: env.MONGODB_DNS_FALLBACK,
    silentInitialSuccess: true
  });

  try {
    const comp = await Competition.findOne({ slug: DEFAULT_COMPETITION_SLUG }).lean();
    if (!comp) {
      throw new Error('Default competition not found');
    }

    // Ensure models are registered
    void Problem;
    void TestCase;
    void evaluateProblemSubmission;
    void EVALUATION_MODES;

    const result = await verifyReferenceSolution({
      competitionId: comp._id,
      problemId: new mongoose.Types.ObjectId(args.problemId),
      expectedProblemVersion: args.version,
      language: args.language,
      referenceSourceCode,
      judge0Service,
      persistResult: Boolean(args.persist)
    });

    if (result.verified) {
      logLine(
        'SUCCESS',
        `Reference verified: problem=${result.problemId} v${result.problemVersion} (${result.passedCases}/${result.totalCases} passed, persisted=${result.persisted})`
      );
      process.exitCode = 0;
    } else {
      logLine(
        'ERROR',
        `Reference verification failed: verdict=${result.overallVerdict} (${result.passedCases}/${result.totalCases} passed)`
      );
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

await main();
