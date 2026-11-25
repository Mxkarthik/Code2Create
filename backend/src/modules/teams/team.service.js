import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';
import { runInTransaction } from '../../utils/transaction.js';
import {
  Competition,
  DEFAULT_COMPETITION_SLUG
} from '../competition/competition.model.js';
import {
  acquireLobbyMutationGuard,
  computeRemainingSeconds,
  evaluateRosterReadiness,
  getActiveCompetition,
  reconcileCompetitionDeadline
} from '../competition/competition.service.js';
import { USER_ROLES, User } from '../users/user.model.js';
import {
  ACTIVE_TEAM_STATUSES,
  RANK_MAPPING_STATUSES,
  TEAM_STATUSES,
  Team
} from './team.model.js';
import { JOIN_CODE_ALPHABET } from './team.validation.js';
import { TEAM_ROLES, TeamMembership } from './teamMembership.model.js';

const MAX_JOIN_CODE_ATTEMPTS = 8;

/**
 * Generate a cryptographically random 8-character invitation code from an
 * unambiguous uppercase alphabet (excluding O, 0, I, 1).
 */
export function generateJoinCode() {
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += JOIN_CODE_ALPHABET[crypto.randomInt(0, JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

async function generateUniqueJoinCode(competitionId, session) {
  for (let attempt = 0; attempt < MAX_JOIN_CODE_ATTEMPTS; attempt += 1) {
    const candidate = generateJoinCode();
    const exists = await Team.exists({ competitionId, joinCode: candidate }).session(session);
    if (!exists) {
      return candidate;
    }
  }

  throw new AppError('Unable to generate a unique team invitation code', {
    statusCode: 503,
    code: 'JOIN_CODE_GENERATION_FAILED'
  });
}

export function deriveTeamStatus({ memberCount, readyMemberCount, teamSize }) {
  if (memberCount <= 0) {
    return TEAM_STATUSES.DISSOLVED;
  }
  if (memberCount < teamSize) {
    return TEAM_STATUSES.FORMING;
  }
  if (readyMemberCount === memberCount) {
    return TEAM_STATUSES.READY;
  }
  return TEAM_STATUSES.FORMED;
}

function buildPublicMemberProfile(membership, userDoc) {
  return {
    userId: membership.userId.toString(),
    name: userDoc?.name ?? 'Unknown Participant',
    avatar: userDoc?.avatar ?? null,
    teamRole: membership.teamRole,
    isReady: Boolean(membership.isReady),
    readyAt: membership.readyAt ? new Date(membership.readyAt).toISOString() : null,
    joinedAt: membership.joinedAt ? new Date(membership.joinedAt).toISOString() : null
  };
}

async function buildTeamSnapshot({
  competition,
  team,
  viewerMembership,
  viewerGlobalRole,
  session
}) {
  if (!team || !viewerMembership) {
    return {
      competition: {
        id: competition._id.toString(),
        slug: competition.slug,
        name: competition.name,
        status: competition.status,
        teamSize: competition.teamSize,
        maxTeams: competition.maxTeams
      },
      team: null,
      teamRole: null,
      isReady: false
    };
  }

  const memberships = await TeamMembership.find({ teamId: team._id })
    .sort({ joinedAt: 1, _id: 1 })
    .session(session ?? null)
    .lean();

  const userIds = memberships.map((m) => m.userId);
  const users = await User.find({ _id: { $in: userIds } })
    .select('_id name avatar')
    .session(session ?? null)
    .lean();

  const userMap = new Map(users.map((u) => [u._id.toString(), u]));
  const canViewJoinCode =
    viewerMembership.teamRole === TEAM_ROLES.TEAM_LEADER ||
    viewerGlobalRole === USER_ROLES.ADMIN;
  const isLeaderOrAdmin = canViewJoinCode;
  const isLeader = viewerMembership.teamRole === TEAM_ROLES.TEAM_LEADER;

  return {
    competition: {
      id: competition._id.toString(),
      slug: competition.slug,
      name: competition.name,
      status: competition.status,
      teamSize: competition.teamSize,
      maxTeams: competition.maxTeams
    },
    team: {
      id: team._id.toString(),
      name: team.name,
      status: team.status,
      revision: team.revision,
      capacity: competition.teamSize,
      memberCount: team.memberCount,
      readyMemberCount: team.readyMemberCount,
      ...(canViewJoinCode ? { joinCode: team.joinCode } : {}),
      members: memberships.map((m) =>
        buildPublicMemberProfile(m, userMap.get(m.userId.toString()))
      )
    },
    teamRole: viewerMembership.teamRole,
    isReady: Boolean(viewerMembership.isReady),
    permissions: {
      canViewJoinCode,
      canRegenerateCode: isLeaderOrAdmin,
      canRemoveMembers: isLeaderOrAdmin,
      canTransferLeadership: isLeader,
      canDissolve: isLeaderOrAdmin,
      canLeave: true,
      canToggleReady: true
    }
  };
}

function mapDuplicateKeyError(err) {
  if (err?.code !== 11000) {
    return err;
  }

  const keyPattern = err.keyPattern ?? {};
  if (keyPattern.normalizedName) {
    return new AppError('An active team with that name already exists', {
      statusCode: 409,
      code: 'TEAM_NAME_TAKEN'
    });
  }
  if (keyPattern.userId) {
    return new AppError('You already belong to a team in this competition', {
      statusCode: 409,
      code: 'TEAM_ALREADY_ASSIGNED'
    });
  }
  if (keyPattern.joinCode) {
    return new AppError('Invitation code collision occurred, please retry', {
      statusCode: 409,
      code: 'TEAM_STATE_CONFLICT'
    });
  }

  return new AppError('Team operation conflicted with an existing record', {
    statusCode: 409,
    code: 'TEAM_STATE_CONFLICT'
  });
}

/**
 * Retrieve the authenticated user's lightweight team summary for /api/auth/me.
 * Returns null fields when unassigned or before competition initialization.
 */
export async function getUserTeamSummary(
  userId,
  { competitionSlug = DEFAULT_COMPETITION_SLUG } = {}
) {
  if (!userId || mongoose.connection.readyState !== 1) {
    return { teamId: null, teamRole: null };
  }

  const competition = await Competition.findOne({ slug: competitionSlug })
    .select('_id')
    .lean();
  if (!competition) {
    return { teamId: null, teamRole: null };
  }

  const membership = await TeamMembership.findOne({
    competitionId: competition._id,
    userId
  })
    .select('teamId teamRole')
    .lean();

  if (!membership) {
    return { teamId: null, teamRole: null };
  }

  return {
    teamId: membership.teamId.toString(),
    teamRole: membership.teamRole
  };
}

/**
 * Retrieve authoritative current team state for the authenticated user.
 */
export async function getMyTeam({
  user,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const competition = await getActiveCompetition({ slug: competitionSlug });
  const membership = await TeamMembership.findOne({
    competitionId: competition._id,
    userId: user._id
  }).lean();

  if (!membership) {
    return buildTeamSnapshot({
      competition,
      team: null,
      viewerMembership: null,
      viewerGlobalRole: user.role
    });
  }

  const team = await Team.findOne({
    _id: membership.teamId,
    status: { $in: ACTIVE_TEAM_STATUSES }
  }).lean();

  return buildTeamSnapshot({
    competition,
    team,
    viewerMembership: team ? membership : null,
    viewerGlobalRole: user.role
  });
}

/**
 * Create a new team transactionally and assign the creator as TEAM_LEADER.
 */
export async function createTeam({
  user,
  name,
  idempotencyKey = null,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const normalizedName = name.trim().toLowerCase();
  const normalizedRequestKey =
    typeof idempotencyKey === 'string' && idempotencyKey.trim().length > 0
      ? idempotencyKey.trim().slice(0, 128)
      : null;

  let outcome;
  try {
    outcome = await runInTransaction(async (session) => {
      const competition = await getActiveCompetition({ slug: competitionSlug, session });

      const existingMembership = await TeamMembership.findOne({
        competitionId: competition._id,
        userId: user._id
      })
        .session(session)
        .lean();

      if (existingMembership) {
        const existingTeam = await Team.findById(existingMembership.teamId)
          .session(session)
          .lean();

        if (
          normalizedRequestKey &&
          existingTeam &&
          existingTeam.createRequestKey === normalizedRequestKey &&
          existingTeam.leaderId?.toString() === user._id.toString()
        ) {
          const snapshot = await buildTeamSnapshot({
            competition,
            team: existingTeam,
            viewerMembership: existingMembership,
            viewerGlobalRole: user.role,
            session
          });
          return { created: false, snapshot };
        }

        throw new AppError('You already belong to a team in this competition', {
          statusCode: 409,
          code: 'TEAM_ALREADY_ASSIGNED'
        });
      }

      const duplicateTeam = await Team.exists({
        competitionId: competition._id,
        normalizedName,
        status: { $in: ACTIVE_TEAM_STATUSES }
      }).session(session);

      if (duplicateTeam) {
        throw new AppError('An active team with that name already exists', {
          statusCode: 409,
          code: 'TEAM_NAME_TAKEN'
        });
      }

      const guardedCompetition = await acquireLobbyMutationGuard({
        competitionId: competition._id,
        session,
        activeTeamCountDelta: 1,
        requireCapacity: true
      });

      const joinCode = await generateUniqueJoinCode(guardedCompetition._id, session);
      const initialStatus = deriveTeamStatus({
        memberCount: 1,
        readyMemberCount: 0,
        teamSize: guardedCompetition.teamSize
      });

      const [createdTeam] = await Team.create(
        [
          {
            competitionId: guardedCompetition._id,
            name: name.trim(),
            normalizedName,
            joinCode,
            leaderId: user._id,
            memberCount: 1,
            readyMemberCount: 0,
            status: initialStatus,
            revision: 1,
            createRequestKey: normalizedRequestKey
          }
        ],
        { session }
      );

      const [createdMembership] = await TeamMembership.create(
        [
          {
            competitionId: guardedCompetition._id,
            teamId: createdTeam._id,
            userId: user._id,
            teamRole: TEAM_ROLES.TEAM_LEADER,
            isReady: false,
            readyAt: null,
            joinedAt: new Date()
          }
        ],
        { session }
      );

      const snapshot = await buildTeamSnapshot({
        competition: guardedCompetition,
        team: createdTeam,
        viewerMembership: createdMembership,
        viewerGlobalRole: user.role,
        session
      });

      return { created: true, snapshot, teamId: createdTeam._id.toString() };
    });
  } catch (err) {
    throw mapDuplicateKeyError(err);
  }

  if (outcome.created) {
    const logMeta = { teamId: outcome.teamId, userId: user._id.toString() };
    if (typeof logger?.success === 'function') {
      logger.success(logMeta, 'Team created');
    } else {
      logger?.info(logMeta, 'Team created');
    }
  }

  return outcome;
}

/**
 * Join an existing active team using its 8-character invitation code.
 */
export async function joinTeam({
  user,
  joinCode,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  let outcome;
  try {
    outcome = await runInTransaction(async (session) => {
      const competition = await getActiveCompetition({ slug: competitionSlug, session });
      const guardedCompetition = await acquireLobbyMutationGuard({
        competitionId: competition._id,
        session
      });

      const targetTeam = await Team.findOne({
        competitionId: guardedCompetition._id,
        joinCode,
        status: { $in: ACTIVE_TEAM_STATUSES }
      })
        .session(session)
        .lean();

      if (!targetTeam) {
        throw new AppError('Invitation code is invalid or no longer active', {
          statusCode: 404,
          code: 'TEAM_CODE_INVALID'
        });
      }

      const existingMembership = await TeamMembership.findOne({
        competitionId: guardedCompetition._id,
        userId: user._id
      })
        .session(session)
        .lean();

      if (existingMembership) {
        if (existingMembership.teamId.equals(targetTeam._id)) {
          const snapshot = await buildTeamSnapshot({
            competition: guardedCompetition,
            team: targetTeam,
            viewerMembership: existingMembership,
            viewerGlobalRole: user.role,
            session
          });
          return { joined: false, snapshot };
        }

        throw new AppError('You already belong to another team in this competition', {
          statusCode: 409,
          code: 'TEAM_ALREADY_ASSIGNED'
        });
      }

      const nextMemberCount = targetTeam.memberCount + 1;
      const nextStatus = deriveTeamStatus({
        memberCount: nextMemberCount,
        readyMemberCount: 0,
        teamSize: guardedCompetition.teamSize
      });

      const hadRankMapping =
        targetTeam.round1MappingStatus === RANK_MAPPING_STATUSES.MAPPED ||
        targetTeam.round1Rank !== null;

      const updatedTeam = await Team.findOneAndUpdate(
        {
          _id: targetTeam._id,
          status: { $in: ACTIVE_TEAM_STATUSES },
          memberCount: { $lt: guardedCompetition.teamSize }
        },
        {
          $inc: { memberCount: 1, revision: 1 },
          $set: {
            readyMemberCount: 0,
            status: nextStatus,
            ...(hadRankMapping
              ? {
                  round1Rank: null,
                  round1RankedTeamCount: null,
                  round1MappingStatus: RANK_MAPPING_STATUSES.STALE
                }
              : {})
          }
        },
        { session, returnDocument: 'after' }
      );

      if (!updatedTeam) {
        throw new AppError('This team has already reached its maximum capacity', {
          statusCode: 409,
          code: 'TEAM_FULL'
        });
      }

      if (hadRankMapping) {
        await Competition.updateOne(
          { _id: guardedCompetition._id },
          {
            $set: {
              rankImportConfirmedVersion: null,
              rankImportConfirmedAt: null,
              rankImportConfirmedBy: null
            }
          },
          { session }
        );
      }

      // Reset readiness for existing members whenever team composition changes.
      await TeamMembership.updateMany(
        { teamId: updatedTeam._id },
        { $set: { isReady: false, readyAt: null } },
        { session }
      );

      const [createdMembership] = await TeamMembership.create(
        [
          {
            competitionId: guardedCompetition._id,
            teamId: updatedTeam._id,
            userId: user._id,
            teamRole: TEAM_ROLES.TEAM_MEMBER,
            isReady: false,
            readyAt: null,
            joinedAt: new Date()
          }
        ],
        { session }
      );

      const snapshot = await buildTeamSnapshot({
        competition: guardedCompetition,
        team: updatedTeam,
        viewerMembership: createdMembership,
        viewerGlobalRole: user.role,
        session
      });

      return { joined: true, snapshot, teamId: updatedTeam._id.toString() };
    });
  } catch (err) {
    throw mapDuplicateKeyError(err);
  }

  if (outcome.joined) {
    const logMeta = { teamId: outcome.teamId, userId: user._id.toString() };
    if (typeof logger?.success === 'function') {
      logger.success(logMeta, 'Participant joined team');
    } else {
      logger?.info(logMeta, 'Participant joined team');
    }
  }

  return outcome;
}

/**
 * Update only the authenticated user's own readiness flag inside LOBBY.
 */
export async function setMemberReadiness({
  user,
  isReady,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guardedCompetition = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session
    });

    const membership = await TeamMembership.findOne({
      competitionId: guardedCompetition._id,
      userId: user._id
    }).session(session);

    if (!membership) {
      throw AppError.notFound('You do not belong to an active team', 'TEAM_NOT_FOUND');
    }

    const team = await Team.findOne({
      _id: membership.teamId,
      status: { $in: ACTIVE_TEAM_STATUSES }
    }).session(session);

    if (!team) {
      throw AppError.notFound('Active team not found', 'TEAM_NOT_FOUND');
    }

    if (membership.isReady === isReady) {
      const snapshot = await buildTeamSnapshot({
        competition: guardedCompetition,
        team,
        viewerMembership: membership,
        viewerGlobalRole: user.role,
        session
      });
      return { becameReady: false, snapshot, teamId: team._id.toString() };
    }

    membership.isReady = isReady;
    membership.readyAt = isReady ? new Date() : null;
    await membership.save({ session });

    const allMembers = await TeamMembership.find({ teamId: team._id })
      .session(session)
      .lean();
    const memberCount = allMembers.length;
    const readyMemberCount = allMembers.filter((m) => m.isReady).length;
    const nextStatus = deriveTeamStatus({
      memberCount,
      readyMemberCount,
      teamSize: guardedCompetition.teamSize
    });

    const previousStatus = team.status;
    const updatedTeam = await Team.findByIdAndUpdate(
      team._id,
      {
        $set: {
          memberCount,
          readyMemberCount,
          status: nextStatus
        },
        $inc: { revision: 1 }
      },
      { session, returnDocument: 'after' }
    );

    const snapshot = await buildTeamSnapshot({
      competition: guardedCompetition,
      team: updatedTeam,
      viewerMembership: membership,
      viewerGlobalRole: user.role,
      session
    });

    return {
      becameReady:
        previousStatus !== TEAM_STATUSES.READY && nextStatus === TEAM_STATUSES.READY,
      snapshot,
      teamId: updatedTeam._id.toString()
    };
  });

  if (outcome.becameReady) {
    logger?.info({ teamId: outcome.teamId }, 'Team ready');
  }

  return outcome.snapshot;
}

/**
 * Regenerate the team's invitation code, invalidating the previous code immediately.
 */
export async function regenerateJoinCode({
  user,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guardedCompetition = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session
    });

    const membership = await TeamMembership.findOne({
      competitionId: guardedCompetition._id,
      userId: user._id
    })
      .session(session)
      .lean();

    if (!membership) {
      throw AppError.notFound('You do not belong to an active team', 'TEAM_NOT_FOUND');
    }

    if (
      membership.teamRole !== TEAM_ROLES.TEAM_LEADER &&
      user.role !== USER_ROLES.ADMIN
    ) {
      throw AppError.forbidden(
        'Only the team leader or an administrator can regenerate the invitation code',
        'TEAM_LEADER_REQUIRED'
      );
    }

    const newJoinCode = await generateUniqueJoinCode(guardedCompetition._id, session);
    const updatedTeam = await Team.findOneAndUpdate(
      {
        _id: membership.teamId,
        status: { $in: ACTIVE_TEAM_STATUSES }
      },
      {
        $set: { joinCode: newJoinCode },
        $inc: { revision: 1 }
      },
      { session, returnDocument: 'after' }
    );

    if (!updatedTeam) {
      throw AppError.notFound('Active team not found', 'TEAM_NOT_FOUND');
    }

    const snapshot = await buildTeamSnapshot({
      competition: guardedCompetition,
      team: updatedTeam,
      viewerMembership: membership,
      viewerGlobalRole: user.role,
      session
    });

    return { snapshot, teamId: updatedTeam._id.toString() };
  });

  logger?.info({ teamId: outcome.teamId }, 'Invitation code regenerated');
  return outcome.snapshot;
}

