import { AppError } from '../../utils/AppError.js';
import { runInTransaction } from '../../utils/transaction.js';
import { DEFAULT_COMPETITION_SLUG } from '../competition/competition.model.js';
import {
  acquireLobbyMutationGuard,
  getActiveCompetition
} from '../competition/competition.service.js';
import {
  EXECUTION_POLICY,
  LANGUAGE_CONFIG,
  buildProblemExecutionLimits,
  getDifficultyConfig,
  getLanguageConfig
} from './language.config.js';
import { PROBLEM_STATUSES, Problem } from './problem.model.js';
import { TEST_CASE_TYPES, TestCase } from './testCase.model.js';

function serializeExecutionLimits(rawLimits) {
  if (!rawLimits) {
    return buildProblemExecutionLimits();
  }

  const perLanguageRaw =
    rawLimits.perLanguage instanceof Map
      ? Object.fromEntries(rawLimits.perLanguage.entries())
      : rawLimits.perLanguage ?? {};

  const perLanguage = {};
  for (const [key, val] of Object.entries(perLanguageRaw)) {
    perLanguage[key] = {
      cpuTimeLimitSeconds: val.cpuTimeLimitSeconds,
      wallTimeLimitSeconds: val.wallTimeLimitSeconds,
      memoryLimitKb: val.memoryLimitKb
    };
  }

  return {
    perLanguage,
    maxSourceCodeBytes: rawLimits.maxSourceCodeBytes ?? EXECUTION_POLICY.MAX_SOURCE_CODE_BYTES,
    maxOutputBytes: rawLimits.maxOutputBytes ?? EXECUTION_POLICY.MAX_CAPTURED_OUTPUT_BYTES,
    networkAccessEnabled: rawLimits.networkAccessEnabled ?? EXECUTION_POLICY.NETWORK_ACCESS_ENABLED,
    oneRunPerJob: rawLimits.oneRunPerJob ?? EXECUTION_POLICY.ONE_RUN_PER_JOB
  };
}

function serializeAdminTestCase(tc) {
  return {
    id: tc._id.toString(),
    problemId: tc.problemId.toString(),
    type: tc.type,
    input: tc.input,
    expectedOutput: tc.expectedOutput,
    explanation: tc.explanation ?? null,
    displayOrder: tc.displayOrder,
    createdAt: tc.createdAt ? new Date(tc.createdAt).toISOString() : null,
    updatedAt: tc.updatedAt ? new Date(tc.updatedAt).toISOString() : null
  };
}

function serializeSampleTestCaseForParticipant(tc) {
  return {
    id: tc._id.toString(),
    input: tc.input,
    expectedOutput: tc.expectedOutput,
    explanation: tc.explanation ?? null,
    displayOrder: tc.displayOrder
  };
}

function createUnverifiedMetadata() {
  return {
    status: 'UNVERIFIED',
    verifiedVersion: null,
    verifiedLanguage: null,
    verifiedAt: null,
    verifiedCaseCount: 0
  };
}

function serializeVerificationMetadata(problem) {
  const raw = problem?.verification;
  const isCurrentVersionVerified =
    raw?.status === 'VERIFIED' &&
    raw?.verifiedVersion !== null &&
    raw?.verifiedVersion === problem?.version;

  return {
    status: isCurrentVersionVerified ? 'VERIFIED' : 'UNVERIFIED',
    verifiedVersion: raw?.verifiedVersion ?? null,
    verifiedLanguage: raw?.verifiedLanguage ?? null,
    verifiedAt: raw?.verifiedAt ? new Date(raw.verifiedAt).toISOString() : null,
    verifiedCaseCount: raw?.verifiedCaseCount ?? 0,
    isStale: raw?.status === 'VERIFIED' && !isCurrentVersionVerified
  };
}

export function serializeAdminProblem(problem, testCases = null) {
  const diffCfg = getDifficultyConfig(problem.difficulty);

  return {
    id: problem._id.toString(),
    competitionId: problem.competitionId.toString(),
    title: problem.title,
    slug: problem.slug,
    difficulty: problem.difficulty,
    rewardDistance: diffCfg.rewardDistance,
    estimatedSolveTime: diffCfg.estimatedSolveTime,
    statement: problem.statement,
    inputFormat: problem.inputFormat,
    outputFormat: problem.outputFormat,
    constraints: problem.constraints,
    allowedLanguages: [...problem.allowedLanguages],
    executionLimits: serializeExecutionLimits(problem.executionLimits),
    status: problem.status,
    displayOrder: problem.displayOrder,
    version: problem.version,
    verification: serializeVerificationMetadata(problem),
    publishedAt: problem.publishedAt ? new Date(problem.publishedAt).toISOString() : null,
    archivedAt: problem.archivedAt ? new Date(problem.archivedAt).toISOString() : null,
    createdAt: problem.createdAt ? new Date(problem.createdAt).toISOString() : null,
    updatedAt: problem.updatedAt ? new Date(problem.updatedAt).toISOString() : null,
    ...(Array.isArray(testCases)
      ? {
          testCases: testCases.map(serializeAdminTestCase)
        }
      : {})
  };
}

