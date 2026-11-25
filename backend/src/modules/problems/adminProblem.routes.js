import express from 'express';
import { requireActiveUser, requireAdmin } from '../../middleware/authorize.js';

/**
 * Create administrative problem and test case management routes under /api/admin/problems.
 * Static /readiness route is registered before dynamic /:problemId routes.
 */
export function createAdminProblemRouter({
  adminProblemController,
  authMiddleware,
  csrfProtection
}) {
  const router = express.Router();

  router.use(authMiddleware.requireAuth, requireActiveUser, requireAdmin);

  router.get('/readiness', adminProblemController.handleGetReadiness);
  router.get('/', adminProblemController.handleListProblems);
  router.post('/', csrfProtection, adminProblemController.handleCreateProblem);

  router.get('/:problemId', adminProblemController.handleGetProblem);
  router.patch('/:problemId', csrfProtection, adminProblemController.handleUpdateProblem);
  router.delete('/:problemId', csrfProtection, adminProblemController.handleDeleteProblem);

  router.post(
    '/:problemId/publish',
    csrfProtection,
    adminProblemController.handlePublishProblem
  );
  router.post(
    '/:problemId/unpublish',
    csrfProtection,
    adminProblemController.handleUnpublishProblem
  );
  router.post(
    '/:problemId/archive',
    csrfProtection,
    adminProblemController.handleArchiveProblem
  );

  router.get('/:problemId/test-cases', adminProblemController.handleListTestCases);
  router.post(
    '/:problemId/test-cases',
    csrfProtection,
    adminProblemController.handleCreateTestCase
  );
  router.patch(
    '/:problemId/test-cases/:testCaseId',
    csrfProtection,
    adminProblemController.handleUpdateTestCase
  );
  router.delete(
    '/:problemId/test-cases/:testCaseId',
    csrfProtection,
    adminProblemController.handleDeleteTestCase
  );

  return router;
}
