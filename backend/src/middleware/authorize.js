import {
  DEFAULT_COMPETITION_SLUG
} from '../modules/competition/competition.model.js';
import {
  getActiveCompetition,
  verifyLiveCompetitionAdmission
} from '../modules/competition/competition.service.js';
import { ACTIVE_TEAM_STATUSES, Team } from '../modules/teams/team.model.js';
import { TeamMembership } from '../modules/teams/teamMembership.model.js';
import { USER_ROLES } from '../modules/users/user.model.js';
import { AppError } from '../utils/AppError.js';

/**
 * Ensure an authenticated user exists on the request and is active.
 */
export function requireActiveUser(req, _res, next) {
  if (!req.user) {
    return next(AppError.unauthorized('Authentication required', 'UNAUTHENTICATED'));
  }

  if (req.user.isActive !== true) {
    return next(AppError.forbidden('Your account has been disabled', 'ACCOUNT_DISABLED'));
  }

  return next();
}

/**
 * Authorize only users holding one of the permitted global account roles.
 * Always evaluates the live role loaded from MongoDB by requireAuth.
 */
export function requireRole(...allowedRoles) {
  return function roleGuard(req, _res, next) {
    if (!req.user) {
      return next(AppError.unauthorized('Authentication required', 'UNAUTHENTICATED'));
    }

    if (req.user.isActive !== true) {
      return next(AppError.forbidden('Your account has been disabled', 'ACCOUNT_DISABLED'));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(
        AppError.forbidden('You do not have permission to access this resource', 'FORBIDDEN')
      );
    }

    return next();
  };
}

/**
 * Restrict access to ADMIN accounts only.
 */
export const requireAdmin = requireRole(USER_ROLES.ADMIN);

/**
 * Permit both PARTICIPANT and ADMIN accounts to access participant portal functionality.
 */
export const requireParticipantAccess = requireRole(
  USER_ROLES.PARTICIPANT,
  USER_ROLES.ADMIN
);

/**
 * Verify in MongoDB that the authenticated active user belongs to an active team
 * in the current competition, optionally restricting to specific teamRoles.
 * Global account role (PARTICIPANT / ADMIN) remains independent.
 */
export function requireTeamMembership({
  requiredTeamRoles = [],
  competitionSlug = DEFAULT_COMPETITION_SLUG
} = {}) {
  return async function teamMembershipGuard(req, _res, next) {
    try {
      if (!req.user) {
        return next(AppError.unauthorized('Authentication required', 'UNAUTHENTICATED'));
      }

      if (req.user.isActive !== true) {
        return next(AppError.forbidden('Your account has been disabled', 'ACCOUNT_DISABLED'));
      }

      const competition = await getActiveCompetition({ slug: competitionSlug });
      const membership = await TeamMembership.findOne({
        competitionId: competition._id,
        userId: req.user._id
      }).lean();

      if (!membership) {
        return next(AppError.notFound('You do not belong to an active team', 'TEAM_NOT_FOUND'));
      }

      const team = await Team.findOne({
        _id: membership.teamId,
        status: { $in: ACTIVE_TEAM_STATUSES }
      }).lean();

      if (!team) {
        return next(AppError.notFound('Active team not found', 'TEAM_NOT_FOUND'));
      }

      if (
        Array.isArray(requiredTeamRoles) &&
        requiredTeamRoles.length > 0 &&
        !requiredTeamRoles.includes(membership.teamRole)
      ) {
        return next(
          AppError.forbidden(
            'You do not have the required team role for this operation',
            'TEAM_LEADER_REQUIRED'
          )
        );
      }

      req.competition = competition;
      req.team = team;
      req.teamMembership = membership;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Reusable live gameplay admission guard for Phase 05+ execution and challenge routes.
 * Verifies authenticated active user, reconciled LIVE status, strict pre-deadline timestamp,
 * frozen eligible roster membership, and initialized TeamRoundState.
 *
 * NOTE: Phase 05 submission queues must still enforce deadline and pending-slot checks
 * atomically inside the submission admission transaction.
 */
export function requireLiveCompetitionAdmission({
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now(),
  logger
} = {}) {
  return async function liveAdmissionGuard(req, _res, next) {
    try {
      if (!req.user) {
        return next(AppError.unauthorized('Authentication required', 'UNAUTHENTICATED'));
      }

      if (req.user.isActive !== true) {
        return next(AppError.forbidden('Your account has been disabled', 'ACCOUNT_DISABLED'));
      }

      const admission = await verifyLiveCompetitionAdmission({
        user: req.user,
        competitionSlug,
        nowFn,
        logger: req.log ?? logger
      });

      req.competition = admission.competition;
      req.frozenRosterEntry = admission.frozenEntry;
      req.teamRoundState = admission.teamRoundState;
      req.competitionNowMs = admission.nowMs;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