/**
 * Participant-safe list serializer: selection metadata only.
 * Never exposes full statements, sample cases, hidden tests, or admin fields.
 */
export function serializeParticipantProblemSummary(problem) {
  const diffCfg = getDifficultyConfig(problem.difficulty);
  return {
    id: problem._id.toString(),
    title: problem.title,
    slug: problem.slug,
    difficulty: problem.difficulty,
    rewardDistance: diffCfg.rewardDistance,
    estimatedSolveTime: diffCfg.estimatedSolveTime,
    allowedLanguages: [...problem.allowedLanguages],
    displayOrder: problem.displayOrder
  };
}

/**
 * Reusable participant-safe full detail serializer for Phase 08 (active ChallengeAttempt).
 * Strictly filters sampleTestCases to type === 'SAMPLE' and never leaks hidden tests.
 */
export function serializeParticipantProblemDetail(problem, testCases = []) {
  const diffCfg = getDifficultyConfig(problem.difficulty);
  const sampleOnly = testCases
    .filter((tc) => tc.type === TEST_CASE_TYPES.SAMPLE)
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map(serializeSampleTestCaseForParticipant);

  const limits = serializeExecutionLimits(problem.executionLimits);
  const starterTemplates = {};
  const supportedLanguages = [];

  for (const langKey of problem.allowedLanguages) {
    const cfg = getLanguageConfig(langKey);
    starterTemplates[langKey] = cfg.starterTemplate;
    supportedLanguages.push({
      key: cfg.key,
      displayName: cfg.displayName,
      fileExtension: cfg.fileExtension,
      executionLimits: limits.perLanguage[langKey] ?? cfg.executionLimits
    });
  }

  return {
    id: problem._id.toString(),
    title: problem.title,
    slug: problem.slug,
    difficulty: problem.difficulty,
    rewardDistance: diffCfg.rewardDistance,
    estimatedSolveTime: diffCfg.estimatedSolveTime,
    statement: problem.statement,
    inputFormat: problem.inputFormat,
    outputFormat: problem.outputFormat,
    constraints: problem.constraints,
    supportedLanguages,
    starterTemplates,
    executionPolicy: {
      maxSourceCodeBytes: limits.maxSourceCodeBytes,
      maxOutputBytes: limits.maxOutputBytes
    },
    sampleTestCases: sampleOnly
  };
}

function evaluateProblemStructure(problem, testCases) {
  const issues = [];

  if (!problem.title || problem.title.trim().length < 3) {
    issues.push({ code: 'INVALID_TITLE', message: 'Valid title (>= 3 chars) is required' });
  }
  if (!problem.statement || problem.statement.trim().length < 10) {
    issues.push({
      code: 'INCOMPLETE_STATEMENT',
      message: 'Problem statement must be at least 10 characters'
    });
  }
  if (!problem.inputFormat || problem.inputFormat.trim().length < 1) {
    issues.push({ code: 'MISSING_INPUT_FORMAT', message: 'Input format is required' });
  }
  if (!problem.outputFormat || problem.outputFormat.trim().length < 1) {
    issues.push({ code: 'MISSING_OUTPUT_FORMAT', message: 'Output format is required' });
  }
  if (!problem.constraints || problem.constraints.trim().length < 1) {
    issues.push({ code: 'MISSING_CONSTRAINTS', message: 'Constraints are required' });
  }
  if (!Array.isArray(problem.allowedLanguages) || problem.allowedLanguages.length < 1) {
    issues.push({
      code: 'NO_ALLOWED_LANGUAGES',
      message: 'At least one allowed language is required'
    });
  }

  const limits = serializeExecutionLimits(problem.executionLimits);
  for (const lang of problem.allowedLanguages ?? []) {
    if (!limits.perLanguage?.[lang]) {
      issues.push({
        code: 'MISSING_EXECUTION_LIMITS',
        message: `Execution limits missing for language ${lang}`
      });
    }
  }

  const sampleCases = testCases
    .filter((tc) => tc.type === TEST_CASE_TYPES.SAMPLE)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const hiddenCases = testCases
    .filter((tc) => tc.type === TEST_CASE_TYPES.HIDDEN)
    .sort((a, b) => a.displayOrder - b.displayOrder);

  if (sampleCases.length < 1) {
    issues.push({
      code: 'MISSING_SAMPLE_TEST_CASES',
      message: 'At least one SAMPLE test case is required to publish'
    });
  }
  if (hiddenCases.length < 1) {
    issues.push({
      code: 'MISSING_HIDDEN_TEST_CASES',
      message: 'At least one HIDDEN test case is required to publish'
    });
  }

  const hasDuplicateOrder = (cases) => {
    const orders = new Set(cases.map((c) => c.displayOrder));
    return orders.size !== cases.length;
  };
  if (hasDuplicateOrder(sampleCases) || hasDuplicateOrder(hiddenCases)) {
    issues.push({
      code: 'INVALID_TEST_CASE_ORDER',
      message: 'Test case displayOrder values must be unique per type'
    });
  }

  return {
    structurallyValid: issues.length === 0,
    issues,
    sampleCount: sampleCases.length,
    hiddenCount: hiddenCases.length,
    qualityRecommendation: {
      recommendedSampleCount: 2,
      recommendedHiddenCount: 6,
      meetsSampleRecommendation: sampleCases.length >= 2,
      meetsHiddenRecommendation: hiddenCases.length >= 6,
      executionVerificationStatus: 'PENDING_JUDGE0_VERIFICATION'
    }
  };
}

