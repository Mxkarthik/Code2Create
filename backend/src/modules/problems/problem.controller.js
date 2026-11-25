import { listParticipantProblems } from './problem.service.js';

/**
 * Create participant-safe problem listing controller under /api/problems.
 * Requires requireLiveCompetitionAdmission middleware so only eligible participants
 * during LIVE pre-deadline can view selection metadata.
 */
export function createProblemController() {
  async function handleListProblems(req, res, next) {
    try {
      const problems = await listParticipantProblems({
        competitionId: req.competition._id
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        competition: {
          id: req.competition._id.toString(),
          status: req.competition.status,
          endsAt: req.competition.endsAt ? new Date(req.competition.endsAt).toISOString() : null
        },
        problems,
        requestId: req.id
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    handleListProblems
  };
}
