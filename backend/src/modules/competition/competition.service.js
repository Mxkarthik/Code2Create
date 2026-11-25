import { AppError } from '../../utils/AppError.js';
import { runInTransaction } from '../../utils/transaction.js';
import {
  ACTIVE_TEAM_STATUSES,
  RANK_MAPPING_STATUSES,
  TEAM_STATUSES,
  Team
} from '../teams/team.model.js';
import { TEAM_ROLES, TeamMembership } from '../teams/teamMembership.model.js';
import { User } from '../users/user.model.js';
import {
  COMPETITION_STATUSES,
  Competition,
  DEFAULT_COMPETITION_SLUG
} from './competition.model.js';
import { FrozenRosterEntry } from './frozenRoster.model.js';
import { calculateHeadStart } from './headStart.js';
import { TeamRoundState } from './teamRoundState.model.js';

/**
 * Compute authoritative remaining seconds from endsAt and trusted server clock.
 * Policy: ceil(remainingMs / 1000) while strictly positive, 0 at or after endsAt.
 */
export function computeRemainingSeconds(endsAt, nowMs) {
  if (!endsAt) {
    return null;
  }
  const remainingMs = Math.max(0, new Date(endsAt).getTime() - nowMs);
  if (remainingMs <= 0) {
    return 0;
  }
  return Math.ceil(remainingMs / 1000);
}

/**
 * Idempotently ensure the default CODE RUSH competition document exists without
 * resetting existing status, timestamps, team counts, or configuration.
 */