function mapProblemDuplicateError(err) {
  if (err?.code !== 11000) {
    return err;
  }
  const pattern = err.keyPattern ?? {};
  if (pattern.slug) {
    return new AppError('A problem with this slug already exists in this competition', {
      statusCode: 409,
      code: 'PROBLEM_SLUG_TAKEN'
    });
  }
  if (pattern.displayOrder) {
    return new AppError(
      'A test case with this displayOrder already exists for this problem and type',
      {
        statusCode: 409,
        code: 'TEST_CASE_ORDER_CONFLICT'
      }
    );
  }
  return new AppError('Conflicting problem record', {
    statusCode: 409,
    code: 'PROBLEM_STATE_CONFLICT'
  });
}

export async function createProblem({
  adminUser,
  payload,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const executionLimits = buildProblemExecutionLimits(
    payload.allowedLanguages,
    payload.executionLimits
  );

  let created;
  try {
    created = await runInTransaction(async (session) => {
      const competition = await getActiveCompetition({ slug: competitionSlug, session });
      const guarded = await acquireLobbyMutationGuard({
        competitionId: competition._id,
        session
      });

      const existingSlug = await Problem.exists({
        competitionId: guarded._id,
        slug: payload.slug
      }).session(session);

      if (existingSlug) {
        throw new AppError('A problem with this slug already exists in this competition', {
          statusCode: 409,
          code: 'PROBLEM_SLUG_TAKEN'
        });
      }

      const [problem] = await Problem.create(
        [
          {
            competitionId: guarded._id,
            title: payload.title,
            slug: payload.slug,
            difficulty: payload.difficulty,
            statement: payload.statement,
            inputFormat: payload.inputFormat,
            outputFormat: payload.outputFormat,
            constraints: payload.constraints,
            allowedLanguages: payload.allowedLanguages,
            executionLimits,
            status: PROBLEM_STATUSES.DRAFT,
            displayOrder: payload.displayOrder ?? 1,
            version: 1,
            createdBy: adminUser._id,
            updatedBy: adminUser._id
          }
        ],
        { session }
      );

      return serializeAdminProblem(problem, []);
    });
  } catch (err) {
    throw mapProblemDuplicateError(err);
  }

  if (typeof logger?.success === 'function') {
    logger.success(
      { problemId: created.id, difficulty: created.difficulty },
      'Problem created'
    );
  } else {
    logger?.info({ problemId: created.id }, 'Problem created');
  }

  return created;
}

export async function listAdminProblems({
  difficulty,
  status,
  page = 1,
  limit = 20,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const competition = await getActiveCompetition({ slug: competitionSlug });
  const filter = { competitionId: competition._id };
  if (difficulty) {
    filter.difficulty = difficulty;
  }
  if (status) {
    filter.status = status;
  }

  const skip = (page - 1) * limit;
  const total = await Problem.countDocuments(filter);
  const problems = await Problem.find(filter)
    .sort({ difficulty: 1, displayOrder: 1, createdAt: 1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const problemIds = problems.map((p) => p._id);
  const counts =
    problemIds.length > 0
      ? await TestCase.aggregate([
          { $match: { problemId: { $in: problemIds } } },
          { $group: { _id: { problemId: '$problemId', type: '$type' }, count: { $sum: 1 } } }
        ])
      : [];

  const countMap = new Map();
  for (const row of counts) {
    const pid = row._id.problemId.toString();
    if (!countMap.has(pid)) {
      countMap.set(pid, { sampleCount: 0, hiddenCount: 0 });
    }
    if (row._id.type === TEST_CASE_TYPES.SAMPLE) {
      countMap.get(pid).sampleCount = row.count;
    } else {
      countMap.get(pid).hiddenCount = row.count;
    }
  }

  return {
    problems: problems.map((p) => {
      const c = countMap.get(p._id.toString()) ?? { sampleCount: 0, hiddenCount: 0 };
      return {
        ...serializeAdminProblem(p),
        testCaseCounts: c
      };
    }),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit))
    }
  };
}

export async function getAdminProblemById({
  problemId,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const competition = await getActiveCompetition({ slug: competitionSlug });
  const problem = await Problem.findOne({
    _id: problemId,
    competitionId: competition._id
  }).lean();

  if (!problem) {
    throw AppError.notFound('Problem not found', 'PROBLEM_NOT_FOUND');
  }

  const testCases = await TestCase.find({
    problemId: problem._id,
    competitionId: competition._id
  })
    .sort({ type: 1, displayOrder: 1 })
    .lean();

  return {
    problem: serializeAdminProblem(problem, testCases),
    publicationCheck: evaluateProblemStructure(problem, testCases)
  };
}

export async function updateProblem({
  adminUser,
  problemId,
  expectedVersion,
  updates,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  let updated;
  try {
    updated = await runInTransaction(async (session) => {
      const competition = await getActiveCompetition({ slug: competitionSlug, session });
      const guarded = await acquireLobbyMutationGuard({
        competitionId: competition._id,
        session
      });

      const existing = await Problem.findOne({
        _id: problemId,
        competitionId: guarded._id
      })
        .session(session)
        .lean();

      if (!existing) {
        throw AppError.notFound('Problem not found', 'PROBLEM_NOT_FOUND');
      }

      if (existing.status !== PROBLEM_STATUSES.DRAFT) {
        throw new AppError(
          `Cannot modify a ${existing.status} problem directly; unpublish it first during LOBBY`,
          {
            statusCode: 409,
            code: 'PROBLEM_IMMUTABLE'
          }
        );
      }

      if (existing.version !== expectedVersion) {
        throw new AppError(
          `Problem version conflict: expected ${expectedVersion}, current is ${existing.version}`,
          {
            statusCode: 409,
            code: 'PROBLEM_VERSION_CONFLICT'
          }
        );
      }

      const nextLanguages = updates.allowedLanguages ?? existing.allowedLanguages;
      const nextLimits =
        updates.allowedLanguages !== undefined || updates.executionLimits !== undefined
          ? buildProblemExecutionLimits(nextLanguages, updates.executionLimits)
          : undefined;

      const setFields = {
        updatedBy: adminUser._id,
        verification: createUnverifiedMetadata()
      };

      for (const field of [
        'title',
        'slug',
        'difficulty',
        'statement',
        'inputFormat',
        'outputFormat',
        'constraints',
        'allowedLanguages',
        'displayOrder'
      ]) {
        if (updates[field] !== undefined) {
          setFields[field] = updates[field];
        }
      }

      if (nextLimits !== undefined) {
        setFields.executionLimits = nextLimits;
      }

      const saved = await Problem.findOneAndUpdate(
        {
          _id: problemId,
          competitionId: guarded._id,
          status: PROBLEM_STATUSES.DRAFT,
          version: expectedVersion
        },
        {
          $set: setFields,
          $inc: { version: 1 }
        },
        { session, returnDocument: 'after', runValidators: true }
      ).lean();

      if (!saved) {
        throw new AppError('Problem changed concurrently', {
          statusCode: 409,
          code: 'PROBLEM_VERSION_CONFLICT'
        });
      }

      const testCases = await TestCase.find({
        problemId: saved._id,
        competitionId: guarded._id
      })
        .sort({ type: 1, displayOrder: 1 })
        .session(session)
        .lean();

      return serializeAdminProblem(saved, testCases);
    });
  } catch (err) {
    throw mapProblemDuplicateError(err);
  }

  logger?.info({ problemId: updated.id, version: updated.version }, 'Draft problem updated');
  return updated;
}

export async function deleteDraftProblem({
  problemId,
  expectedVersion,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const deletedId = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guarded = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session
    });

    const existing = await Problem.findOne({
      _id: problemId,
      competitionId: guarded._id
    })
      .session(session)
      .lean();

    if (!existing) {
      throw AppError.notFound('Problem not found', 'PROBLEM_NOT_FOUND');
    }

    if (existing.status !== PROBLEM_STATUSES.DRAFT) {
      throw new AppError(
        'Only DRAFT problems can be deleted; archive published problems instead',
        {
          statusCode: 409,
          code: 'PROBLEM_IMMUTABLE'
        }
      );
    }

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new AppError('Problem version conflict', {
        statusCode: 409,
        code: 'PROBLEM_VERSION_CONFLICT'
      });
    }

    await TestCase.deleteMany({
      problemId: existing._id,
      competitionId: guarded._id
    }).session(session);

    await Problem.deleteOne({ _id: existing._id }).session(session);
    return existing._id.toString();
  });

  logger?.info({ problemId: deletedId }, 'Draft problem deleted');
  return { deletedProblemId: deletedId };
}

