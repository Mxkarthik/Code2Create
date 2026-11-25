# Architecture — CODE 2 CREATE (Round 2: CODE RUSH)

## 1. Architectural Style

The backend is a **Modular Monolithic** Node.js (ES Modules) + Express 5 application backed by MongoDB Atlas (Mongoose), sized for **~100 concurrent users** and **up to 50 competing teams**.

## 2. Request Pipeline (Phases 01–04)

```text
HTTP Request
  │
  ▼
requestIdMiddleware          Assigns/validates X-Request-Id
  │
  ▼
createHttpLogger (pino-http) Redacts secrets/cookies/joinCodes; minimal noise suppression
  │
  ▼
helmet() + cors(allowlist)   Security headers; explicit frontend allowlist + credentials: true
  │
  ▼
express.json({ limit })      100kb JSON guard
  │
  ├──► GET /api/health       Process liveness (200) — independent of DB & session middleware
  ├──► GET /api/ready        MongoDB readiness (200 / 503) — independent of session middleware
  │
  ▼
/api/auth/*                  sessionMiddleware (MongoStore) -> passport.initialize()
/api/teams/*                 sessionMiddleware -> requireAuth -> requireActiveUser -> requireParticipantAccess (+ CSRF)
/api/competition/*           sessionMiddleware -> requireAuth -> requireActiveUser -> requireParticipantAccess
/api/admin/*                 sessionMiddleware -> requireAuth -> requireActiveUser -> requireAdmin (+ CSRF on mutations)
  │
  ▼
notFoundMiddleware -> createErrorHandler (deduplicated logging, sanitized 500s, 503 on DB outages)
```

## 3. Competition Lifecycle & Roster Architecture (Phase 04)

### Lifecycle State Machine

```text
LOBBY ──(admin lock)──► LOCKED ──(admin start)──► LIVE ──(endsAt reached)──► SETTLING ──(Phase 05/06)──► COMPLETED
```

- **LOBBY**: Team creation/joining/readiness/exclusions/rank import/confirmation/config updates permitted.
- **LOCKED**: Roster, rankings, head starts, and memberships frozen; `FrozenRosterEntry` and `TeamRoundState` initialized once per eligible team.
- **LIVE**: Authoritative `startedAt` and `endsAt` (`startedAt + durationSeconds`) persisted atomically; all eligible teams share one deadline.
- **SETTLING**: Automatic transition when `now >= endsAt` (reconciled on startup, state reads, gameplay guard, and a 15s periodic timer). Rejects new gameplay admissions while preserving `TeamRoundState` and timestamps for future queue settlement.
- **COMPLETED**: Terminal state reserved for Phase 05/06 finalization.

### Models & Indexes

1. **`Competition` (`competitions`)**: Extended with `durationSeconds` (1800), `maxChallengeOpportunities` (6), `maxHeadStart` (20), `qualificationLimit` (10), `round1RankedTeamCount`, `rankImportVersion`, `rankImportConfirmedVersion`, `rankImportConfirmedAt`, `rankImportConfirmedBy`, `lockedAt`, `lockedBy`, `lockedRosterVersion`, `eligibleTeamCount`, `startedAt`, `startedBy`, `endsAt`, `settlingAt`, `completedAt`, `lifecycleVersion`. Indexes: `{ slug: 1 }` (`unique`), `{ status: 1, endsAt: 1 }`.
2. **`Team` (`teams`)**: Preserves Phase 03 `TEAM_STATUSES` and partial unique indexes untouched; adds `round1Rank`, `round1RankedTeamCount`, `round1RankImportVersion`, `round1MappingStatus` (`UNMAPPED` | `MAPPED` | `STALE`), `isExcluded`, `excludedAt`, `excludedBy`, `exclusionReason`, `frozenHeadStartDistance`.
3. **`FrozenRosterEntry` (`frozen_roster_entries`)**: Immutable snapshot at lock time (`competitionId`, `teamId`, `teamName`, `frozenLeaderId`, `frozenMemberIds`, `round1Rank`, `round1RankedTeamCount`, `headStartDistance`, `rosterVersion`, `lockedAt`). Unique `{ competitionId: 1, teamId: 1 }`; index `{ competitionId: 1, frozenMemberIds: 1 }`.
4. **`TeamRoundState` (`team_round_states`)**: Persistent gameplay state (`competitionId`, `teamId`, `frozenLeaderId`, `frozenMemberIds`, `round1Rank`, `headStartDistance`, `earnedDistance: 0`, `totalDistance: headStartDistance`, `challengeOpportunitiesUsed: 0`, `sampleRunsUsed: 0`, `finalSubmissionsUsed: 0`, `rejectedFinalSubmissions: 0`, `activeChallengeAttemptId: null`, `pendingSubmissionId: null`, `stateVersion: 1`). Unique `{ competitionId: 1, teamId: 1 }`.

### Head-Start Formula & Eligibility

- `calculateHeadStart(rank, rankedTeamCount, maxHeadStart = 20)`:
  - If `rankedTeamCount === 1` and `rank === 1`, returns `maxHeadStart`.
  - Otherwise `Math.round((maxHeadStart * (rankedTeamCount - rank)) / (rankedTeamCount - 1))`.
- Eligible for lock only when active, not excluded, full (`memberCount === teamSize`), all members `isReady === true` and `isActive === true`, consistent `TEAM_LEADER`, valid mapped `round1Rank`, confirmed rank import, and at least one eligible team.
- Any membership composition change (`join`, `leave`, `removeMember`) on a ranked team sets `round1MappingStatus: 'STALE'` and clears prior rank confirmation.

### Authoritative Timer, Clock Synchronization & Future Gameplay Admission

- Production backend hosts must run synchronized clocks (NTP/Chrony) so `startedAt`, `endsAt`, and `serverTime` remain consistent across restarts or horizontal proxies.
- `remainingSeconds = endsAt > now ? Math.ceil((endsAt - now) / 1000) : 0`.
- `requireLiveCompetitionAdmission` verifies active user, reconciled `LIVE` status, `now < endsAt`, `FrozenRosterEntry`, and `TeamRoundState`.
- **Phase 05 Note**: Problem bank (`src/modules/problems`) and submission queue (`src/modules/submissions`) will use `requireLiveCompetitionAdmission` as the preliminary HTTP guard and re-verify `status === 'LIVE'` and `now < endsAt` atomically inside the submission admission MongoDB transaction.