export async function ensureDefaultCompetition({
  slug = DEFAULT_COMPETITION_SLUG,
  name = 'CODE RUSH',
  teamSize = 2,
  maxTeams = 50,
  durationSeconds = 1800,
  maxChallengeOpportunities = 6,
  maxHeadStart = 20,
  qualificationLimit = 10
} = {}) {
  try {
    const doc = await Competition.findOneAndUpdate(
      { slug },
      {
        $setOnInsert: {
          slug,
          name,
          status: COMPETITION_STATUSES.LOBBY,
          teamSize,
          maxTeams,
          activeTeamCount: 0,
          rosterVersion: 0,
          durationSeconds,
          maxChallengeOpportunities,
          maxHeadStart,
          qualificationLimit,
          rankImportVersion: 0,
          eligibleTeamCount: 0,
          lifecycleVersion: 0
        }
      },
      {
        upsert: true,
        returnDocument: 'after',
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    // Backfill Phase 04 fields safely if upgrading a Phase 03 record without altering status/timestamps.
    if (doc && doc.durationSeconds === undefined) {
      await Competition.updateOne(
        { _id: doc._id, durationSeconds: { $exists: false } },
        {
          $set: {
            durationSeconds,
            maxChallengeOpportunities,
            maxHeadStart,
            qualificationLimit,
            rankImportVersion: 0,
            eligibleTeamCount: 0,
            lifecycleVersion: 0
          }
        }
      );
      return Competition.findById(doc._id);
    }

    return doc;
  } catch (err) {
    if (err?.code === 11000) {
      return Competition.findOne({ slug });
    }
    throw err;
  }
}

/**
 * Retrieve the active competition document by slug.
 */
export async function getActiveCompetition({ slug = DEFAULT_COMPETITION_SLUG, session } = {}) {
  const query = Competition.findOne({ slug });
  if (session) {
    query.session(session);
  }
  const competition = await query.lean();
  if (!competition) {
    throw AppError.serviceUnavailable(
      'Competition configuration has not been initialized',
      'COMPETITION_NOT_INITIALIZED'
    );
  }
  return competition;
}

/**
 * Atomically reconcile an expired LIVE competition into SETTLING.
 * Idempotent: concurrent or repeated invocations execute the transition at most once
 * and never overwrite SETTLING timestamps or COMPLETED terminal state.
 */
export async function reconcileCompetitionDeadline({
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now(),
  logger,
  session
} = {}) {
  const nowDate = new Date(nowFn());

  const query = Competition.findOneAndUpdate(
    {
      slug: competitionSlug,
      status: COMPETITION_STATUSES.LIVE,
      endsAt: { $lte: nowDate }
    },
    {
      $set: {
        status: COMPETITION_STATUSES.SETTLING,
        settlingAt: nowDate
      },
      $inc: { lifecycleVersion: 1 }
    },
    {
      ...(session ? { session } : {}),
      returnDocument: 'after'
    }
  ).lean();

  const transitioned = await query;

  if (transitioned) {
    logger?.info(
      { competitionId: transitioned._id.toString(), endsAt: transitioned.endsAt },
      'Competition deadline reached'
    );
    logger?.info(
      { competitionId: transitioned._id.toString(), lifecycleVersion: transitioned.lifecycleVersion },
      'Competition entering settlement'
    );
  }

  return transitioned;
}

/**
 * Transaction-safe atomic mutation guard on the Competition document.
 * Acquires a document-level write lock inside the transaction so concurrent
 * roster mutations and roster locking cannot race past LOBBY or maxTeams.
 */
export async function acquireLobbyMutationGuard({
  competitionId,
  session,
  activeTeamCountDelta = 0,
  requireCapacity = false,
  clearRankConfirmation = false,
  errorCodeOnClosed = 'LOBBY_CLOSED'
}) {
  const filter = {
    _id: competitionId,
    status: COMPETITION_STATUSES.LOBBY
  };

  if (requireCapacity) {
    filter.$expr = { $lt: ['$activeTeamCount', '$maxTeams'] };
  } else if (activeTeamCountDelta < 0) {
    filter.activeTeamCount = { $gte: Math.abs(activeTeamCountDelta) };
  }

  const update = {
    $inc: {
      rosterVersion: 1,
      ...(activeTeamCountDelta !== 0 ? { activeTeamCount: activeTeamCountDelta } : {})
    },
    ...(clearRankConfirmation
      ? {
          $set: {
            rankImportConfirmedVersion: null,
            rankImportConfirmedAt: null,
            rankImportConfirmedBy: null
          }
        }
      : {})
  };

  const updated = await Competition.findOneAndUpdate(filter, update, {
    session,
    returnDocument: 'after'
  });

  if (updated) {
    return updated;
  }

  const current = await Competition.findById(competitionId).session(session).lean();
  if (!current) {
    throw AppError.serviceUnavailable(
      'Competition configuration has not been initialized',
      'COMPETITION_NOT_INITIALIZED'
    );
  }

  if (current.status !== COMPETITION_STATUSES.LOBBY) {
    throw new AppError('Team changes are closed because the competition is no longer in LOBBY', {
      statusCode: 409,
      code: errorCodeOnClosed
    });
  }

  if (requireCapacity && current.activeTeamCount >= current.maxTeams) {
    throw new AppError('Maximum number of active teams has been reached', {
      statusCode: 409,
      code: 'TEAM_LIMIT_REACHED'
    });
  }

  throw new AppError('Unable to acquire competition roster guard', {
    statusCode: 409,
    code: 'TEAM_STATE_CONFLICT'
  });
}

/**
 * Evaluate explicit roster eligibility, blocking issues, and proposed head starts.
 */
export async function evaluateRosterReadiness({
  competition,
  session
}) {
  const activeTeams = await Team.find({
    competitionId: competition._id,
    status: { $in: ACTIVE_TEAM_STATUSES }
  })
    .sort({ createdAt: 1, _id: 1 })
    .session(session ?? null)
    .lean();

  const teamIds = activeTeams.map((t) => t._id);
  const memberships =
    teamIds.length > 0
      ? await TeamMembership.find({ teamId: { $in: teamIds } })
          .sort({ joinedAt: 1, _id: 1 })
          .session(session ?? null)
          .lean()
      : [];

  const userIds = Array.from(new Set(memberships.map((m) => m.userId.toString())));
  const users =
    userIds.length > 0
      ? await User.find({ _id: { $in: userIds } })
          .select('_id name email role isActive')
          .session(session ?? null)
          .lean()
      : [];

  const userMap = new Map(users.map((u) => [u._id.toString(), u]));
  const membershipsByTeam = new Map();

  for (const m of memberships) {
    const key = m.teamId.toString();
    if (!membershipsByTeam.has(key)) {
      membershipsByTeam.set(key, []);
    }
    membershipsByTeam.get(key).push(m);
  }

  const rankConfirmed =
    competition.rankImportVersion > 0 &&
    competition.rankImportConfirmedVersion === competition.rankImportVersion &&
    Boolean(competition.rankImportConfirmedAt) &&
    Number.isInteger(competition.round1RankedTeamCount) &&
    competition.round1RankedTeamCount >= 1;

  const blockingIssues = [];
  const eligibleTeams = [];
  const proposedHeadStarts = [];
  const teamEvaluations = new Map();

  let readyTeamCount = 0;
  let incompleteTeamCount = 0;
  let unreadyTeamCount = 0;
  let excludedTeamCount = 0;
  let unmappedTeamCount = 0;

  for (const team of activeTeams) {
    const teamIdStr = team._id.toString();
    const teamMembers = membershipsByTeam.get(teamIdStr) ?? [];
    const teamIssues = [];

    if (team.status === TEAM_STATUSES.READY) {
      readyTeamCount += 1;
    }

    if (team.isExcluded) {
      excludedTeamCount += 1;
      teamEvaluations.set(teamIdStr, {
        isEligible: false,
        proposedHeadStart: null,
        issues: ['TEAM_EXCLUDED']
      });
      continue;
    }

    const hasFullMembers =
      team.memberCount === competition.teamSize &&
      teamMembers.length === competition.teamSize;
    if (!hasFullMembers) {
      incompleteTeamCount += 1;
      teamIssues.push({
        code: 'INCOMPLETE_TEAM',
        teamId: teamIdStr,
        teamName: team.name,
        message: `Team "${team.name}" has ${teamMembers.length}/${competition.teamSize} members`
      });
    }

    const allReady = teamMembers.length > 0 && teamMembers.every((m) => m.isReady === true);
    if (hasFullMembers && !allReady) {
      unreadyTeamCount += 1;
      teamIssues.push({
        code: 'UNREADY_TEAM',
        teamId: teamIdStr,
        teamName: team.name,
        message: `Team "${team.name}" has members who have not confirmed readiness`
      });
    }

    const inactiveMembers = teamMembers.filter((m) => {
      const u = userMap.get(m.userId.toString());
      return !u || u.isActive !== true;
    });
    if (inactiveMembers.length > 0) {
      teamIssues.push({
        code: 'DISABLED_ACCOUNT_MEMBER',
        teamId: teamIdStr,
        teamName: team.name,
        message: `Team "${team.name}" includes a disabled or missing user account`
      });
    }

    const leaderMembership = teamMembers.find((m) => m.teamRole === TEAM_ROLES.TEAM_LEADER);
    const hasValidLeader =
      Boolean(leaderMembership) &&
      Boolean(team.leaderId) &&
      leaderMembership.userId.toString() === team.leaderId.toString();
    if (!hasValidLeader) {
      teamIssues.push({
        code: 'INVALID_LEADER',
        teamId: teamIdStr,
        teamName: team.name,
        message: `Team "${team.name}" lacks a consistent TEAM_LEADER membership`
      });
    }

    const hasValidRankMapping =
      team.round1MappingStatus === RANK_MAPPING_STATUSES.MAPPED &&
      Number.isInteger(team.round1Rank) &&
      team.round1RankImportVersion === competition.rankImportVersion &&
      Number.isInteger(competition.round1RankedTeamCount) &&
      team.round1RankedTeamCount === competition.round1RankedTeamCount &&
      team.round1Rank >= 1 &&
      team.round1Rank <= competition.round1RankedTeamCount;

    if (!hasValidRankMapping) {
      unmappedTeamCount += 1;
      const isStale = team.round1MappingStatus === RANK_MAPPING_STATUSES.STALE;
      teamIssues.push({
        code: isStale ? 'ROUND1_MAPPING_STALE' : 'UNMAPPED_TEAM',
        teamId: teamIdStr,
        teamName: team.name,
        message: isStale
          ? `Team "${team.name}" had membership changes invalidating its Round 1 rank mapping`
          : `Team "${team.name}" has no valid Round 1 rank mapping`
      });
    }

    let proposedHeadStart = null;
    if (hasValidRankMapping) {
      proposedHeadStart = calculateHeadStart(
        team.round1Rank,
        competition.round1RankedTeamCount,
        competition.maxHeadStart
      );
      proposedHeadStarts.push({
        teamId: teamIdStr,
        teamName: team.name,
        round1Rank: team.round1Rank,
        rankedTeamCount: competition.round1RankedTeamCount,
        headStartDistance: proposedHeadStart
      });
    }

    if (teamIssues.length > 0) {
      blockingIssues.push(...teamIssues);
      teamEvaluations.set(teamIdStr, {
        isEligible: false,
        proposedHeadStart,
        issues: teamIssues.map((i) => i.code)
      });
    } else {
      eligibleTeams.push({
        team,
        members: teamMembers,
        leaderId: team.leaderId,
        round1Rank: team.round1Rank,
        round1RankedTeamCount: competition.round1RankedTeamCount,
        headStartDistance: proposedHeadStart
      });
      teamEvaluations.set(teamIdStr, {
        isEligible: true,
        proposedHeadStart,
        issues: []
      });
    }
  }

  if (!rankConfirmed) {
    blockingIssues.push({
      code: 'ROUND1_RANK_UNCONFIRMED',
      message: 'Round 1 rankings must be imported and confirmed before locking the roster'
    });
  }

  if (eligibleTeams.length === 0) {
    blockingIssues.push({
      code: 'ROSTER_EMPTY',
      message: 'At least one eligible team is required to lock the roster'
    });
  }

  return {
    rankConfirmed,
    activeTeamCount: activeTeams.length,
    readyTeamCount,
    incompleteTeamCount,
    unreadyTeamCount,
    excludedTeamCount,
    unmappedTeamCount,
    eligibleTeamCount: eligibleTeams.length,
    eligibleTeams,
    proposedHeadStarts,
    blockingIssues,
    teamEvaluations,
    canLock:
      competition.status === COMPETITION_STATUSES.LOBBY && blockingIssues.length === 0
  };
}

/**
 * Replace the staged Round 1 ranking dataset atomically inside LOBBY.
 * Invalidates any previous ranking confirmation.
 */
export async function importRound1Ranks({
  rankedTeamCount,
  entries,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guarded = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session,
      clearRankConfirmation: true
    });

    const requestedIds = entries.map((e) => e.teamId);
    const activeTeams = await Team.find({
      competitionId: guarded._id,
      status: { $in: ACTIVE_TEAM_STATUSES }
    })
      .session(session)
      .lean();

    const activeById = new Map(activeTeams.map((t) => [t._id.toString(), t]));

    if (requestedIds.length > 0) {
      const allFound = await Team.find({ _id: { $in: requestedIds } })
        .select('_id competitionId status')
        .session(session)
        .lean();
      const foundMap = new Map(allFound.map((t) => [t._id.toString(), t]));

      for (const reqId of requestedIds) {
        const doc = foundMap.get(reqId);
        if (!doc || doc.competitionId.toString() !== guarded._id.toString()) {
          throw AppError.notFound(`Team ${reqId} not found in this competition`, 'TEAM_NOT_FOUND');
        }
        if (doc.status === TEAM_STATUSES.DISSOLVED) {
          throw AppError.badRequest(
            `Dissolved team ${reqId} cannot be assigned a Round 1 rank`,
            'ROUND1_RANK_INVALID'
          );
        }
      }
    }

    const nextImportVersion = guarded.rankImportVersion + 1;

    await Competition.updateOne(
      { _id: guarded._id },
      {
        $set: {
          round1RankedTeamCount: rankedTeamCount,
          rankImportVersion: nextImportVersion,
          rankImportConfirmedVersion: null,
          rankImportConfirmedAt: null,
          rankImportConfirmedBy: null
        }
      },
      { session }
    );

    // Replacement semantics: reset all active teams first, then apply staged entries sequentially.
    await Team.updateMany(
      {
        competitionId: guarded._id,
        status: { $in: ACTIVE_TEAM_STATUSES }
      },
      {
        $set: {
          round1Rank: null,
          round1RankedTeamCount: null,
          round1RankImportVersion: null,
          round1MappingStatus: RANK_MAPPING_STATUSES.UNMAPPED
        }
      },
      { session }
    );

    const entryMap = new Map(entries.map((e) => [e.teamId, e.rank]));
    for (const entry of entries) {
      await Team.updateOne(
        { _id: entry.teamId, competitionId: guarded._id },
        {
          $set: {
            round1Rank: entry.rank,
            round1RankedTeamCount: rankedTeamCount,
            round1RankImportVersion: nextImportVersion,
            round1MappingStatus: RANK_MAPPING_STATUSES.MAPPED
          }
        },
        { session }
      );
    }

    const mapped = [];
    const unmapped = [];
    const excluded = [];

    for (const team of activeTeams) {
      const idStr = team._id.toString();
      const rank = entryMap.get(idStr);
      if (team.isExcluded) {
        excluded.push({ teamId: idStr, name: team.name, round1Rank: rank ?? null });
      } else if (rank !== undefined) {
        mapped.push({
          teamId: idStr,
          name: team.name,
          round1Rank: rank,
          proposedHeadStart: calculateHeadStart(rank, rankedTeamCount, guarded.maxHeadStart)
        });
      } else {
        unmapped.push({ teamId: idStr, name: team.name });
      }
    }

    return {
      rankImportVersion: nextImportVersion,
      rosterVersion: guarded.rosterVersion,
      rankedTeamCount,
      rankImportConfirmed: false,
      summary: {
        mappedCount: mapped.length,
        unmappedCount: unmapped.length,
        excludedCount: excluded.length
      },
      mapped,
      unmapped,
      excluded
    };
  });

  if (typeof logger?.success === 'function') {
    logger.success(
      {
        rankImportVersion: outcome.rankImportVersion,
        mappedCount: outcome.summary.mappedCount
      },
      'Round 1 ranks imported'
    );
  } else {
    logger?.info('Round 1 ranks imported');
  }

  return outcome;
}