/**
 * Leave the current team during LOBBY.
 * Transfers leadership deterministically if leader departs with remaining members,
 * or dissolves the team and releases competition capacity if no members remain.
 */
export async function leaveTeam({
  user,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });

    const membership = await TeamMembership.findOne({
      competitionId: competition._id,
      userId: user._id
    })
      .session(session)
      .lean();

    if (!membership) {
      throw AppError.notFound('You do not belong to an active team', 'TEAM_NOT_FOUND');
    }

    const team = await Team.findOne({
      _id: membership.teamId,
      status: { $in: ACTIVE_TEAM_STATUSES }
    })
      .session(session)
      .lean();

    if (!team) {
      throw AppError.notFound('Active team not found', 'TEAM_NOT_FOUND');
    }

    const remainingMembers = await TeamMembership.find({
      teamId: team._id,
      userId: { $ne: user._id }
    })
      .sort({ joinedAt: 1, _id: 1 })
      .session(session)
      .lean();

    const isDissolving = remainingMembers.length === 0;
    const hadRankMapping =
      team.round1MappingStatus === RANK_MAPPING_STATUSES.MAPPED ||
      team.round1Rank !== null;

    const guardedCompetition = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session,
      activeTeamCountDelta: isDissolving ? -1 : 0,
      clearRankConfirmation: hadRankMapping
    });

    await TeamMembership.deleteOne({ _id: membership._id }).session(session);

    if (isDissolving) {
      await Team.updateOne(
        { _id: team._id },
        {
          $set: {
            status: TEAM_STATUSES.DISSOLVED,
            joinCode: null,
            leaderId: null,
            memberCount: 0,
            readyMemberCount: 0,
            dissolvedAt: new Date(),
            round1Rank: null,
            round1RankedTeamCount: null,
            round1RankImportVersion: null,
            round1MappingStatus: RANK_MAPPING_STATUSES.UNMAPPED,
            isExcluded: false
          },
          $inc: { revision: 1 }
        },
        { session }
      );

      const snapshot = await buildTeamSnapshot({
        competition: guardedCompetition,
        team: null,
        viewerMembership: null,
        viewerGlobalRole: user.role,
        session
      });

      return {
        dissolved: true,
        leadershipTransferred: false,
        teamId: team._id.toString(),
        snapshot
      };
    }

    let nextLeaderId = team.leaderId;
    let leadershipTransferred = false;

    if (membership.teamRole === TEAM_ROLES.TEAM_LEADER) {
      const successor = remainingMembers[0];
      await TeamMembership.updateOne(
        { _id: successor._id },
        { $set: { teamRole: TEAM_ROLES.TEAM_LEADER } },
        { session }
      );
      nextLeaderId = successor.userId;
      leadershipTransferred = true;
    }

    await TeamMembership.updateMany(
      { teamId: team._id },
      { $set: { isReady: false, readyAt: null } },
      { session }
    );

    const nextMemberCount = remainingMembers.length;
    const nextStatus = deriveTeamStatus({
      memberCount: nextMemberCount,
      readyMemberCount: 0,
      teamSize: guardedCompetition.teamSize
    });

    await Team.updateOne(
      { _id: team._id },
      {
        $set: {
          leaderId: nextLeaderId,
          memberCount: nextMemberCount,
          readyMemberCount: 0,
          status: nextStatus,
          ...(hadRankMapping
            ? {
                round1Rank: null,
                round1RankedTeamCount: null,
                round1MappingStatus: RANK_MAPPING_STATUSES.STALE
              }
            : {})
        },
        $inc: { revision: 1 }
      },
      { session }
    );

    const snapshot = await buildTeamSnapshot({
      competition: guardedCompetition,
      team: null,
      viewerMembership: null,
      viewerGlobalRole: user.role,
      session
    });

    return {
      dissolved: false,
      leadershipTransferred,
      teamId: team._id.toString(),
      snapshot
    };
  });

  if (outcome.dissolved) {
    logger?.info({ teamId: outcome.teamId }, 'Team dissolved');
  } else if (outcome.leadershipTransferred) {
    logger?.info({ teamId: outcome.teamId }, 'Leadership transferred');
  }

  return outcome.snapshot;
}

