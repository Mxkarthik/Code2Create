import {
  createTeam,
  dissolveTeam,
  getMyTeam,
  joinTeam,
  leaveTeam,
  regenerateJoinCode,
  removeMember,
  setMemberReadiness,
  transferLeadership
} from './team.service.js';
import {
  validateCreateTeamBody,
  validateJoinTeamBody,
  validateMemberIdParam,
  validateSetReadyBody,
  validateTransferLeadershipBody
} from './team.validation.js';

/**
 * Create HTTP controllers for participant team formation and membership management.
 */
export function createTeamController({ logger, competitionSlug } = {}) {
  async function handleCreateTeam(req, res, next) {
    try {
      const { name } = validateCreateTeamBody(req.body);
      const idempotencyKey = req.get('idempotency-key');
      const result = await createTeam({
        user: req.user,
        name,
        idempotencyKey,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(result.created ? 201 : 200).json({
        success: true,
        ...result.snapshot,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleJoinTeam(req, res, next) {
    try {
      const { joinCode } = validateJoinTeamBody(req.body);
      const result = await joinTeam({
        user: req.user,
        joinCode,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...result.snapshot,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleGetMyTeam(req, res, next) {
    try {
      const snapshot = await getMyTeam({
        user: req.user,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...snapshot,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleSetReadiness(req, res, next) {
    try {
      const { isReady } = validateSetReadyBody(req.body);
      const snapshot = await setMemberReadiness({
        user: req.user,
        isReady,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...snapshot,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleLeaveTeam(req, res, next) {
    try {
      const snapshot = await leaveTeam({
        user: req.user,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...snapshot,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleRegenerateCode(req, res, next) {
    try {
      const snapshot = await regenerateJoinCode({
        user: req.user,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...snapshot,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleTransferLeadership(req, res, next) {
    try {
      const { targetUserId } = validateTransferLeadershipBody(req.body);
      const snapshot = await transferLeadership({
        user: req.user,
        targetUserId,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...snapshot,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleRemoveMember(req, res, next) {
    try {
      const targetUserId = validateMemberIdParam(req.params.userId);
      const snapshot = await removeMember({
        user: req.user,
        targetUserId,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...snapshot,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleDissolveTeam(req, res, next) {
    try {
      const snapshot = await dissolveTeam({
        user: req.user,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...snapshot,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    handleCreateTeam,
    handleJoinTeam,
    handleGetMyTeam,
    handleSetReadiness,
    handleLeaveTeam,
    handleRegenerateCode,
    handleTransferLeadership,
    handleRemoveMember,
    handleDissolveTeam
  };
}