/**
 * Confirm the staged Round 1 rank import version.
 */
export async function confirmRound1Ranks({
  adminUser,
  rankImportVersion,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now()
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guarded = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session
    });

    if (guarded.rankImportVersion <= 0 || !guarded.round1RankedTeamCount) {
      throw new AppError('No staged Round 1 rank import exists to confirm', {
        statusCode: 409,
        code: 'ROUND1_RANK_UNCONFIRMED'
      });
    }

    if (rankImportVersion !== guarded.rankImportVersion) {
      throw new AppError(
        `Stale rankImportVersion ${rankImportVersion}; current version is ${guarded.rankImportVersion}`,
        {
          statusCode: 409,
          code: 'ROSTER_VERSION_CONFLICT'
        }
      );
    }

    const staleTeamsCount = await Team.countDocuments({
      competitionId: guarded._id,
      status: { $in: ACTIVE_TEAM_STATUSES },
      isExcluded: false,
      round1MappingStatus: RANK_MAPPING_STATUSES.STALE
    }).session(session);

    if (staleTeamsCount > 0) {
      throw new AppError(
        'One or more teams had membership changes requiring fresh Round 1 rank verification before confirmation',
        {
          statusCode: 409,
          code: 'ROUND1_MAPPING_STALE'
        }
      );
    }

    const confirmedAt = new Date(nowFn());
    await Competition.updateOne(
      { _id: guarded._id },
      {
        $set: {
          rankImportConfirmedVersion: guarded.rankImportVersion,
          rankImportConfirmedAt: confirmedAt,
          rankImportConfirmedBy: adminUser._id
        }
      },
      { session }
    );

    return {
      rankImportVersion: guarded.rankImportVersion,
      rankImportConfirmed: true,
      rankImportConfirmedVersion: guarded.rankImportVersion,
      rankImportConfirmedAt: confirmedAt.toISOString(),
      rankImportConfirmedBy: adminUser._id.toString(),
      rosterVersion: guarded.rosterVersion
    };
  });

  if (typeof logger?.success === 'function') {
    logger.success(
      { rankImportVersion: outcome.rankImportVersion },
      'Round 1 rankings confirmed'
    );
  } else {
    logger?.info('Round 1 rankings confirmed');
  }

  return outcome;
}