/**
 * Atomically transfer TEAM_LEADER role to an existing teammate.
 */
export async function transferLeadership({
  user,
  targetUserId,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guardedCompetition = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session
    });

    const callerMembership = await TeamMembership.findOne({
      competitionId: guardedCompetition._id,
      userId: user._id
    })
      .session(session)
      .lean();

    if (!callerMembership) {
      throw AppError.notFound('You do not belong to an active team', 'TEAM_NOT_FOUND');
    }

    if (callerMembership.teamRole !== TEAM_ROLES.TEAM_LEADER) {
      throw AppError.forbidden(
        'Only the current team leader can transfer leadership',
        'TEAM_LEADER_REQUIRED'
      );
    }

    if (targetUserId === user._id.toString()) {
      throw new AppError('Target user is already the team leader', {
        statusCode: 409,
        code: 'TEAM_STATE_CONFLICT'
      });
    }

    const targetMembership = await TeamMembership.findOne({
      competitionId: guardedCompetition._id,
      teamId: callerMembership.teamId,
      userId: targetUserId
    })
      .session(session)
      .lean();

    if (!targetMembership) {
      throw AppError.notFound(
        'Target member does not belong to your team',
        'TEAM_MEMBER_NOT_FOUND'
      );
    }

    // Demote current leader FIRST to preserve the unique partial TEAM_LEADER index.
    await TeamMembership.updateOne(
      { _id: callerMembership._id },
      { $set: { teamRole: TEAM_ROLES.TEAM_MEMBER } },
      { session }
    );

    const updatedTarget = await TeamMembership.findOneAndUpdate(
      { _id: targetMembership._id },
      { $set: { teamRole: TEAM_ROLES.TEAM_LEADER } },
      { session, returnDocument: 'after' }
    ).lean();

    const updatedCaller = await TeamMembership.findById(callerMembership._id)
      .session(session)
      .lean();

    const updatedTeam = await Team.findOneAndUpdate(
      {
        _id: callerMembership.teamId,
        status: { $in: ACTIVE_TEAM_STATUSES }
      },
      {
        $set: { leaderId: updatedTarget.userId },
        $inc: { revision: 1 }
      },
      { session, returnDocument: 'after' }
    );

    if (!updatedTeam) {
      throw AppError.notFound('Active team not found', 'TEAM_NOT_FOUND');
    }

    const snapshot = await buildTeamSnapshot({
      competition: guardedCompetition,
      team: updatedTeam,
      viewerMembership: updatedCaller,
      viewerGlobalRole: user.role,
      session
    });

    return { snapshot, teamId: updatedTeam._id.toString() };
  });

  logger?.info({ teamId: outcome.teamId }, 'Leadership transferred');
  return outcome.snapshot;
}

