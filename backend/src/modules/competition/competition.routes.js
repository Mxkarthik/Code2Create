import express from 'express';
import { requireActiveUser, requireParticipantAccess } from '../../middleware/authorize.js';

/**
 * Create participant competition routes under /api/competition.
 */
export function createCompetitionRouter({ competitionController, authMiddleware }) {
  const router = express.Router();

  router.use(authMiddleware.requireAuth, requireActiveUser, requireParticipantAccess);

  router.get('/current', competitionController.handleGetCurrent);
  router.get('/state', competitionController.handleGetState);

  return router;
}
