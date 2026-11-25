import express from 'express';
import { requireActiveUser, requireParticipantAccess } from '../../middleware/authorize.js';

/**
 * Create participant team formation and membership routes under /api/teams.
 */
export function createTeamRouter({
  teamController,
  authMiddleware,
  csrfProtection,
  rateLimiters
}) {
  const router = express.Router();

  router.use(authMiddleware.requireAuth, requireActiveUser, requireParticipantAccess);

  router.get('/me', teamController.handleGetMyTeam);

  router.post('/', csrfProtection, teamController.handleCreateTeam);

  router.post(
    '/join',
    csrfProtection,
    rateLimiters.teamJoinAccountLimiter,
    rateLimiters.teamJoinIpLimiter,
    teamController.handleJoinTeam
  );

  router.patch('/me/ready', csrfProtection, teamController.handleSetReadiness);
  router.post('/me/leave', csrfProtection, teamController.handleLeaveTeam);
  router.post(
    '/me/regenerate-code',
    csrfProtection,
    teamController.handleRegenerateCode
  );
  router.post(
    '/me/transfer-leadership',
    csrfProtection,
    teamController.handleTransferLeadership
  );
  router.delete(
    '/me/members/:userId',
    csrfProtection,
    teamController.handleRemoveMember
  );
  router.delete('/me', csrfProtection, teamController.handleDissolveTeam);

  return router;
}