/**
 * Remove a non-leader member from the caller's own team during LOBBY.
 */
export async function removeMember({
  user,
  targetUserId,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guardedCompetition = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session
    });

    const callerMembership = await TeamMembership.findOne({
      competitionId: guardedCompetition._id,
      userId: user._id
    })
      .session(session)
      .lean();

    if (!callerMembership) {
      throw AppError.notFound('You do not belong to an active team', 'TEAM_NOT_FOUND');
    }

    if (
      callerMembership.teamRole !== TEAM_ROLES.TEAM_LEADER &&
      user.role !== USER_ROLES.ADMIN
    ) {
      throw AppError.forbidden(
        'Only the team leader or an administrator can remove team members',
        'TEAM_LEADER_REQUIRED'
      );
    }

    const team = await Team.findOne({
      _id: callerMembership.teamId,
      status: { $in: ACTIVE_TEAM_STATUSES }
    })
      .session(session)
      .lean();

    if (!team) {
      throw AppError.notFound('Active team not found', 'TEAM_NOT_FOUND');
    }

    const targetMembership = await TeamMembership.findOne({
      competitionId: guardedCompetition._id,
      teamId: team._id,
      userId: targetUserId
    })
      .session(session)
      .lean();

    if (!targetMembership) {
      throw AppError.notFound(
        'Member not found in your team',
        'TEAM_MEMBER_NOT_FOUND'
      );
    }

    if (
      targetMembership.teamRole === TEAM_ROLES.TEAM_LEADER ||
      targetMembership.userId.equals(team.leaderId)
    ) {
      throw new AppError('Cannot remove the current team leader', {
        statusCode: 409,
        code: 'TEAM_STATE_CONFLICT'
      });
    }

    await TeamMembership.deleteOne({ _id: targetMembership._id }).session(session);

    await TeamMembership.updateMany(
      { teamId: team._id },
      { $set: { isReady: false, readyAt: null } },
      { session }
    );

    const remainingMembers = await TeamMembership.find({ teamId: team._id })
      .session(session)
      .lean();
    const nextMemberCount = remainingMembers.length;
    const nextStatus = deriveTeamStatus({
      memberCount: nextMemberCount,
      readyMemberCount: 0,
      teamSize: guardedCompetition.teamSize
    });

    const hadRankMapping =
      team.round1MappingStatus === RANK_MAPPING_STATUSES.MAPPED ||
      team.round1Rank !== null;

    if (hadRankMapping) {
      await Competition.updateOne(
        { _id: guardedCompetition._id },
        {
          $set: {
            rankImportConfirmedVersion: null,
            rankImportConfirmedAt: null,
            rankImportConfirmedBy: null
          }
        },
        { session }
      );
    }

    const updatedTeam = await Team.findByIdAndUpdate(
      team._id,
      {
        $set: {
          memberCount: nextMemberCount,
          readyMemberCount: 0,
          status: nextStatus,
          ...(hadRankMapping
            ? {
                round1Rank: null,
                round1RankedTeamCount: null,
                round1MappingStatus: RANK_MAPPING_STATUSES.STALE
              }
            : {})
        },
        $inc: { revision: 1 }
      },
      { session, returnDocument: 'after' }
    );

    const updatedCaller = await TeamMembership.findById(callerMembership._id)
      .session(session)
      .lean();

    const snapshot = await buildTeamSnapshot({
      competition: guardedCompetition,
      team: updatedTeam,
      viewerMembership: updatedCaller,
      viewerGlobalRole: user.role,
      session
    });

    return { snapshot, teamId: updatedTeam._id.toString() };
  });

  logger?.info({ teamId: outcome.teamId }, 'Team member removed');
  return outcome.snapshot;
}

