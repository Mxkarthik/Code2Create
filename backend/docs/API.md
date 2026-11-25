# API Specification — Phases 01–04

All endpoints return JSON (except OAuth `302` redirects), set `Cache-Control: no-store` on dynamic state/auth endpoints, and include `X-Request-Id`. All state-changing mutations require `X-CSRF-Token` (`GET /api/auth/csrf`) and a trusted `Origin`/`Referer`.

---

## 1. Infrastructure & Auth Endpoints (Phases 01–03)

- `GET /api/health` (`200`), `GET /api/ready` (`200` / `503`)
- `GET /api/auth/google`, `GET /api/auth/google/callback`, `GET /api/auth/me`, `GET /api/auth/session`, `GET /api/auth/csrf`, `POST /api/auth/logout`

## 2. Participant Team Endpoints (Phase 03)

- `GET /api/teams/me`, `POST /api/teams`, `POST /api/teams/join`, `PATCH /api/teams/me/ready`, `POST /api/teams/me/leave`, `POST /api/teams/me/regenerate-code`, `POST /api/teams/me/transfer-leadership`, `DELETE /api/teams/me/members/:userId`, `DELETE /api/teams/me` *(All team mutations return `409 LOBBY_CLOSED` after roster lock).*

---

## 3. Participant Competition Endpoints (Phase 04)

Requires `requireAuth`, `requireActiveUser`, `requireParticipantAccess` (permits `PARTICIPANT` and `ADMIN`).

### `GET /api/competition/current`
Returns competition status, `durationSeconds`, `startedAt`, `endsAt`, `remainingSeconds`, `serverTime`, and caller's `membership` (`teamId`, `teamRole`, `isEligible`, `eligibilityReason`, `inFrozenRoster`).

### `GET /api/competition/state`
Returns `/api/competition/current` plus `teamRoundState` (`null` before lock or for unassigned/excluded users; own team's `round1Rank`, `headStartDistance`, `earnedDistance`, `totalDistance`, `challengeOpportunitiesUsed`, `sampleRunsUsed`, `finalSubmissionsUsed`, `rejectedFinalSubmissions`, `activeChallengeAttemptId`, `pendingSubmissionId`, `stateVersion` after lock). Never leaks other teams' rankings or states.

---

## 4. Administrative Competition & Lobby Endpoints (Phases 03–04)

Requires `requireAuth`, `requireActiveUser`, `requireAdmin` (mutations require `X-CSRF-Token` + trusted `Origin`).

### `GET /api/admin/lobby` & `GET /api/admin/teams`
Extended backward-compatibly with `round1Rank`, `round1MappingStatus`, `isExcluded`, `excludedAt`, `exclusionReason`, `isEligible`, `eligibilityIssues`, `proposedHeadStart`, `frozenHeadStartDistance`, `rankImportVersion`, `rankImportConfirmed`, `eligibleTeamCount`, `lockedAt`, `startedAt`, `endsAt`, `remainingSeconds`, `lifecycleVersion`.

### `GET /api/admin/competition`
Returns complete competition configuration, lifecycle status, versions, rank confirmation status, eligible/excluded counts, timestamps, and `remainingSeconds`.

### `PATCH /api/admin/competition/config` *(CSRF required, `LOBBY` only)*
- **Body** (allowlisted `.strict()`): `{ "durationSeconds"?: 10..14400, "maxHeadStart"?: 0..100, "qualificationLimit"?: 1..100 }`
- **Errors**: `400 VALIDATION_ERROR`, `409 CONFIGURATION_LOCKED`

### `POST /api/admin/teams/import-ranks` *(CSRF required, `LOBBY` only — complete replacement)*
- **Body**: `{ "rankedTeamCount": 50, "entries": [{ "teamId": "<id>", "rank": 1 }] }`
- **Success**: `200 OK` with `rankImportVersion`, `rosterVersion`, `summary` (`mappedCount`, `unmappedCount`, `excludedCount`), `mapped`, `unmapped`, `excluded`. Invalidates prior confirmation.
- **Errors**: `400 ROUND1_RANK_INVALID` / `ROUND1_RANK_DUPLICATE`, `404 TEAM_NOT_FOUND`, `409 LOBBY_CLOSED`.

### `POST /api/admin/teams/confirm-ranks` *(CSRF required, `LOBBY` only)*
- **Body**: `{ "rankImportVersion": 1 }`
- **Errors**: `409 ROSTER_VERSION_CONFLICT`, `409 ROUND1_RANK_UNCONFIRMED`, `409 ROUND1_MAPPING_STALE`, `409 LOBBY_CLOSED`.

### `POST /api/admin/teams/:teamId/exclude` & `POST /api/admin/teams/:teamId/include` *(CSRF required, `LOBBY` only)*
- **Exclude Body**: `{ "reason": "Team incomplete or not qualified for Round 2" }` (3–300 chars)
- **Errors**: `400 VALIDATION_ERROR`, `404 TEAM_NOT_FOUND`, `409 TEAM_STATE_CONFLICT`, `409 LOBBY_CLOSED`.

### `GET /api/admin/competition/roster-preview`
Returns `status`, `rosterVersion`, `rankImportVersion`, `rankImportConfirmed`, `activeTeamCount`, `readyTeamCount`, `incompleteTeamCount`, `unreadyTeamCount`, `excludedTeamCount`, `unmappedTeamCount`, `eligibleTeamCount`, `proposedHeadStarts`, `blockingIssues`, `canLock`, `serverTime`.

### `POST /api/admin/competition/lock` *(CSRF required, `LOBBY` only)*
- **Body**: `{ "expectedRosterVersion": 15, "expectedRankImportVersion": 2 }`
- **Success**: `200 OK` transitions `LOBBY -> LOCKED`, freezes `FrozenRosterEntry` & `TeamRoundState` once per eligible team.
- **Errors**: `409 ROSTER_VERSION_CONFLICT`, `409 ROUND1_RANK_UNCONFIRMED`, `409 ROSTER_EMPTY`, `409 ROSTER_NOT_READY`, `409 INVALID_COMPETITION_STATE`.

### `POST /api/admin/competition/start` *(CSRF required, `LOCKED` only)*
- **Success**: `200 OK` transitions `LOCKED -> LIVE` with authoritative `startedAt`, `endsAt`, `durationSeconds`, `remainingSeconds`, `serverTime`, `eligibleTeamCount`, `lifecycleVersion`.
- **Errors**: `409 INVALID_COMPETITION_STATE`, `409 COMPETITION_ALREADY_STARTED`.

---

## 5. Error Codes (Phase 04 Additions)

`COMPETITION_NOT_FOUND`, `COMPETITION_NOT_INITIALIZED`, `INVALID_COMPETITION_STATE`, `LOBBY_CLOSED`, `ROSTER_VERSION_CONFLICT`, `ROSTER_NOT_READY`, `ROSTER_EMPTY`, `ROUND1_RANK_INVALID`, `ROUND1_RANK_DUPLICATE`, `ROUND1_RANK_UNCONFIRMED`, `ROUND1_MAPPING_STALE`, `TEAM_NOT_ELIGIBLE`, `TEAM_EXCLUDED`, `COMPETITION_ALREADY_STARTED`, `COMPETITION_NOT_LIVE`, `COMPETITION_DEADLINE_REACHED`, `CONFIGURATION_LOCKED`.
