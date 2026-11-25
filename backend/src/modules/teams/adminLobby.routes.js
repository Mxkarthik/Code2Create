import express from 'express';
import { requireActiveUser, requireAdmin } from '../../middleware/authorize.js';

/**
 * Create administrative lobby and competition lifecycle routes under /api/admin.
 */
export function createAdminLobbyRouter({
  adminLobbyController,
  adminCompetitionController,
  authMiddleware,
  csrfProtection
}) {
  const router = express.Router();

  router.use(authMiddleware.requireAuth, requireActiveUser, requireAdmin);

  router.get('/lobby', adminLobbyController.handleGetLobby);
  router.get('/teams', adminLobbyController.handleGetTeams);

  if (adminCompetitionController) {
    router.post(
      '/teams/import-ranks',
      csrfProtection,
      adminCompetitionController.handleImportRanks
    );
    router.post(
      '/teams/confirm-ranks',
      csrfProtection,
      adminCompetitionController.handleConfirmRanks
    );
    router.post(
      '/teams/:teamId/exclude',
      csrfProtection,
      adminCompetitionController.handleExcludeTeam
    );
    router.post(
      '/teams/:teamId/include',
      csrfProtection,
      adminCompetitionController.handleIncludeTeam
    );

    router.get('/competition', adminCompetitionController.handleGetCompetition);
    router.patch(
      '/competition/config',
      csrfProtection,
      adminCompetitionController.handleUpdateConfig
    );
    router.get(
      '/competition/roster-preview',
      adminCompetitionController.handleGetRosterPreview
    );
    router.post(
      '/competition/lock',
      csrfProtection,
      adminCompetitionController.handleLockRoster
    );
    router.post(
      '/competition/start',
      csrfProtection,
      adminCompetitionController.handleStartCompetition
    );
  }

  return router;
}
