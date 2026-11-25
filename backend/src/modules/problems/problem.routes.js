import express from 'express';
import {
  requireActiveUser,
  requireLiveCompetitionAdmission,
  requireParticipantAccess
} from '../../middleware/authorize.js';

/**
 * Create participant problem routes under /api/problems.
 * Note: Full problem detail access (GET /api/problems/:problemId) is deferred to Phase 08
 * when ChallengeAttempt exists.
 */
export function createProblemRouter({
  problemController,
  authMiddleware,
  competitionSlug,
  nowFn,
  logger
}) {
  const router = express.Router();

  router.use(
    authMiddleware.requireAuth,
    requireActiveUser,
    requireParticipantAccess,
    requireLiveCompetitionAdmission({ competitionSlug, nowFn, logger })
  );

  router.get('/', problemController.handleListProblems);

  return router;
}