/**
 * Exclude or re-include an active team during LOBBY.
 */
export async function setTeamExclusion({
  adminUser,
  teamId,
  exclude,
  reason = null,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now()
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guarded = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session
    });

    const team = await Team.findOne({
      _id: teamId,
      competitionId: guarded._id
    }).session(session);

    if (!team) {
      throw AppError.notFound('Team not found in this competition', 'TEAM_NOT_FOUND');
    }

    if (team.status === TEAM_STATUSES.DISSOLVED) {
      throw new AppError('Dissolved teams cannot change exclusion status', {
        statusCode: 409,
        code: 'TEAM_STATE_CONFLICT'
      });
    }

    if (exclude) {
      team.isExcluded = true;
      team.excludedAt = new Date(nowFn());
      team.excludedBy = adminUser._id;
      team.exclusionReason = reason.trim();
    } else {
      team.isExcluded = false;
      team.excludedAt = null;
      team.excludedBy = null;
      team.exclusionReason = null;
    }

    team.revision += 1;
    await team.save({ session });

    return {
      teamId: team._id.toString(),
      name: team.name,
      isExcluded: team.isExcluded,
      excludedAt: team.excludedAt ? team.excludedAt.toISOString() : null,
      exclusionReason: team.exclusionReason,
      rosterVersion: guarded.rosterVersion
    };
  });

  logger?.info(
    { teamId: outcome.teamId, isExcluded: outcome.isExcluded },
    outcome.isExcluded
      ? 'Team excluded from competition'
      : 'Team restored to competition eligibility'
  );

  return outcome;
}

