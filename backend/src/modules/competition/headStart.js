import { AppError } from '../../utils/AppError.js';

/**
 * Pure Round 1 head-start distance calculator.
 * Formula: Math.round(maxHeadStart * (rankedTeamCount - rank) / (rankedTeamCount - 1))
 * Special case: rankedTeamCount === 1 and rank === 1 returns maxHeadStart.
 */
export function calculateHeadStart(rank, rankedTeamCount, maxHeadStart = 20) {
  if (!Number.isInteger(rankedTeamCount) || rankedTeamCount < 1) {
    throw AppError.badRequest(
      'rankedTeamCount must be an integer >= 1',
      'ROUND1_RANK_INVALID'
    );
  }

  if (!Number.isInteger(rank) || rank < 1 || rank > rankedTeamCount) {
    throw AppError.badRequest(
      `rank must be an integer between 1 and ${rankedTeamCount}`,
      'ROUND1_RANK_INVALID'
    );
  }

  if (!Number.isInteger(maxHeadStart) || maxHeadStart < 0) {
    throw AppError.badRequest(
      'maxHeadStart must be an integer >= 0',
      'ROUND1_RANK_INVALID'
    );
  }

  if (rankedTeamCount === 1) {
    return maxHeadStart;
  }

  return Math.round((maxHeadStart * (rankedTeamCount - rank)) / (rankedTeamCount - 1));
}
