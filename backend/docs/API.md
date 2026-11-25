# API Specification — Phases 01–07

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

## 5. Participant Problem Pool Endpoint (Phase 05)

Requires `requireAuth`, `requireActiveUser`, `requireParticipantAccess`, and `requireLiveCompetitionAdmission` (`LIVE` pre-deadline + frozen eligible roster).

### `GET /api/problems`
Returns selection metadata ONLY (`id`, `title`, `slug`, `difficulty`, `rewardDistance`, `estimatedSolveTime`, `allowedLanguages`, `displayOrder`) for `PUBLISHED` problems. Never exposes `statement`, `SAMPLE`/`HIDDEN` test cases, `DRAFT`, or `ARCHIVED` problems.
*(Full detail endpoint `GET /api/problems/:problemId` is deferred to Phase 08 when `ChallengeAttempt` exists.)*

---

## 6. Administrative Problem & Test Case Endpoints (Phase 05)

Requires `requireAuth`, `requireActiveUser`, `requireAdmin` (all mutations require `X-CSRF-Token`, trusted `Origin`, and `Competition.status === 'LOBBY'`).

- `GET /api/admin/problems/readiness` — Counts (`totalDraft`, `totalPublished`, `totalArchived`, `publishedByDifficulty`), `structurallyReady`, `structuralIssues`, `targetPerDifficulty: 6`, `executionVerificationPending: true`
- `GET /api/admin/problems?difficulty=EASY&status=DRAFT&page=1&limit=20` — Filtered, paginated admin problem list
- `POST /api/admin/problems` *(CSRF)* — Create `DRAFT` problem (`title`, `slug?`, `difficulty`, `statement`, `inputFormat`, `outputFormat`, `constraints`, `allowedLanguages?`, `executionLimits?`, `displayOrder?`)
- `GET /api/admin/problems/:problemId` — Admin full detail including `SAMPLE` & `HIDDEN` test cases and `publicationCheck`
- `PATCH /api/admin/problems/:problemId` *(CSRF, `DRAFT` only)* — Requires `expectedVersion`; increments `version`
- `DELETE /api/admin/problems/:problemId` *(CSRF, `DRAFT` only)* — Transactionally deletes draft problem and its test cases
- `POST /api/admin/problems/:problemId/publish` *(CSRF, `DRAFT` only)* — Validates structure + `>=1 SAMPLE` + `>=1 HIDDEN`
- `POST /api/admin/problems/:problemId/unpublish` *(CSRF, `PUBLISHED` only, `LOBBY` only)*
- `POST /api/admin/problems/:problemId/archive` *(CSRF)* — Archives `DRAFT`/`PUBLISHED` problem
- `GET /api/admin/problems/:problemId/test-cases` — Ordered `SAMPLE` and `HIDDEN` cases
- `POST /api/admin/problems/:problemId/test-cases` *(CSRF, `DRAFT` only)* — Adds test case (`type`, `input`, `expectedOutput`, `explanation?`, `displayOrder`, `expectedProblemVersion?`)
- `PATCH /api/admin/problems/:problemId/test-cases/:testCaseId` *(CSRF, `DRAFT` only)* — Updates test case scoped to `:problemId`
- `DELETE /api/admin/problems/:problemId/test-cases/:testCaseId` *(CSRF, `DRAFT` only)* — Deletes test case scoped to `:problemId`

---

## 7. Error Codes (Phase 04, 05 & 06 Additions)