/**
 * Update explicitly allowlisted competition configuration during LOBBY.
 */
export async function updateCompetitionConfig({
  updates,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });
    const guarded = await acquireLobbyMutationGuard({
      competitionId: competition._id,
      session,
      errorCodeOnClosed: 'CONFIGURATION_LOCKED'
    });

    const setFields = {};
    if (updates.durationSeconds !== undefined) {
      setFields.durationSeconds = updates.durationSeconds;
    }
    if (updates.maxHeadStart !== undefined) {
      setFields.maxHeadStart = updates.maxHeadStart;
    }
    if (updates.qualificationLimit !== undefined) {
      setFields.qualificationLimit = updates.qualificationLimit;
    }

    const updated = await Competition.findByIdAndUpdate(
      guarded._id,
      { $set: setFields },
      { session, returnDocument: 'after', runValidators: true }
    ).lean();

    return {
      competitionId: updated._id.toString(),
      slug: updated.slug,
      name: updated.name,
      status: updated.status,
      durationSeconds: updated.durationSeconds,
      maxHeadStart: updated.maxHeadStart,
      qualificationLimit: updated.qualificationLimit,
      teamSize: updated.teamSize,
      maxTeams: updated.maxTeams,
      rosterVersion: updated.rosterVersion,
      rankImportVersion: updated.rankImportVersion
    };
  });

  logger?.info({ competitionId: outcome.competitionId }, 'Competition configuration updated');
  return outcome;
}

/**
 * Return detailed roster readiness preview for ADMIN before locking.
 */
export async function getRosterPreview({
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now()
} = {}) {
  const competition = await getActiveCompetition({ slug: competitionSlug });
  const readiness = await evaluateRosterReadiness({ competition });

  return {
    competitionId: competition._id.toString(),
    status: competition.status,
    rosterVersion: competition.rosterVersion,
    rankImportVersion: competition.rankImportVersion,
    rankImportConfirmed: readiness.rankConfirmed,
    rankImportConfirmedVersion: competition.rankImportConfirmedVersion ?? null,
    round1RankedTeamCount: competition.round1RankedTeamCount ?? null,
    maxHeadStart: competition.maxHeadStart,
    activeTeamCount: readiness.activeTeamCount,
    readyTeamCount: readiness.readyTeamCount,
    incompleteTeamCount: readiness.incompleteTeamCount,
    unreadyTeamCount: readiness.unreadyTeamCount,
    excludedTeamCount: readiness.excludedTeamCount,
    unmappedTeamCount: readiness.unmappedTeamCount,
    eligibleTeamCount: readiness.eligibleTeamCount,
    proposedHeadStarts: readiness.proposedHeadStarts,
    blockingIssues: readiness.blockingIssues,
    canLock: readiness.canLock,
    serverTime: new Date(nowFn()).toISOString()
  };
}

/**
 * Atomically lock the eligible roster, freeze head starts, and initialize TeamRoundState once.
 */
