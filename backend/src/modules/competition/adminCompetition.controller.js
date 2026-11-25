import {
  confirmRound1Ranks,
  getAdminCompetitionSnapshot,
  getRosterPreview,
  importRound1Ranks,
  lockCompetitionRoster,
  setTeamExclusion,
  startCompetition,
  updateCompetitionConfig
} from './competition.service.js';
import {
  validateCompetitionConfigBody,
  validateConfirmRanksBody,
  validateExcludeTeamBody,
  validateImportRanksBody,
  validateLockRosterBody,
  validateTeamIdParam
} from './competition.validation.js';

/**
 * Create administrative Phase 04 competition & roster controllers under /api/admin.
 */
export function createAdminCompetitionController({
  competitionSlug,
  logger,
  nowFn = () => Date.now()
} = {}) {
  async function handleImportRanks(req, res, next) {
    try {
      const { rankedTeamCount, entries } = validateImportRanksBody(req.body);
      const result = await importRound1Ranks({
        rankedTeamCount,
        entries,
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

  async function handleConfirmRanks(req, res, next) {
    try {
      const { rankImportVersion } = validateConfirmRanksBody(req.body);
      const result = await confirmRound1Ranks({
        adminUser: req.user,
        rankImportVersion,
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

  async function handleExcludeTeam(req, res, next) {
    try {
      const teamId = validateTeamIdParam(req.params.teamId);
      const { reason } = validateExcludeTeamBody(req.body);
      const result = await setTeamExclusion({
        adminUser: req.user,
        teamId,
        exclude: true,
        reason,
        logger: req.log ?? logger,
        competitionSlug,
        nowFn
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        team: result,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleIncludeTeam(req, res, next) {
    try {
      const teamId = validateTeamIdParam(req.params.teamId);
      const result = await setTeamExclusion({
        adminUser: req.user,
        teamId,
        exclude: false,
        logger: req.log ?? logger,
        competitionSlug,
        nowFn
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        team: result,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleGetCompetition(req, res, next) {
    try {
      const snapshot = await getAdminCompetitionSnapshot({
        competitionSlug,
        nowFn,
        logger: req.log ?? logger
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

  async function handleUpdateConfig(req, res, next) {
    try {
      const updates = validateCompetitionConfigBody(req.body);
      const competition = await updateCompetitionConfig({
        updates,
        logger: req.log ?? logger,
        competitionSlug
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        competition,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleGetRosterPreview(req, res, next) {
    try {
      const preview = await getRosterPreview({
        competitionSlug,
        nowFn
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...preview,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleLockRoster(req, res, next) {
    try {
      const { expectedRosterVersion, expectedRankImportVersion } = validateLockRosterBody(
        req.body
      );
      const result = await lockCompetitionRoster({
        adminUser: req.user,
        expectedRosterVersion,
        expectedRankImportVersion,
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

  async function handleStartCompetition(req, res, next) {
    try {
      const result = await startCompetition({
        adminUser: req.user,
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

  return {
    handleImportRanks,
    handleConfirmRanks,
    handleExcludeTeam,
    handleIncludeTeam,
    handleGetCompetition,
    handleUpdateConfig,
    handleGetRosterPreview,
    handleLockRoster,
    handleStartCompetition
  };
}
