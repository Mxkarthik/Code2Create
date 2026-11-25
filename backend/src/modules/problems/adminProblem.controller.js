import {
  archiveProblem,
  createProblem,
  createTestCase,
  deleteDraftProblem,
  deleteTestCase,
  getAdminProblemById,
  getProblemBankReadiness,
  listAdminProblems,
  listAdminTestCases,
  publishProblem,
  unpublishProblem,
  updateProblem,
  updateTestCase
} from './problem.service.js';
import {
  validateAdminProblemsQuery,
  validateCreateProblemBody,
  validateCreateTestCaseBody,
  validateExpectedVersionBody,
  validateObjectIdParam,
  validateUpdateProblemBody,
  validateUpdateTestCaseBody
} from './problem.validation.js';

/**
 * Create administrative controllers for problem and test case management under /api/admin/problems.
 */
export function createAdminProblemController({
  competitionSlug,
  logger,
  nowFn = () => Date.now()
} = {}) {
  async function handleListProblems(req, res, next) {
    try {
      const query = validateAdminProblemsQuery(req.query);
      const result = await listAdminProblems({
        ...query,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...result,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleGetReadiness(req, res, next) {
    try {
      const readiness = await getProblemBankReadiness({
        competitionSlug,
        nowFn
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...readiness,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleGetProblem(req, res, next) {
    try {
      const problemId = validateObjectIdParam(req.params.problemId, 'problemId');
      const result = await getAdminProblemById({
        problemId,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...result,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleCreateProblem(req, res, next) {
    try {
      const payload = validateCreateProblemBody(req.body);
      const problem = await createProblem({
        adminUser: req.user,
        payload,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        success: true,
        problem,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleUpdateProblem(req, res, next) {
    try {
      const problemId = validateObjectIdParam(req.params.problemId, 'problemId');
      const { expectedVersion, updates } = validateUpdateProblemBody(req.body);
      const problem = await updateProblem({
        adminUser: req.user,
        problemId,
        expectedVersion,
        updates,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        problem,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleDeleteProblem(req, res, next) {
    try {
      const problemId = validateObjectIdParam(req.params.problemId, 'problemId');
      const { expectedVersion } = validateExpectedVersionBody(req.body);
      const result = await deleteDraftProblem({
        problemId,
        expectedVersion,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...result,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handlePublishProblem(req, res, next) {
    try {
      const problemId = validateObjectIdParam(req.params.problemId, 'problemId');
      const { expectedVersion } = validateExpectedVersionBody(req.body);
      const result = await publishProblem({
        adminUser: req.user,
        problemId,
        expectedVersion,
        logger: req.log ?? logger,
        competitionSlug,
        nowFn
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...result,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleUnpublishProblem(req, res, next) {
    try {
      const problemId = validateObjectIdParam(req.params.problemId, 'problemId');
      const { expectedVersion } = validateExpectedVersionBody(req.body);
      const problem = await unpublishProblem({
        adminUser: req.user,
        problemId,
        expectedVersion,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        problem,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleArchiveProblem(req, res, next) {
    try {
      const problemId = validateObjectIdParam(req.params.problemId, 'problemId');
      const { expectedVersion } = validateExpectedVersionBody(req.body);
      const problem = await archiveProblem({
        adminUser: req.user,
        problemId,
        expectedVersion,
        logger: req.log ?? logger,
        competitionSlug,
        nowFn
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        problem,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleListTestCases(req, res, next) {
    try {
      const problemId = validateObjectIdParam(req.params.problemId, 'problemId');
      const result = await listAdminTestCases({
        problemId,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...result,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleCreateTestCase(req, res, next) {
    try {
      const problemId = validateObjectIdParam(req.params.problemId, 'problemId');
      const payload = validateCreateTestCaseBody(req.body);
      const result = await createTestCase({
        adminUser: req.user,
        problemId,
        payload,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        success: true,
        ...result,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleUpdateTestCase(req, res, next) {
    try {
      const problemId = validateObjectIdParam(req.params.problemId, 'problemId');
      const testCaseId = validateObjectIdParam(req.params.testCaseId, 'testCaseId');
      const { expectedProblemVersion, updates } = validateUpdateTestCaseBody(req.body);
      const result = await updateTestCase({
        adminUser: req.user,
        problemId,
        testCaseId,
        expectedProblemVersion,
        updates,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...result,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleDeleteTestCase(req, res, next) {
    try {
      const problemId = validateObjectIdParam(req.params.problemId, 'problemId');
      const testCaseId = validateObjectIdParam(req.params.testCaseId, 'testCaseId');
      const { expectedVersion } = validateExpectedVersionBody(req.body);
      const result = await deleteTestCase({
        adminUser: req.user,
        problemId,
        testCaseId,
        expectedProblemVersion: expectedVersion,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...result,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    handleListProblems,
    handleGetReadiness,
    handleGetProblem,
    handleCreateProblem,
    handleUpdateProblem,
    handleDeleteProblem,
    handlePublishProblem,
    handleUnpublishProblem,
    handleArchiveProblem,
    handleListTestCases,
    handleCreateTestCase,
    handleUpdateTestCase,
    handleDeleteTestCase
  };
}