export async function publishProblem({
  adminUser,
  problemId,
  expectedVersion,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now()
}) {
  let result;
  try {
    result = await runInTransaction(async (session) => {
      const competition = await getActiveCompetition({ slug: competitionSlug, session });
      const guarded = await acquireLobbyMutationGuard({
        competitionId: competition._id,
        session
      });

      const problem = await Problem.findOne({
        _id: problemId,
        competitionId: guarded._id
      })
        .session(session)
        .lean();

      if (!problem) {
        throw AppError.notFound('Problem not found', 'PROBLEM_NOT_FOUND');
      }

      if (problem.status !== PROBLEM_STATUSES.DRAFT) {
        throw new AppError(
          `Only DRAFT problems can be published (current status: ${problem.status})`,
          {
            statusCode: 409,
            code: 'INVALID_PROBLEM_STATE'
          }
        );
      }

      if (expectedVersion !== undefined && problem.version !== expectedVersion) {
        throw new AppError('Problem version conflict', {
          statusCode: 409,
          code: 'PROBLEM_VERSION_CONFLICT'
        });
      }

      const testCases = await TestCase.find({
        problemId: problem._id,
        competitionId: guarded._id
      })
        .sort({ type: 1, displayOrder: 1 })
        .session(session)
        .lean();

      const check = evaluateProblemStructure(problem, testCases);
      if (!check.structurallyValid) {
        throw new AppError('Problem failed publication validation', {
          statusCode: 409,
          code: 'PROBLEM_PUBLICATION_INVALID',
          details: check.issues
        });
      }

      const published = await Problem.findOneAndUpdate(
        {
          _id: problem._id,
          competitionId: guarded._id,
          status: PROBLEM_STATUSES.DRAFT,
          version: problem.version
        },
        {
          $set: {
            status: PROBLEM_STATUSES.PUBLISHED,
            publishedAt: new Date(nowFn()),
            updatedBy: adminUser._id
          },
          $inc: { version: 1 }
        },
        { session, returnDocument: 'after' }
      ).lean();

      if (!savedOrPublished(published)) {
        throw new AppError('Problem changed concurrently during publication', {
          statusCode: 409,
          code: 'PROBLEM_VERSION_CONFLICT'
        });
      }

      return {
        problem: serializeAdminProblem(published, testCases),
        publicationCheck: check
      };
    });
  } catch (err) {
    if (err?.code === 'PROBLEM_PUBLICATION_INVALID') {
      logger?.warn(
        {
          problemId,
          issueCodes: (err.details ?? []).map((i) => i.code)
        },
        'Problem publication validation failed'
      );
    }
    throw err;
  }

  if (typeof logger?.success === 'function') {
    logger.success(
      { problemId: result.problem.id, version: result.problem.version },
      'Problem published'
    );
  } else {
    logger?.info({ problemId: result.problem.id }, 'Problem published');
  }

  return result;
}