`COMPETITION_NOT_FOUND`, `COMPETITION_NOT_INITIALIZED`, `INVALID_COMPETITION_STATE`, `LOBBY_CLOSED`, `ROSTER_VERSION_CONFLICT`, `ROSTER_NOT_READY`, `ROSTER_EMPTY`, `ROUND1_RANK_INVALID`, `ROUND1_RANK_DUPLICATE`, `ROUND1_RANK_UNCONFIRMED`, `ROUND1_MAPPING_STALE`, `TEAM_NOT_ELIGIBLE`, `TEAM_EXCLUDED`, `COMPETITION_ALREADY_STARTED`, `COMPETITION_NOT_LIVE`, `COMPETITION_DEADLINE_REACHED`, `CONFIGURATION_LOCKED`, `PROBLEM_NOT_FOUND`, `PROBLEM_SLUG_TAKEN`, `PROBLEM_VERSION_CONFLICT`, `PROBLEM_IMMUTABLE`, `PROBLEM_PUBLICATION_INVALID`, `INVALID_PROBLEM_STATE`, `TEST_CASE_NOT_FOUND`, `TEST_CASE_ORDER_CONFLICT`, `UNSUPPORTED_LANGUAGE`, `INVALID_DIFFICULTY`, `JUDGE0_CONFIG_ERROR`, `JUDGE0_AUTH_FAILED`, `JUDGE0_UNREACHABLE`, `JUDGE0_QUEUE_SATURATED`, `JUDGE0_INVALID_REQUEST`, `JUDGE0_INVALID_RESPONSE`, `JUDGE0_REDIRECT_REJECTED`, `JUDGE0_TIMEOUT`, `JUDGE0_SUBMISSION_ADMISSION_UNCERTAIN`, `JUDGE0_POLL_TIMEOUT`, `JUDGE0_INTERNAL_ERROR`, `IDEMPOTENCY_KEY_CONFLICT`, `EXECUTION_ALREADY_PENDING`, `EXECUTION_QUEUE_FULL`, `SUBMISSION_NOT_FOUND`, `SUBMISSION_ALREADY_SETTLED`, `SUBMISSION_NOT_READY_FOR_SETTLEMENT`, `TEAM_RESERVATION_MISMATCH`.

---

## 8. Internal Execution & Persistent Queue Contracts (Phases 06 & 07)

> No public or participant code execution routes are mounted prior to Phase 08 `ChallengeAttempt` authorization.

- **Persistent Admission & Settlement (`src/modules/submissions/submission.service.js`)**:
  - `admitSubmission({ user, teamId, challengeAttemptId, problemId, problemVersion, mode, language, sourceCode, idempotencyKey, ... }) -> { submission, deduplicated }` *(Atomic transaction reserving `TeamRoundState.pendingSubmissionId`, enforcing `LIVE` deadline & idempotency; returns participant-safe view without `sourceCode`, tokens, or hidden I/O)*
  - `getSubmissionForTeam({ competitionId, teamId, submissionId }) -> ParticipantSafeSubmissionView`
  - `settleSubmissionInternal({ competitionId, teamId, submissionId, applyStateUpdateFn }) -> { submission, teamRoundState }` *(Phase 08 settlement contract: atomically transitions `PENDING_SETTLEMENT -> SETTLED`, clears `TeamRoundState.pendingSubmissionId` ONLY when it matches `submissionId`, and applies Phase 08 attempt deduction / distance ledger updates; infrastructure `SYSTEM_FAILED` must release attempt reservation without penalty)*
- **Internal Queue Recovery & Monitoring (`src/modules/execution/`)**:
  - `recoverExecutionQueue()`, `reconcileSubmissionProgress()`, `getQueueMonitoringStats()`
  - `serializeSubmissionForAdminQueue(submission)` *(Omits `sourceCode` and `judge0Token`)*
- **Recommended Admin Bulk Problem Import Schema (Planned Future Admin Endpoint)**:
  ```json
  {
    "problems": [
      {
        "title": "Two Sum Distance",
        "slug": "two-sum-distance",
        "difficulty": "EASY",
        "statement": "Markdown problem statement...",
        "inputFormat": "...",
        "outputFormat": "...",
        "constraints": "...",
        "allowedLanguages": ["C", "CPP", "PYTHON", "JAVA"],
        "displayOrder": 1,
        "sampleTestCases": [
          { "input": "4 9\n2 7 11 15\n", "expectedOutput": "0 1", "explanation": "..." }
        ],
        "hiddenTestCases": [
          { "input": "3 6\n3 2 4\n", "expectedOutput": "1 2" }
        ],
        "referenceSolution": {
          "language": "PYTHON",
          "sourceCode": "..."
        }
      }
    ]
  }
  ```
