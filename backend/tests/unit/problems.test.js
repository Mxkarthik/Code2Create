import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_POLICY,
  LANGUAGE_CONFIG,
  getDifficultyConfig,
  getLanguageConfig
} from '../../src/modules/problems/language.config.js';
import { compareOutputs } from '../../src/modules/problems/outputComparison.js';
import {
  serializeParticipantProblemDetail,
  serializeParticipantProblemSummary
} from '../../src/modules/problems/problem.service.js';
import {
  validateCreateProblemBody,
  validateCreateTestCaseBody
} from '../../src/modules/problems/problem.validation.js';
import { LOG_FORMATS, createLogger } from '../../src/utils/logger.js';

describe('Phase 05 language config, output comparison, validation, and redaction (unit)', () => {
  it('maps C, C++, Python 3, and Java to verified Judge0 IDs and defaults', () => {
    expect(getLanguageConfig('C').judge0LanguageId).toBe(50);
    expect(getLanguageConfig('CPP').judge0LanguageId).toBe(54);
    expect(getLanguageConfig('PYTHON').judge0LanguageId).toBe(71);
    expect(getLanguageConfig('JAVA').judge0LanguageId).toBe(62);

    expect(LANGUAGE_CONFIG.C.executionLimits.cpuTimeLimitSeconds).toBe(2);
    expect(LANGUAGE_CONFIG.C.executionLimits.wallTimeLimitSeconds).toBe(5);
    expect(LANGUAGE_CONFIG.C.executionLimits.memoryLimitKb).toBe(128000);

    expect(LANGUAGE_CONFIG.JAVA.executionLimits.cpuTimeLimitSeconds).toBe(3);
    expect(LANGUAGE_CONFIG.JAVA.executionLimits.wallTimeLimitSeconds).toBe(8);
    expect(LANGUAGE_CONFIG.JAVA.executionLimits.memoryLimitKb).toBe(256000);
    expect(LANGUAGE_CONFIG.JAVA.starterTemplate).toContain('public class Main');

    expect(EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES).toBe(32768);
    expect(EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES).toBe(262144);
    expect(EXECUTION_POLICY.NETWORK_ACCESS_ENABLED).toBe(false);
    expect(EXECUTION_POLICY.ONE_RUN_PER_JOB).toBe(true);

    expect(() => getLanguageConfig('RUBY')).toThrow(/Unsupported programming language/);
  });

  it('derives server-side difficulty rewards and rejects invalid difficulties', () => {
    expect(getDifficultyConfig('EASY').rewardDistance).toBe(10);
    expect(getDifficultyConfig('MEDIUM').rewardDistance).toBe(25);
    expect(getDifficultyConfig('HARD').rewardDistance).toBe(45);
    expect(() => getDifficultyConfig('EXTREME')).toThrow(/Invalid difficulty/);
  });

  it('compares outputs according to strict whitespace and line-ending policy', () => {
    expect(compareOutputs('42\n', '42\n').matched).toBe(true);
    expect(compareOutputs('1 2\r\n3 4\r\n', '1 2\n3 4\n').matched).toBe(true);
    expect(compareOutputs('42   \t\n\n', '42\n').matched).toBe(true);
    expect(compareOutputs('', '\r\n\n').matched).toBe(true);

    // Leading spaces, internal spaces, and case differences must fail
    expect(compareOutputs('  42\n', '42\n').matched).toBe(false);
    expect(compareOutputs('1  2\n', '1 2\n').matched).toBe(false);
    expect(compareOutputs('yes\n', 'YES\n').matched).toBe(false);
    expect(compareOutputs('41\n', '42\n').matched).toBe(false);
  });

  it('validates problem & test case payloads strictly and rejects unsafe HTML or arbitrary overrides', () => {
    expect(() =>
      validateCreateProblemBody({
        title: 'Two Sum',
        difficulty: 'EASY',
        statement: '<script>alert(1)</script> Solve it.',
        inputFormat: 'n',
        outputFormat: 'ans',
        constraints: 'n <= 100'
      })
    ).toThrow(/executable HTML/);

    expect(() =>
      validateCreateProblemBody({
        title: 'Two Sum',
        difficulty: 'EASY',
        statement: 'Given two integers, return their sum.',
        inputFormat: 'a b',
        outputFormat: 'a+b',
        constraints: '1 <= a, b <= 100',
        rewardDistance: 999
      })
    ).toThrow();

    // Preserves meaningful whitespace and allows empty input
    const emptyInputTc = validateCreateTestCaseBody({
      type: 'HIDDEN',
      input: '',
      expectedOutput: '  0\n',
      displayOrder: 1
    });
    expect(emptyInputTc.input).toBe('');
    expect(emptyInputTc.expectedOutput).toBe('  0\n');

    // Rejects oversized payloads
    expect(() =>
      validateCreateTestCaseBody({
        type: 'HIDDEN',
        input: 'x'.repeat(256 * 1024 + 1),
        expectedOutput: '1\n',
        displayOrder: 1
      })
    ).toThrow(/cannot exceed/);
  });

  it('never leaks hidden test cases in participant serializers or structured logs', () => {
    const fakeProblem = {
      _id: { toString: () => 'prob-1' },
      title: 'Sum Two Numbers',
      slug: 'sum-two-numbers',
      difficulty: 'EASY',
      statement: 'Compute a + b.',
      inputFormat: 'Two ints',
      outputFormat: 'One int',
      constraints: '1 <= a,b <= 10^9',
      allowedLanguages: ['C', 'PYTHON'],
      executionLimits: {
        perLanguage: {
          C: { cpuTimeLimitSeconds: 2, wallTimeLimitSeconds: 5, memoryLimitKb: 128000 },
          PYTHON: { cpuTimeLimitSeconds: 2, wallTimeLimitSeconds: 5, memoryLimitKb: 128000 }
        },
        maxSourceCodeBytes: 32768,
        maxOutputBytes: 262144
      },
      displayOrder: 1
    };

    const fakeCases = [
      {
        _id: { toString: () => 'tc-s1' },
        type: 'SAMPLE',
        input: '1 2\n',
        expectedOutput: '3\n',
        explanation: '1+2=3',
        displayOrder: 1
      },
      {
        _id: { toString: () => 'tc-h1' },
        type: 'HIDDEN',
        input: '999 1\n',
        expectedOutput: 'SECRET_HIDDEN_OUT_1000\n',
        displayOrder: 1
      }
    ];

    const summary = serializeParticipantProblemSummary(fakeProblem);
    expect(JSON.stringify(summary)).not.toContain('Compute a + b');
    expect(JSON.stringify(summary)).not.toContain('SECRET_HIDDEN_OUT_1000');

    const detail = serializeParticipantProblemDetail(fakeProblem, fakeCases);
    expect(detail.sampleTestCases).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain('SECRET_HIDDEN_OUT_1000');

    const chunks = [];
    const logger = createLogger({
      level: 'info',
      format: LOG_FORMATS.JSON,
      destination: new Writable({
        write(chunk, _e, cb) {
          chunks.push(chunk.toString('utf8'));
          cb();
        }
      })
    });

    logger.info(
      {
        expectedOutput: 'SECRET_EXPECTED',
        hiddenTestCases: [{ input: 'secret', expectedOutput: 'SECRET_OUT' }]
      },
      'Problem event'
    );
    const logged = chunks.join('');
    expect(logged).not.toContain('SECRET_EXPECTED');
    expect(logged).not.toContain('SECRET_OUT');
  });
});