function savedOrPublished(doc) {
  return Boolean(doc);
}

export async function unpublishProblem({
  adminUser,
  problemId,
  expectedVersion,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const result = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guarded = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session
    });

    const problem = await Problem.findOne({
      _id: problemId,
      competitionId: guarded._id
    })
      .session(session)
      .lean();

    if (!problem) {
      throw AppError.notFound('Problem not found', 'PROBLEM_NOT_FOUND');
    }

    if (problem.status !== PROBLEM_STATUSES.PUBLISHED) {
      throw new AppError(
        `Only PUBLISHED problems can be unpublished (current status: ${problem.status})`,
        {
          statusCode: 409,
          code: 'INVALID_PROBLEM_STATE'
        }
      );
    }

    if (expectedVersion !== undefined && problem.version !== expectedVersion) {
      throw new AppError('Problem version conflict', {
        statusCode: 409,
        code: 'PROBLEM_VERSION_CONFLICT'
      });
    }

    const updated = await Problem.findOneAndUpdate(
      {
        _id: problem._id,
        competitionId: guarded._id,
        status: PROBLEM_STATUSES.PUBLISHED,
        version: problem.version
      },
      {
        $set: {
          status: PROBLEM_STATUSES.DRAFT,
          publishedAt: null,
          updatedBy: adminUser._id
        },
        $inc: { version: 1 }
      },
      { session, returnDocument: 'after' }
    ).lean();

    if (!updated) {
      throw new AppError('Problem changed concurrently', {
        statusCode: 409,
        code: 'PROBLEM_VERSION_CONFLICT'
      });
    }

    return serializeAdminProblem(updated);
  });

  logger?.info({ problemId: result.id, version: result.version }, 'Problem unpublished');
  return result;
}

