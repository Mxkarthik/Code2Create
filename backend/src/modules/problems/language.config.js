import { AppError } from '../../utils/AppError.js';

export const PROBLEM_DIFFICULTIES = Object.freeze({
  EASY: 'EASY',
  MEDIUM: 'MEDIUM',
  HARD: 'HARD'
});

export const DIFFICULTY_CONFIG = Object.freeze({
  EASY: Object.freeze({
    difficulty: 'EASY',
    rewardDistance: 10,
    estimatedSolveMinutes: Object.freeze({ min: 2, max: 4 }),
    estimatedSolveTime: '2–4 minutes',
    recommendedBankCount: 6
  }),
  MEDIUM: Object.freeze({
    difficulty: 'MEDIUM',
    rewardDistance: 25,
    estimatedSolveMinutes: Object.freeze({ min: 4, max: 7 }),
    estimatedSolveTime: '4–7 minutes',
    recommendedBankCount: 6
  }),
  HARD: Object.freeze({
    difficulty: 'HARD',
    rewardDistance: 45,
    estimatedSolveMinutes: Object.freeze({ min: 7, max: 12 }),
    estimatedSolveTime: '7–12 minutes',
    recommendedBankCount: 6
  })
});

export const EXECUTION_POLICY = Object.freeze({
  MAX_SOURCE_CODE_BYTES: 32 * 1024, // 32 KB
  MAX_CAPTURED_OUTPUT_BYTES: 256 * 1024, // 256 KB
  MAX_TEST_CASE_INPUT_BYTES: 256 * 1024,
  MAX_TEST_CASE_OUTPUT_BYTES: 256 * 1024,
  NETWORK_ACCESS_ENABLED: false,
  ONE_RUN_PER_JOB: true
});

export const EXECUTION_LIMIT_BOUNDS = Object.freeze({
  cpuTimeLimitSeconds: Object.freeze({ min: 1, max: 10 }),
  wallTimeLimitSeconds: Object.freeze({ min: 1, max: 20 }),
  memoryLimitKb: Object.freeze({ min: 16000, max: 512000 })
});

export const LANGUAGE_KEYS = Object.freeze(['C', 'CPP', 'PYTHON', 'JAVA']);

export const LANGUAGE_CONFIG = Object.freeze({
  C: Object.freeze({
    key: 'C',
    displayName: 'C (GCC)',
    judge0LanguageId: 50,
    fileExtension: '.c',
    executionLimits: Object.freeze({
      cpuTimeLimitSeconds: 2,
      wallTimeLimitSeconds: 5,
      memoryLimitKb: 128000,
      maxSourceCodeBytes: EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES,
      maxOutputBytes: EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES
    }),
    starterTemplate: `#include <stdio.h>\n\nint main(void) {\n    // Read input from stdin and write output to stdout\n    return 0;\n}\n`
  }),
  CPP: Object.freeze({
    key: 'CPP',
    displayName: 'C++ (GCC)',
    judge0LanguageId: 54,
    fileExtension: '.cpp',
    executionLimits: Object.freeze({
      cpuTimeLimitSeconds: 2,
      wallTimeLimitSeconds: 5,
      memoryLimitKb: 128000,
      maxSourceCodeBytes: EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES,
      maxOutputBytes: EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES
    }),
    starterTemplate: `#include <iostream>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    // Read input from stdin and write output to stdout\n    return 0;\n}\n`
  }),
  PYTHON: Object.freeze({
    key: 'PYTHON',
    displayName: 'Python 3',
    judge0LanguageId: 71,
    fileExtension: '.py',
    executionLimits: Object.freeze({
      cpuTimeLimitSeconds: 2,
      wallTimeLimitSeconds: 5,
      memoryLimitKb: 128000,
      maxSourceCodeBytes: EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES,
      maxOutputBytes: EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES
    }),
    starterTemplate: `import sys\n\ndef main() -> None:\n    # Read input from stdin and write output to stdout\n    pass\n\nif __name__ == "__main__":\n    main()\n`
  }),
  JAVA: Object.freeze({
    key: 'JAVA',
    displayName: 'Java',
    judge0LanguageId: 62,
    fileExtension: '.java',
    executionLimits: Object.freeze({
      cpuTimeLimitSeconds: 3,
      wallTimeLimitSeconds: 8,
      memoryLimitKb: 256000,
      maxSourceCodeBytes: EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES,
      maxOutputBytes: EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES
    }),
    starterTemplate: `import java.io.*;\n\npublic class Main {\n    public static void main(String[] args) throws Exception {\n        // Read input from stdin and write output to stdout\n    }\n}\n`
  })
});

/**
 * Retrieve trusted server-side configuration for an application language key.
 */
export function getLanguageConfig(languageKey) {
  const normalized = typeof languageKey === 'string' ? languageKey.trim().toUpperCase() : '';
  const config = LANGUAGE_CONFIG[normalized];
  if (!config) {
    throw AppError.badRequest(
      `Unsupported programming language: ${languageKey}`,
      'UNSUPPORTED_LANGUAGE'
    );
  }
  return config;
}

/**
 * Retrieve trusted server-side reward and estimate metadata for a difficulty level.
 */
export function getDifficultyConfig(difficulty) {
  const normalized = typeof difficulty === 'string' ? difficulty.trim().toUpperCase() : '';
  const config = DIFFICULTY_CONFIG[normalized];
  if (!config) {
    throw AppError.badRequest(
      `Invalid difficulty level: ${difficulty}`,
      'INVALID_DIFFICULTY'
    );
  }
  return config;
}

/**
 * Build default server-controlled execution limits profile for a problem.
 * Optional per-language overrides are bounded by EXECUTION_LIMIT_BOUNDS.
 */
export function buildProblemExecutionLimits(allowedLanguages = LANGUAGE_KEYS, overrides = {}) {
  const perLanguage = {};

  for (const key of allowedLanguages) {
    const langCfg = getLanguageConfig(key);
    const custom = overrides?.perLanguage?.[key] ?? {};

    perLanguage[key] = {
      cpuTimeLimitSeconds:
        custom.cpuTimeLimitSeconds ?? langCfg.executionLimits.cpuTimeLimitSeconds,
      wallTimeLimitSeconds:
        custom.wallTimeLimitSeconds ?? langCfg.executionLimits.wallTimeLimitSeconds,
      memoryLimitKb: custom.memoryLimitKb ?? langCfg.executionLimits.memoryLimitKb
    };
  }

  return {
    perLanguage,
    maxSourceCodeBytes: EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES,
    maxOutputBytes: EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES,
    networkAccessEnabled: EXECUTION_POLICY.NETWORK_ACCESS_ENABLED,
    oneRunPerJob: EXECUTION_POLICY.ONE_RUN_PER_JOB
  };
}
