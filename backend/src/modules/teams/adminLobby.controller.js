import { getAdminLobbyOverview } from './team.service.js';

/**
 * Create read-only ADMIN lobby controllers under /api/admin.
 */
export function createAdminLobbyController({ competitionSlug, logger, nowFn } = {}) {
  async function handleGetLobby(req, res, next) {
    try {
      const overview = await getAdminLobbyOverview({
        competitionSlug,
        nowFn,
        logger: req.log ?? logger
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...overview,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleGetTeams(req, res, next) {
    try {
      const overview = await getAdminLobbyOverview({
        competitionSlug,
        nowFn,
        logger: req.log ?? logger
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        competition: overview.competition,
        teams: overview.teams,
        serverTime: overview.serverTime,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    handleGetLobby,
    handleGetTeams
  };
}