export async function archiveProblem({
  adminUser,
  problemId,
  expectedVersion,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now()
}) {
  const result = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guarded = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session
    });

    const problem = await Problem.findOne({
      _id: problemId,
      competitionId: guarded._id
    })
      .session(session)
      .lean();

    if (!problem) {
      throw AppError.notFound('Problem not found', 'PROBLEM_NOT_FOUND');
    }

    if (problem.status === PROBLEM_STATUSES.ARCHIVED) {
      throw new AppError('Problem is already archived', {
        statusCode: 409,
        code: 'INVALID_PROBLEM_STATE'
      });
    }

    if (expectedVersion !== undefined && problem.version !== expectedVersion) {
      throw new AppError('Problem version conflict', {
        statusCode: 409,
        code: 'PROBLEM_VERSION_CONFLICT'
      });
    }

    const updated = await Problem.findOneAndUpdate(
      {
        _id: problem._id,
        competitionId: guarded._id,
        version: problem.version
      },
      {
        $set: {
          status: PROBLEM_STATUSES.ARCHIVED,
          archivedAt: new Date(nowFn()),
          updatedBy: adminUser._id
        },
        $inc: { version: 1 }
      },
      { session, returnDocument: 'after' }
    ).lean();

    if (!updated) {
      throw new AppError('Problem changed concurrently', {
        statusCode: 409,
        code: 'PROBLEM_VERSION_CONFLICT'
      });
    }

    return serializeAdminProblem(updated);
  });

  logger?.info({ problemId: result.id, version: result.version }, 'Problem archived');
  return result;
}

export async function listAdminTestCases({
  problemId,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const competition = await getActiveCompetition({ slug: competitionSlug });
  const problem = await Problem.findOne({
    _id: problemId,
    competitionId: competition._id
  }).lean();

  if (!problem) {
    throw AppError.notFound('Problem not found', 'PROBLEM_NOT_FOUND');
  }

  const testCases = await TestCase.find({
    problemId: problem._id,
    competitionId: competition._id
  })
    .sort({ type: 1, displayOrder: 1 })
    .lean();

  return {
    problemId: problem._id.toString(),
    problemVersion: problem.version,
    problemStatus: problem.status,
    testCases: testCases.map(serializeAdminTestCase)
  };
}

export async function createTestCase({
  adminUser,
  problemId,
  payload,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  try {
    return await runInTransaction(async (session) => {
      const competition = await getActiveCompetition({ slug: competitionSlug, session });
      const guarded = await acquireLobbyMutationGuard({
        competitionId: competition._id,
        session
      });

      const problem = await Problem.findOne({
        _id: problemId,
        competitionId: guarded._id
      })
        .session(session)
        .lean();

      if (!problem) {
        throw AppError.notFound('Problem not found', 'PROBLEM_NOT_FOUND');
      }

      if (problem.status !== PROBLEM_STATUSES.DRAFT) {
        throw new AppError(
          `Cannot modify test cases on a ${problem.status} problem; unpublish it first during LOBBY`,
          {
            statusCode: 409,
            code: 'PROBLEM_IMMUTABLE'
          }
        );
      }

      if (
        payload.expectedProblemVersion !== undefined &&
        problem.version !== payload.expectedProblemVersion
      ) {
        throw new AppError('Problem version conflict', {
          statusCode: 409,
          code: 'PROBLEM_VERSION_CONFLICT'
        });
      }

      const [created] = await TestCase.create(
        [
          {
            competitionId: guarded._id,
            problemId: problem._id,
            type: payload.type,
            input: payload.input,
            expectedOutput: payload.expectedOutput,
            explanation:
              payload.type === TEST_CASE_TYPES.SAMPLE ? payload.explanation ?? null : null,
            displayOrder: payload.displayOrder
          }
        ],
        { session }
      );

      const updatedProblem = await Problem.findOneAndUpdate(
        {
          _id: problem._id,
          status: PROBLEM_STATUSES.DRAFT,
          version: problem.version
        },
        {
          $set: {
            updatedBy: adminUser._id,
            verification: createUnverifiedMetadata()
          },
          $inc: { version: 1 }
        },
        { session, returnDocument: 'after' }
      ).lean();

      if (!updatedProblem) {
        throw new AppError('Problem changed concurrently', {
          statusCode: 409,
          code: 'PROBLEM_VERSION_CONFLICT'
        });
      }

      return {
        testCase: serializeAdminTestCase(created),
        problemVersion: updatedProblem.version
      };
    });
  } catch (err) {
    throw mapProblemDuplicateError(err);
  }
}

export async function updateTestCase({
  adminUser,
  problemId,
  testCaseId,
  expectedProblemVersion,
  updates,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  try {
    return await runInTransaction(async (session) => {
      const competition = await getActiveCompetition({ slug: competitionSlug, session });
      const guarded = await acquireLobbyMutationGuard({
        competitionId: competition._id,
        session
      });

      const problem = await Problem.findOne({
        _id: problemId,
        competitionId: guarded._id
      })
        .session(session)
        .lean();

      if (!problem) {
        throw AppError.notFound('Problem not found', 'PROBLEM_NOT_FOUND');
      }

      if (problem.status !== PROBLEM_STATUSES.DRAFT) {
        throw new AppError(
          `Cannot modify test cases on a ${problem.status} problem; unpublish it first during LOBBY`,
          {
            statusCode: 409,
            code: 'PROBLEM_IMMUTABLE'
          }
        );
      }

      if (
        expectedProblemVersion !== undefined &&
        problem.version !== expectedProblemVersion
      ) {
        throw new AppError('Problem version conflict', {
          statusCode: 409,
          code: 'PROBLEM_VERSION_CONFLICT'
        });
      }

      const existingTc = await TestCase.findOne({
        _id: testCaseId,
        problemId: problem._id,
        competitionId: guarded._id
      })
        .session(session)
        .lean();

      if (!existingTc) {
        throw AppError.notFound(
          'Test case not found for this problem',
          'TEST_CASE_NOT_FOUND'
        );
      }

      const setFields = {};
      if (updates.input !== undefined) {
        setFields.input = updates.input;
      }
      if (updates.expectedOutput !== undefined) {
        setFields.expectedOutput = updates.expectedOutput;
      }
      if (updates.displayOrder !== undefined) {
        setFields.displayOrder = updates.displayOrder;
      }
      if (updates.explanation !== undefined) {
        setFields.explanation =
          existingTc.type === TEST_CASE_TYPES.SAMPLE ? updates.explanation : null;
      }

      const updatedTc = await TestCase.findOneAndUpdate(
        {
          _id: existingTc._id,
          problemId: problem._id,
          competitionId: guarded._id
        },
        { $set: setFields },
        { session, returnDocument: 'after', runValidators: true }
      ).lean();

      const updatedProblem = await Problem.findOneAndUpdate(
        {
          _id: problem._id,
          status: PROBLEM_STATUSES.DRAFT,
          version: problem.version
        },
        {
          $set: {
            updatedBy: adminUser._id,
            verification: createUnverifiedMetadata()
          },
          $inc: { version: 1 }
        },
        { session, returnDocument: 'after' }
      ).lean();

      if (!updatedProblem) {
        throw new AppError('Problem changed concurrently', {
          statusCode: 409,
          code: 'PROBLEM_VERSION_CONFLICT'
        });
      }

      return {
        testCase: serializeAdminTestCase(updatedTc),
        problemVersion: updatedProblem.version
      };
    });
  } catch (err) {
    throw mapProblemDuplicateError(err);
  }
}

export async function deleteTestCase({
  adminUser,
  problemId,
  testCaseId,
  expectedProblemVersion,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  return runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guarded = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session
    });

    const problem = await Problem.findOne({
      _id: problemId,
      competitionId: guarded._id
    })
      .session(session)
      .lean();

    if (!problem) {
      throw AppError.notFound('Problem not found', 'PROBLEM_NOT_FOUND');
    }

    if (problem.status !== PROBLEM_STATUSES.DRAFT) {
      throw new AppError(
        `Cannot delete test cases from a ${problem.status} problem; unpublish it first during LOBBY`,
        {
          statusCode: 409,
          code: 'PROBLEM_IMMUTABLE'
        }
      );
    }

    if (
      expectedProblemVersion !== undefined &&
      problem.version !== expectedProblemVersion
    ) {
      throw new AppError('Problem version conflict', {
        statusCode: 409,
        code: 'PROBLEM_VERSION_CONFLICT'
      });
    }

    const deleted = await TestCase.findOneAndDelete({
      _id: testCaseId,
      problemId: problem._id,
      competitionId: guarded._id
    })
      .session(session)
      .lean();

    if (!deleted) {
      throw AppError.notFound(
        'Test case not found for this problem',
        'TEST_CASE_NOT_FOUND'
      );
    }

    const updatedProblem = await Problem.findOneAndUpdate(
      {
        _id: problem._id,
        status: PROBLEM_STATUSES.DRAFT,
        version: problem.version
      },
      {
        $set: {
          updatedBy: adminUser._id,
          verification: createUnverifiedMetadata()
        },
        $inc: { version: 1 }
      },
      { session, returnDocument: 'after' }
    ).lean();

    if (!updatedProblem) {
      throw new AppError('Problem changed concurrently', {
        statusCode: 409,
        code: 'PROBLEM_VERSION_CONFLICT'
      });
    }

    return {
      deletedTestCaseId: deleted._id.toString(),
      problemVersion: updatedProblem.version
    };
  });
}

