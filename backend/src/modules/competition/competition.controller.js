import {
  getParticipantCompetitionCurrent,
  getParticipantCompetitionState
} from './competition.service.js';

/**
 * Create participant competition endpoints under /api/competition.
 */
export function createCompetitionController({
  competitionSlug,
  logger,
  nowFn = () => Date.now()
} = {}) {
  async function handleGetCurrent(req, res, next) {
    try {
      const payload = await getParticipantCompetitionCurrent({
        user: req.user,
        competitionSlug,
        nowFn,
        logger: req.log ?? logger
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...payload,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  async function handleGetState(req, res, next) {
    try {
      const payload = await getParticipantCompetitionState({
        user: req.user,
        competitionSlug,
        nowFn,
        logger: req.log ?? logger
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        ...payload,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    handleGetCurrent,
    handleGetState
  };
}
