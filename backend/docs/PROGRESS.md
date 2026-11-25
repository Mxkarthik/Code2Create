# Project Progress — CODE 2 CREATE (Round 2: CODE RUSH)

## Phase Overview

| Phase | Scope | Status |
| :--- | :--- | :--- |
| **Phase 01** | Modular Monolithic Backend Foundation | **Completed** |
| **Phase 02** | Google OAuth, Persistent Sessions & Role-Based Authorization | **Completed** |
| **Phase 02.1** | Clean and Minimal Backend Terminal Logging | **Completed** |
| **Phase 03** | Team Formation, Invitation Codes, Membership & Readiness | **Completed** |
| **Phase 04** | Competition Lifecycle, Roster Locking, Round 1 Head Start & Timer | **Completed** |
| **Phase 05** | Problem Bank, Judge0 Integration, Persistent Execution Queue, Drafts & Scoring | Pending |
| **Phase 06** | Real-Time Socket.IO Updates & Leaderboard Broadcasts | Pending |

---

## Phase 04 Implementation Summary

- **Competition Lifecycle & Schemas (`src/modules/competition/`)**:
  - Extended `Competition` (`durationSeconds`, `maxChallengeOpportunities`, `maxHeadStart`, `qualificationLimit`, `round1RankedTeamCount`, `rankImportVersion`, `rankImportConfirmedVersion`, `rankImportConfirmedAt`, `rankImportConfirmedBy`, `lockedAt`, `lockedBy`, `lockedRosterVersion`, `eligibleTeamCount`, `startedAt`, `startedBy`, `endsAt`, `settlingAt`, `completedAt`, `lifecycleVersion`) and `Team` (`round1Rank`, `round1RankedTeamCount`, `round1RankImportVersion`, `round1MappingStatus`, `isExcluded`, `excludedAt`, `excludedBy`, `exclusionReason`, `frozenHeadStartDistance`).
  - Added `FrozenRosterEntry` and `TeamRoundState` with unique `{ competitionId, teamId }` indexes.
- **Rank Import, Confirmation, Head Starts & Exclusions**:
  - Pure `calculateHeadStart()` utility (`Math.round(maxHeadStart * (rankedTeamCount - rank) / (rankedTeamCount - 1))`, single-team special case).
  - Transactional complete-replacement `importRound1Ranks`, version-checked `confirmRound1Ranks`, `setTeamExclusion` (`exclude` / `include`), and automatic rank mapping invalidation (`STALE`) on team membership changes in `team.service.js`.
- **Roster Locking, Competition Start, Timer & Deadline Reconciliation**:
  - `getRosterPreview` identifying blocking issues (`INCOMPLETE_TEAM`, `UNREADY_TEAM`, `DISABLED_ACCOUNT_MEMBER`, `INVALID_LEADER`, `UNMAPPED_TEAM`, `ROUND1_MAPPING_STALE`, `ROUND1_RANK_UNCONFIRMED`, `ROSTER_EMPTY`).
  - Atomic `lockCompetitionRoster` (`LOBBY -> LOCKED`) checking `expectedRosterVersion` & `expectedRankImportVersion`, creating `FrozenRosterEntry` + `TeamRoundState` once per eligible team.
  - Atomic `startCompetition` (`LOCKED -> LIVE`) establishing authoritative `startedAt` and `endsAt`.
  - Atomic `reconcileCompetitionDeadline` (`LIVE -> SETTLING`) run on startup, periodic interval (15s, cleaned up on shutdown), state reads, and `requireLiveCompetitionAdmission`.
- **Endpoints Added**:
  - Participant: `GET /api/competition/current`, `GET /api/competition/state`
  - Admin: `GET /api/admin/competition`, `PATCH /api/admin/competition/config`, `POST /api/admin/teams/import-ranks`, `POST /api/admin/teams/confirm-ranks`, `POST /api/admin/teams/:teamId/exclude`, `POST /api/admin/teams/:teamId/include`, `GET /api/admin/competition/roster-preview`, `POST /api/admin/competition/lock`, `POST /api/admin/competition/start` (plus extended `/api/admin/lobby` and `/api/admin/teams`).

---

## Automated Test Results

- **Command**: `npm --prefix backend test` (`vitest run`)
- **Result**: **12 test files passed (12)**; **73 passed, 0 failed, 0 skipped (73 total)**
  - **Unit / Mocked Tests**:
    - `tests/unit/env.test.js`: 6 passed
    - `tests/unit/logger.test.js`: 7 passed
    - `tests/unit/database.test.js`: 3 passed
    - `tests/unit/app.test.js`: 11 passed
    - `tests/unit/oauth.test.js`: 6 passed
    - `tests/unit/team.test.js`: 6 passed
    - `tests/unit/competition.test.js`: 5 passed *(head-start formula, single-team special case, timer rounding, strict config/rank validation)*
  - **Real MongoDB Integration Tests (`code2create_test`)**:
    - `tests/integration/database.test.js`: 5 passed
    - `tests/integration/user.test.js`: 7 passed
    - `tests/integration/auth.test.js`: 5 passed
    - `tests/integration/team.test.js`: 8 passed
    - `tests/integration/competition.test.js`: 4 passed *(rank import/replacement/confirmation/rollback/stale-on-leave, eligibility/exclusions/disabled accounts/locking/rollback/concurrent lock/post-lock immutability, concurrent lock vs readiness race, start/concurrent starts/authoritative timer/gameplay guard/deadline `LIVE->SETTLING`/restart recovery)*

---

## Next-Phase Dependencies (Phase 05 Readiness)

Phase 04 is complete and ready for **Phase 05 (Problem Bank, Judge0 Execution Queue, Code Drafts & Scoring)**:

- Reuse `requireLiveCompetitionAdmission` as the preliminary HTTP guard and enforce `status === 'LIVE'` + `now < endsAt` + pending slot checks atomically inside the submission admission transaction.
- Implement final `SETTLING -> COMPLETED` finalization only after persistent execution queue settlement and scoring verification.