/**
 * Evaluate overall problem bank structural readiness vs. the recommended 18-problem pool (6/6/6).
 */
export async function getProblemBankReadiness({
  targetPerDifficulty = 6,
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now()
} = {}) {
  const competition = await getActiveCompetition({ slug: competitionSlug });
  const problems = await Problem.find({ competitionId: competition._id }).lean();

  let totalDraft = 0;
  let totalPublished = 0;
  let totalArchived = 0;
  const publishedByDifficulty = { EASY: 0, MEDIUM: 0, HARD: 0 };
  const publishedIds = [];

  for (const p of problems) {
    if (p.status === PROBLEM_STATUSES.DRAFT) {
      totalDraft += 1;
    } else if (p.status === PROBLEM_STATUSES.PUBLISHED) {
      totalPublished += 1;
      publishedByDifficulty[p.difficulty] = (publishedByDifficulty[p.difficulty] ?? 0) + 1;
      publishedIds.push(p._id);
    } else if (p.status === PROBLEM_STATUSES.ARCHIVED) {
      totalArchived += 1;
    }
  }

  const publishedTestCases =
    publishedIds.length > 0
      ? await TestCase.find({
          competitionId: competition._id,
          problemId: { $in: publishedIds }
        }).lean()
      : [];

  const tcByProblem = new Map();
  for (const tc of publishedTestCases) {
    const key = tc.problemId.toString();
    if (!tcByProblem.has(key)) {
      tcByProblem.set(key, []);
    }
    tcByProblem.get(key).push(tc);
  }

  const structuralIssues = [];
  for (const p of problems) {
    if (p.status !== PROBLEM_STATUSES.PUBLISHED) {
      continue;
    }
    const check = evaluateProblemStructure(p, tcByProblem.get(p._id.toString()) ?? []);
    if (!check.structurallyValid) {
      structuralIssues.push({
        problemId: p._id.toString(),
        title: p.title,
        issues: check.issues
      });
    }
  }

  for (const difficulty of ['EASY', 'MEDIUM', 'HARD']) {
    const actual = publishedByDifficulty[difficulty];
    if (actual < targetPerDifficulty) {
      structuralIssues.push({
        code: 'INSUFFICIENT_PUBLISHED_PROBLEMS',
        difficulty,
        currentCount: actual,
        targetCount: targetPerDifficulty,
        message: `${difficulty} has ${actual}/${targetPerDifficulty} published problems`
      });
    }
  }

  return {
    competitionId: competition._id.toString(),
    competitionStatus: competition.status,
    counts: {
      totalDraft,
      totalPublished,
      totalArchived,
      publishedByDifficulty
    },
    targetPerDifficulty,
    recommendedTotalPublished: targetPerDifficulty * 3,
    structurallyReady: structuralIssues.length === 0,
    structuralIssues,
    executionVerificationPending: true,
    verificationStatus: 'PENDING_JUDGE0_INTEGRATION',
    serverTime: new Date(nowFn()).toISOString()
  };
}