/**
 * Dissolve the team during LOBBY, release competition capacity, invalidate joinCode,
 * remove active memberships, and preserve a minimal historical team record.
 */
export async function dissolveTeam({
  user,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });

    const callerMembership = await TeamMembership.findOne({
      competitionId: competition._id,
      userId: user._id
    })
      .session(session)
      .lean();

    if (!callerMembership) {
      throw AppError.notFound('You do not belong to an active team', 'TEAM_NOT_FOUND');
    }

    if (
      callerMembership.teamRole !== TEAM_ROLES.TEAM_LEADER &&
      user.role !== USER_ROLES.ADMIN
    ) {
      throw AppError.forbidden(
        'Only the team leader or an administrator can dissolve the team',
        'TEAM_LEADER_REQUIRED'
      );
    }

    const team = await Team.findOne({
      _id: callerMembership.teamId,
      status: { $in: ACTIVE_TEAM_STATUSES }
    })
      .session(session)
      .lean();

    if (!team) {
      throw AppError.notFound('Active team not found', 'TEAM_NOT_FOUND');
    }

    const hadRankMapping =
      team.round1MappingStatus === RANK_MAPPING_STATUSES.MAPPED ||
      team.round1Rank !== null;

    const guardedCompetition = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session,
      activeTeamCountDelta: -1,
      clearRankConfirmation: hadRankMapping
    });

    await TeamMembership.deleteMany({ teamId: team._id }).session(session);

    await Team.updateOne(
      { _id: team._id },
      {
        $set: {
          status: TEAM_STATUSES.DISSOLVED,
          joinCode: null,
          leaderId: null,
          memberCount: 0,
          readyMemberCount: 0,
          dissolvedAt: new Date(),
          round1Rank: null,
          round1RankedTeamCount: null,
          round1RankImportVersion: null,
          round1MappingStatus: RANK_MAPPING_STATUSES.UNMAPPED,
          isExcluded: false
        },
        $inc: { revision: 1 }
      },
      { session }
    );

    const snapshot = await buildTeamSnapshot({
      competition: guardedCompetition,
      team: null,
      viewerMembership: null,
      viewerGlobalRole: user.role,
      session
    });

    return { snapshot, teamId: team._id.toString() };
  });

  logger?.info({ teamId: outcome.teamId }, 'Team dissolved');
  return outcome.snapshot;
}