export async function lockCompetitionRoster({
  adminUser,
  expectedRosterVersion,
  expectedRankImportVersion,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now()
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });

    if (competition.status !== COMPETITION_STATUSES.LOBBY) {
      throw new AppError(
        `Cannot lock roster while competition status is ${competition.status}`,
        {
          statusCode: 409,
          code: 'INVALID_COMPETITION_STATE'
        }
      );
    }

    if (
      competition.rosterVersion !== expectedRosterVersion ||
      competition.rankImportVersion !== expectedRankImportVersion
    ) {
      throw new AppError(
        'Roster preview is stale; reload roster-preview and retry locking',
        {
          statusCode: 409,
          code: 'ROSTER_VERSION_CONFLICT'
        }
      );
    }

    // Acquire atomic conditional write lock on Competition first so concurrent
    // team mutations or concurrent lock requests serialize on this document.
    const lockedCompetition = await Competition.findOneAndUpdate(
      {
        _id: competition._id,
        status: COMPETITION_STATUSES.LOBBY,
        rosterVersion: expectedRosterVersion,
        rankImportVersion: expectedRankImportVersion
      },
      {
        $set: { status: COMPETITION_STATUSES.LOCKED },
        $inc: { lifecycleVersion: 1 }
      },
      { session, returnDocument: 'after' }
    );

    if (!lockedCompetition) {
      throw new AppError('Roster changed concurrently or competition is already locked', {
        statusCode: 409,
        code: 'ROSTER_VERSION_CONFLICT'
      });
    }

    const readiness = await evaluateRosterReadiness({
      competition: lockedCompetition,
      session
    });

    if (!readiness.rankConfirmed) {
      throw new AppError(
        'Round 1 rankings must be confirmed before locking the roster',
        {
          statusCode: 409,
          code: 'ROUND1_RANK_UNCONFIRMED'
        }
      );
    }

    if (readiness.eligibleTeamCount === 0 && readiness.blockingIssues.every((b) => b.code === 'ROSTER_EMPTY')) {
      throw new AppError('At least one eligible team is required to lock the roster', {
        statusCode: 409,
        code: 'ROSTER_EMPTY'
      });
    }

    const nonEmptyIssues = readiness.blockingIssues.filter((b) => b.code !== 'ROSTER_EMPTY');
    if (nonEmptyIssues.length > 0) {
      throw new AppError('Roster has unresolved eligibility issues preventing lock', {
        statusCode: 409,
        code: 'ROSTER_NOT_READY',
        details: nonEmptyIssues
      });
    }

    if (readiness.eligibleTeamCount === 0) {
      throw new AppError('At least one eligible team is required to lock the roster', {
        statusCode: 409,
        code: 'ROSTER_EMPTY'
      });
    }

    const lockedAt = new Date(nowFn());

    // Sequentially freeze roster and initialize TeamRoundState (never Promise.all inside tx).
    for (const item of readiness.eligibleTeams) {
      const frozenMemberIds = item.members.map((m) => m.userId);

      await Team.updateOne(
        { _id: item.team._id },
        {
          $set: { frozenHeadStartDistance: item.headStartDistance },
          $inc: { revision: 1 }
        },
        { session }
      );

      await FrozenRosterEntry.create(
        [
          {
            competitionId: lockedCompetition._id,
            teamId: item.team._id,
            teamName: item.team.name,
            frozenLeaderId: item.leaderId,
            frozenMemberIds,
            round1Rank: item.round1Rank,
            round1RankedTeamCount: item.round1RankedTeamCount,
            headStartDistance: item.headStartDistance,
            rosterVersion: expectedRosterVersion,
            lockedAt
          }
        ],
        { session }
      );

      await TeamRoundState.create(
        [
          {
            competitionId: lockedCompetition._id,
            teamId: item.team._id,
            frozenLeaderId: item.leaderId,
            frozenMemberIds,
            round1Rank: item.round1Rank,
            headStartDistance: item.headStartDistance,
            earnedDistance: 0,
            totalDistance: item.headStartDistance,
            challengeOpportunitiesUsed: 0,
            sampleRunsUsed: 0,
            finalSubmissionsUsed: 0,
            rejectedFinalSubmissions: 0,
            activeChallengeAttemptId: null,
            pendingSubmissionId: null,
            stateVersion: 1
          }
        ],
        { session }
      );
    }

    const finalCompetition = await Competition.findByIdAndUpdate(
      lockedCompetition._id,
      {
        $set: {
          lockedAt,
          lockedBy: adminUser._id,
          lockedRosterVersion: expectedRosterVersion,
          eligibleTeamCount: readiness.eligibleTeams.length
        }
      },
      { session, returnDocument: 'after' }
    ).lean();

    return {
      competition: {
        id: finalCompetition._id.toString(),
        slug: finalCompetition.slug,
        name: finalCompetition.name,
        status: finalCompetition.status,
        durationSeconds: finalCompetition.durationSeconds,
        maxHeadStart: finalCompetition.maxHeadStart,
        qualificationLimit: finalCompetition.qualificationLimit,
        lockedAt: finalCompetition.lockedAt.toISOString(),
        lockedRosterVersion: finalCompetition.lockedRosterVersion,
        eligibleTeamCount: finalCompetition.eligibleTeamCount,
        lifecycleVersion: finalCompetition.lifecycleVersion
      },
      frozenTeams: readiness.eligibleTeams.map((item) => ({
        teamId: item.team._id.toString(),
        teamName: item.team.name,
        round1Rank: item.round1Rank,
        headStartDistance: item.headStartDistance,
        memberCount: item.members.length
      }))
    };
  });

  if (typeof logger?.success === 'function') {
    logger.success(
      { eligibleTeamCount: outcome.competition.eligibleTeamCount },
      `Competition roster locked — ${outcome.competition.eligibleTeamCount} eligible teams`
    );
  } else {
    logger?.info(
      `Competition roster locked — ${outcome.competition.eligibleTeamCount} eligible teams`
    );
  }

  return outcome;
}

/**
 * Start a LOCKED competition atomically and establish authoritative server timestamps.
 */
export async function startCompetition({
  adminUser,
  logger,
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now()
}) {
  const outcome = await runInTransaction(async (session) => {
    const competition = await getActiveCompetition({ slug: competitionSlug, session });

    if (
      competition.status === COMPETITION_STATUSES.LIVE ||
      competition.status === COMPETITION_STATUSES.SETTLING ||
      competition.status === COMPETITION_STATUSES.COMPLETED
    ) {
      throw new AppError('Competition has already been started', {
        statusCode: 409,
        code: 'COMPETITION_ALREADY_STARTED'
      });
    }

    if (competition.status !== COMPETITION_STATUSES.LOCKED) {
      throw new AppError(
        `Competition must be LOCKED before starting (current status: ${competition.status})`,
        {
          statusCode: 409,
          code: 'INVALID_COMPETITION_STATE'
        }
      );
    }

    const frozenCount = await FrozenRosterEntry.countDocuments({
      competitionId: competition._id
    }).session(session);
    const roundStateCount = await TeamRoundState.countDocuments({
      competitionId: competition._id
    }).session(session);

    if (frozenCount < 1 || roundStateCount !== frozenCount) {
      throw new AppError('Frozen eligible roster and team round states are incomplete', {
        statusCode: 409,
        code: 'ROSTER_NOT_READY'
      });
    }

    const startedAt = new Date(nowFn());
    const endsAt = new Date(startedAt.getTime() + competition.durationSeconds * 1000);

    const started = await Competition.findOneAndUpdate(
      {
        _id: competition._id,
        status: COMPETITION_STATUSES.LOCKED
      },
      {
        $set: {
          status: COMPETITION_STATUSES.LIVE,
          startedAt,
          startedBy: adminUser._id,
          endsAt
        },
        $inc: { lifecycleVersion: 1 }
      },
      { session, returnDocument: 'after' }
    ).lean();

    if (!started) {
      throw new AppError('Competition has already been started', {
        statusCode: 409,
        code: 'COMPETITION_ALREADY_STARTED'
      });
    }

    const serverNowMs = startedAt.getTime();
    return {
      competitionId: started._id.toString(),
      status: started.status,
      startedAt: started.startedAt.toISOString(),
      endsAt: started.endsAt.toISOString(),
      durationSeconds: started.durationSeconds,
      serverTime: new Date(serverNowMs).toISOString(),
      remainingSeconds: computeRemainingSeconds(started.endsAt, serverNowMs),
      eligibleTeamCount: started.eligibleTeamCount,
      lifecycleVersion: started.lifecycleVersion
    };
  });

  const durationLabel =
    outcome.durationSeconds % 60 === 0
      ? `${outcome.durationSeconds / 60} minutes`
      : `${outcome.durationSeconds} seconds`;

  if (typeof logger?.success === 'function') {
    logger.success(
      { durationSeconds: outcome.durationSeconds, endsAt: outcome.endsAt },
      `Competition started — ${durationLabel}`
    );
  } else {
    logger?.info(`Competition started — ${durationLabel}`);
  }

  return outcome;
}