/**
 * Participant-safe list of published problems during LIVE competition.
 */
export async function listParticipantProblems({ competitionId }) {
  const problems = await Problem.find({
    competitionId,
    status: PROBLEM_STATUSES.PUBLISHED
  })
    .sort({ difficulty: 1, displayOrder: 1, createdAt: 1 })
    .lean();

  return problems.map(serializeParticipantProblemSummary);
}

/**
 * Internal backend-only execution retrieval service for Phase 06/07 Judge0 pipeline.
 * Never expose this directly through an unauthenticated or participant-facing HTTP route.
 */
export async function getInternalExecutionProblem({
  competitionId,
  problemId,
  expectedVersion,
  includeUnpublished = false
}) {
  const statusFilter = includeUnpublished
    ? { $in: [PROBLEM_STATUSES.DRAFT, PROBLEM_STATUSES.PUBLISHED] }
    : PROBLEM_STATUSES.PUBLISHED;

  const problem = await Problem.findOne({
    _id: problemId,
    competitionId,
    status: statusFilter
  }).lean();

  if (!problem) {
    throw AppError.notFound(
      includeUnpublished
        ? 'Problem not found for verification'
        : 'Published problem not found for execution',
      'PROBLEM_NOT_FOUND'
    );
  }

  if (expectedVersion !== undefined && problem.version !== expectedVersion) {
    throw new AppError('Published problem version mismatch', {
      statusCode: 409,
      code: 'PROBLEM_VERSION_CONFLICT'
    });
  }

  const testCases = await TestCase.find({
    competitionId,
    problemId: problem._id
  })
    .sort({ type: 1, displayOrder: 1 })
    .lean();

  const limits = serializeExecutionLimits(problem.executionLimits);
  const languageConfigs = {};
  for (const key of problem.allowedLanguages) {
    const baseCfg = getLanguageConfig(key);
    languageConfigs[key] = {
      key: baseCfg.key,
      displayName: baseCfg.displayName,
      judge0LanguageId: baseCfg.judge0LanguageId,
      fileExtension: baseCfg.fileExtension,
      executionLimits: limits.perLanguage[key] ?? baseCfg.executionLimits
    };
  }

  const diffCfg = getDifficultyConfig(problem.difficulty);

  return {
    problem: {
      id: problem._id.toString(),
      competitionId: problem.competitionId.toString(),
      title: problem.title,
      slug: problem.slug,
      difficulty: problem.difficulty,
      rewardDistance: diffCfg.rewardDistance,
      version: problem.version
    },
    allowedLanguages: [...problem.allowedLanguages],
    languageConfigs,
    executionLimits: limits,
    sampleTestCases: testCases
      .filter((tc) => tc.type === TEST_CASE_TYPES.SAMPLE)
      .map(serializeAdminTestCase),
    hiddenTestCases: testCases
      .filter((tc) => tc.type === TEST_CASE_TYPES.HIDDEN)
      .map(serializeAdminTestCase)
  };
}