/**
 * Retrieve complete lobby overview and team roster for ADMIN read APIs.
 */
export async function getAdminLobbyOverview({
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now(),
  logger
} = {}) {
  await reconcileCompetitionDeadline({ competitionSlug, nowFn, logger });
  const competition = await getActiveCompetition({ slug: competitionSlug });
  const nowMs = nowFn();

  const teams = await Team.find({
    competitionId: competition._id,
    status: { $in: ACTIVE_TEAM_STATUSES }
  })
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  const readiness = await evaluateRosterReadiness({ competition });

  const teamIds = teams.map((t) => t._id);
  const memberships =
    teamIds.length > 0
      ? await TeamMembership.find({ teamId: { $in: teamIds } })
          .sort({ joinedAt: 1, _id: 1 })
          .lean()
      : [];

  const userIds = Array.from(new Set(memberships.map((m) => m.userId.toString())));
  const users =
    userIds.length > 0
      ? await User.find({ _id: { $in: userIds } })
          .select('_id name email avatar role isActive')
          .lean()
      : [];

  const userMap = new Map(users.map((u) => [u._id.toString(), u]));
  const membersByTeamId = new Map();

  for (const membership of memberships) {
    const key = membership.teamId.toString();
    if (!membersByTeamId.has(key)) {
      membersByTeamId.set(key, []);
    }
    const u = userMap.get(membership.userId.toString());
    membersByTeamId.get(key).push({
      userId: membership.userId.toString(),
      name: u?.name ?? 'Unknown User',
      email: u?.email ?? null,
      avatar: u?.avatar ?? null,
      globalRole: u?.role ?? null,
      isActive: u?.isActive ?? false,
      teamRole: membership.teamRole,
      isReady: Boolean(membership.isReady),
      readyAt: membership.readyAt ? new Date(membership.readyAt).toISOString() : null,
      joinedAt: membership.joinedAt ? new Date(membership.joinedAt).toISOString() : null
    });
  }

  let formingTeamCount = 0;
  let formedTeamCount = 0;
  let readyTeamCount = 0;

  const formattedTeams = teams.map((team) => {
    if (team.status === TEAM_STATUSES.FORMING) {
      formingTeamCount += 1;
    } else if (team.status === TEAM_STATUSES.FORMED) {
      formedTeamCount += 1;
    } else if (team.status === TEAM_STATUSES.READY) {
      readyTeamCount += 1;
    }

    const teamIdStr = team._id.toString();
    const teamMembers = membersByTeamId.get(teamIdStr) ?? [];
    const leaderUser = team.leaderId ? userMap.get(team.leaderId.toString()) : null;
    const evaluation = readiness.teamEvaluations.get(teamIdStr) ?? {
      isEligible: false,
      proposedHeadStart: null,
      issues: []
    };

    return {
      id: teamIdStr,
      name: team.name,
      status: team.status,
      revision: team.revision,
      capacity: competition.teamSize,
      memberCount: team.memberCount,
      readyMemberCount: team.readyMemberCount,
      round1Rank: team.round1Rank ?? null,
      round1MappingStatus: team.round1MappingStatus ?? RANK_MAPPING_STATUSES.UNMAPPED,
      isExcluded: Boolean(team.isExcluded),
      excludedAt: team.excludedAt ? new Date(team.excludedAt).toISOString() : null,
      exclusionReason: team.exclusionReason ?? null,
      isEligible: evaluation.isEligible,
      eligibilityIssues: evaluation.issues,
      proposedHeadStart: evaluation.proposedHeadStart,
      frozenHeadStartDistance: team.frozenHeadStartDistance ?? null,
      leader: leaderUser
        ? {
            userId: leaderUser._id.toString(),
            name: leaderUser.name,
            email: leaderUser.email,
            avatar: leaderUser.avatar ?? null,
            globalRole: leaderUser.role
          }
        : null,
      members: teamMembers,
      createdAt: team.createdAt ? new Date(team.createdAt).toISOString() : null,
      updatedAt: team.updatedAt ? new Date(team.updatedAt).toISOString() : null
    };
  });

  return {
    competition: {
      id: competition._id.toString(),
      slug: competition.slug,
      name: competition.name,
      status: competition.status,
      teamSize: competition.teamSize,
      maxTeams: competition.maxTeams,
      activeTeamCount: competition.activeTeamCount,
      rosterVersion: competition.rosterVersion,
      durationSeconds: competition.durationSeconds,
      maxHeadStart: competition.maxHeadStart,
      qualificationLimit: competition.qualificationLimit,
      rankImportVersion: competition.rankImportVersion,
      rankImportConfirmed: readiness.rankConfirmed,
      rankImportConfirmedVersion: competition.rankImportConfirmedVersion ?? null,
      lockedRosterVersion: competition.lockedRosterVersion ?? null,
      eligibleTeamCount: competition.eligibleTeamCount ?? 0,
      lockedAt: competition.lockedAt ? new Date(competition.lockedAt).toISOString() : null,
      startedAt: competition.startedAt ? new Date(competition.startedAt).toISOString() : null,
      endsAt: competition.endsAt ? new Date(competition.endsAt).toISOString() : null,
      remainingSeconds: computeRemainingSeconds(competition.endsAt, nowMs),
      lifecycleVersion: competition.lifecycleVersion
    },
    summary: {
      activeTeamCount: formattedTeams.length,
      formingTeamCount,
      formedTeamCount,
      readyTeamCount,
      excludedTeamCount: readiness.excludedTeamCount,
      unmappedTeamCount: readiness.unmappedTeamCount,
      eligibleTeamCount: readiness.eligibleTeamCount,
      totalJoinedUsers: memberships.length
    },
    teams: formattedTeams,
    serverTime: new Date(nowMs).toISOString()
  };
}
