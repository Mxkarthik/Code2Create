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
 * Future Phase 03/04 Authorization Contracts (intentionally unimplemented in Phase 02):
 *
 * - requireTeamMembership({ requiredTeamRoles }):
 *   Must verify in MongoDB that req.user belongs to the target team (TEAM_LEADER or
 *   TEAM_MEMBER) independently of global account role (PARTICIPANT / ADMIN).
 *
 * - requireRoundEligibility():
 *   Must verify roster lock status, Round 1 qualification eligibility, team readiness,
 *   and active competition window before allowing gameplay mutations.
 */