/**
 * Reconcile deadline first, then return the authoritative competition snapshot for admins.
 */
export async function getAdminCompetitionSnapshot({
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now(),
  logger
} = {}) {
  await reconcileCompetitionDeadline({ competitionSlug, nowFn, logger });
  const competition = await getActiveCompetition({ slug: competitionSlug });
  const nowMs = nowFn();

  const excludedTeamCount = await Team.countDocuments({
    competitionId: competition._id,
    status: { $in: ACTIVE_TEAM_STATUSES },
    isExcluded: true
  });

  const rankImportConfirmed =
    competition.rankImportVersion > 0 &&
    competition.rankImportConfirmedVersion === competition.rankImportVersion &&
    Boolean(competition.rankImportConfirmedAt);

  return {
    competition: {
      id: competition._id.toString(),
      slug: competition.slug,
      name: competition.name,
      status: competition.status,
      teamSize: competition.teamSize,
      maxTeams: competition.maxTeams,
      activeTeamCount: competition.activeTeamCount,
      durationSeconds: competition.durationSeconds,
      maxChallengeOpportunities: competition.maxChallengeOpportunities,
      maxHeadStart: competition.maxHeadStart,
      qualificationLimit: competition.qualificationLimit,
      rosterVersion: competition.rosterVersion,
      lockedRosterVersion: competition.lockedRosterVersion ?? null,
      rankImportVersion: competition.rankImportVersion,
      rankImportConfirmed,
      rankImportConfirmedVersion: competition.rankImportConfirmedVersion ?? null,
      rankImportConfirmedAt: competition.rankImportConfirmedAt
        ? new Date(competition.rankImportConfirmedAt).toISOString()
        : null,
      round1RankedTeamCount: competition.round1RankedTeamCount ?? null,
      eligibleTeamCount: competition.eligibleTeamCount ?? 0,
      excludedTeamCount,
      lockedAt: competition.lockedAt ? new Date(competition.lockedAt).toISOString() : null,
      startedAt: competition.startedAt ? new Date(competition.startedAt).toISOString() : null,
      endsAt: competition.endsAt ? new Date(competition.endsAt).toISOString() : null,
      settlingAt: competition.settlingAt
        ? new Date(competition.settlingAt).toISOString()
        : null,
      completedAt: competition.completedAt
        ? new Date(competition.completedAt).toISOString()
        : null,
      lifecycleVersion: competition.lifecycleVersion
    },
    remainingSeconds: computeRemainingSeconds(competition.endsAt, nowMs),
    serverTime: new Date(nowMs).toISOString()
  };
}

/**
 * Participant-safe current competition status and eligibility summary.
 */
export async function getParticipantCompetitionCurrent({
  user,
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now(),
  logger
}) {
  await reconcileCompetitionDeadline({ competitionSlug, nowFn, logger });
  const competition = await getActiveCompetition({ slug: competitionSlug });
  const nowMs = nowFn();

  const membership = await TeamMembership.findOne({
    competitionId: competition._id,
    userId: user._id
  }).lean();

  let frozenEntry = null;
  let team = null;

  if (competition.status !== COMPETITION_STATUSES.LOBBY) {
    frozenEntry = await FrozenRosterEntry.findOne({
      competitionId: competition._id,
      frozenMemberIds: user._id
    }).lean();
  }

  if (membership) {
    team = await Team.findOne({
      _id: membership.teamId,
      status: { $in: ACTIVE_TEAM_STATUSES }
    }).lean();
  }

  let isEligible = false;
  let eligibilityReason = 'NO_TEAM';

  if (competition.status === COMPETITION_STATUSES.LOBBY) {
    if (!team || !membership) {
      eligibilityReason = 'NO_TEAM';
    } else if (team.isExcluded) {
      eligibilityReason = 'TEAM_EXCLUDED';
    } else if (team.status !== TEAM_STATUSES.READY) {
      eligibilityReason = 'TEAM_NOT_READY';
    } else if (team.round1MappingStatus !== RANK_MAPPING_STATUSES.MAPPED) {
      eligibilityReason = 'ROUND1_UNMAPPED';
    } else {
      isEligible = true;
      eligibilityReason = 'ELIGIBLE_PENDING_LOCK';
    }
  } else if (frozenEntry) {
    isEligible = user.isActive === true;
    eligibilityReason = isEligible ? 'ELIGIBLE' : 'ACCOUNT_DISABLED';
  } else if (team?.isExcluded) {
    eligibilityReason = 'TEAM_EXCLUDED';
  } else {
    eligibilityReason = 'NOT_IN_FROZEN_ROSTER';
  }

  return {
    competition: {
      id: competition._id.toString(),
      slug: competition.slug,
      name: competition.name,
      status: competition.status,
      durationSeconds: competition.durationSeconds,
      teamSize: competition.teamSize,
      maxTeams: competition.maxTeams,
      maxChallengeOpportunities: competition.maxChallengeOpportunities,
      maxHeadStart: competition.maxHeadStart,
      qualificationLimit: competition.qualificationLimit,
      startedAt: competition.startedAt ? new Date(competition.startedAt).toISOString() : null,
      endsAt: competition.endsAt ? new Date(competition.endsAt).toISOString() : null
    },
    serverTime: new Date(nowMs).toISOString(),
    remainingSeconds: computeRemainingSeconds(competition.endsAt, nowMs),
    membership: {
      teamId: membership ? membership.teamId.toString() : null,
      teamRole: membership ? membership.teamRole : null,
      isEligible,
      eligibilityReason,
      inFrozenRoster: Boolean(frozenEntry)
    }
  };
}

/**
 * Participant-safe competition + own team round state recovery endpoint.
 * Never creates TeamRoundState implicitly and never leaks other teams' private state.
 */
export async function getParticipantCompetitionState({
  user,
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now(),
  logger
}) {
  const current = await getParticipantCompetitionCurrent({
    user,
    competitionSlug,
    nowFn,
    logger
  });

  if (current.competition.status === COMPETITION_STATUSES.LOBBY) {
    return {
      ...current,
      teamRoundState: null
    };
  }

  const frozenEntry = await FrozenRosterEntry.findOne({
    competitionId: current.competition.id,
    frozenMemberIds: user._id
  }).lean();

  if (!frozenEntry) {
    return {
      ...current,
      teamRoundState: null
    };
  }

  const roundState = await TeamRoundState.findOne({
    competitionId: current.competition.id,
    teamId: frozenEntry.teamId
  }).lean();

  if (!roundState) {
    return {
      ...current,
      teamRoundState: null
    };
  }

  return {
    ...current,
    teamRoundState: {
      teamId: roundState.teamId.toString(),
      teamName: frozenEntry.teamName,
      frozenLeaderId: roundState.frozenLeaderId.toString(),
      frozenMemberIds: roundState.frozenMemberIds.map((id) => id.toString()),
      round1Rank: roundState.round1Rank,
      headStartDistance: roundState.headStartDistance,
      earnedDistance: roundState.earnedDistance,
      totalDistance: roundState.totalDistance,
      challengeOpportunitiesUsed: roundState.challengeOpportunitiesUsed,
      sampleRunsUsed: roundState.sampleRunsUsed,
      finalSubmissionsUsed: roundState.finalSubmissionsUsed,
      rejectedFinalSubmissions: roundState.rejectedFinalSubmissions,
      activeChallengeAttemptId: roundState.activeChallengeAttemptId
        ? roundState.activeChallengeAttemptId.toString()
        : null,
      pendingSubmissionId: roundState.pendingSubmissionId
        ? roundState.pendingSubmissionId.toString()
        : null,
      stateVersion: roundState.stateVersion
    }
  };
}

/**
 * Reusable live gameplay admission guard for Phase 05+ execution and challenge routes.
 * Enforces reconciled LIVE status, strict pre-deadline timestamp, frozen eligible roster,
 * and existing TeamRoundState without returning 401 for ineligible participants.
 */
export async function verifyLiveCompetitionAdmission({
  user,
  competitionSlug = DEFAULT_COMPETITION_SLUG,
  nowFn = () => Date.now(),
  logger
}) {
  await reconcileCompetitionDeadline({ competitionSlug, nowFn, logger });
  const competition = await getActiveCompetition({ slug: competitionSlug });
  const nowMs = nowFn();

  if (
    competition.status === COMPETITION_STATUSES.LOBBY ||
    competition.status === COMPETITION_STATUSES.LOCKED
  ) {
    throw new AppError('Competition is not live yet', {
      statusCode: 409,
      code: 'COMPETITION_NOT_LIVE'
    });
  }

  if (
    competition.status === COMPETITION_STATUSES.SETTLING ||
    competition.status === COMPETITION_STATUSES.COMPLETED ||
    !competition.endsAt ||
    nowMs >= new Date(competition.endsAt).getTime()
  ) {
    throw new AppError('Competition deadline has been reached; new admissions are closed', {
      statusCode: 409,
      code: 'COMPETITION_DEADLINE_REACHED'
    });
  }

  const frozenEntry = await FrozenRosterEntry.findOne({
    competitionId: competition._id,
    frozenMemberIds: user._id
  }).lean();

  if (!frozenEntry) {
    const membership = await TeamMembership.findOne({
      competitionId: competition._id,
      userId: user._id
    }).lean();

    if (membership) {
      const team = await Team.findById(membership.teamId).select('isExcluded').lean();
      if (team?.isExcluded) {
        throw AppError.forbidden(
          'Your team has been excluded from this round',
          'TEAM_EXCLUDED'
        );
      }
    }

    throw AppError.forbidden(
      'You are not part of the frozen eligible roster for this competition',
      'TEAM_NOT_ELIGIBLE'
    );
  }

  const teamRoundState = await TeamRoundState.findOne({
    competitionId: competition._id,
    teamId: frozenEntry.teamId
  }).lean();

  if (!teamRoundState) {
    throw AppError.forbidden(
      'Team round state has not been initialized for your team',
      'TEAM_NOT_ELIGIBLE'
    );
  }

  return {
    competition,
    frozenEntry,
    teamRoundState,
    nowMs
  };
}
