# Project Progress — CODE 2 CREATE (Round 2: CODE RUSH)

## Phase Overview

| Phase | Scope | Status |
| :--- | :--- | :--- |
| **Phase 01** | Modular Monolithic Backend Foundation | **Completed** |
| **Phase 02** | Google OAuth, Persistent Sessions & Role-Based Authorization | **Completed** |
| **Phase 02.1** | Clean and Minimal Backend Terminal Logging | **Completed** |
| **Phase 03** | Team Formation, Invitation Codes, Membership & Readiness | **Completed** |
| **Phase 04** | Competition Lifecycle, Roster Locking, Round 1 Head Start & Timer | **Completed** |
| **Phase 05** | Problem Bank, Sample & Hidden Test Cases, and Language Configuration | **Completed** |
| **Phase 06** | Judge0 Integration, Execution Adapter & Reference Verification Foundation | **Completed** |
| **Phase 07** | Persistent Submission Queue, Fair Execution Scheduling & Recovery | **Completed** |
| **Phase 08** | Challenge Selection, Attempt Accounting, Score Ledger & Drafts | Pending |
| **Phase 09** | Real-Time Socket.IO Updates & Leaderboard Broadcasts | Pending |

---

## Phase 07 Implementation Summary

- **Persistent Queue & Worker Schemas (`src/modules/submissions/`, `src/modules/execution/`)**:
  - Added `Submission` (`submissions` collection) with `sourceCode` (`select: false`), `sourceCodeHash`, canonical `requestFingerprint`, scoped unique `(competitionId, teamId, submittedByUserId, idempotencyKey)`, lifecycle (`QUEUED`, `PROCESSING`, `AWAITING_RECONCILIATION`, `EXECUTION_COMPLETED`, `SYSTEM_FAILED`), independent `verdict`, and `settlementStatus` (`NOT_READY`, `PENDING_SETTLEMENT`, `SETTLED`) with zero TTL auto-deletion.
  - Added `ExecutionJob` (`execution_jobs` collection) with unique `{ submissionId, testCaseOrder }` and `{ submissionId, testCaseId }` constraints, immutable snapshots (`testCaseInput`, `expectedOutput`, `judge0Token`, `actualOutputSnapshot`, `stderrSnapshot`, all `select: false`), `dispatchAttemptId`, `leaseOwner`, `leaseExpiresAt`, `fencingVersion`, and `nextPollAt`.
  - Added MongoDB-backed `ExecutionCapacity` (`execution_capacities`) enforcing `JUDGE0_MAX_IN_FLIGHT=8` persistently across restarts.
- **Durable Admission, Idempotency & Phase 08 Settlement Contracts (`submission.service.js`)**:
  - `admitSubmission()` runs atomically inside `runInTransaction`, checking `Competition.status === 'LIVE'`, `admittedAt < competition.endsAt`, `FrozenRosterEntry` membership, scoped idempotency, queue backpressure (`EXECUTION_MAX_QUEUED_SUBMISSIONS`), immutable `Problem` version, and conditional `TeamRoundState.pendingSubmissionId` reservation.
  - `settleSubmissionInternal()` transitions `PENDING_SETTLEMENT -> SETTLED` once and clears `TeamRoundState.pendingSubmissionId` only when it matches `submissionId`.
  - `serializeSubmissionForParticipant()` and `serializeSubmissionForAdminQueue()` strictly exclude `sourceCode`, `judge0Token`, and hidden test data.
- **Fair Scheduling, Leases, Fencing & Recovery (`executionScheduler.js`, `executionQueue.service.js`, `executionRecovery.service.js`, `execution.worker.js`, `server.js`)**:
  - Fair round-robin per-team scheduling prioritizes oldest-recently-served idle teams before idle parallel bursts.
  - Worker enforces `{ leaseOwner, fencingVersion }` fencing; expired `DISPATCHING` leases without a token and ambiguous `POST` failures transition to `ADMISSION_UNCERTAIN` (`AWAITING_RECONCILIATION`) retaining remote capacity until conservative timeout (`EXECUTION_UNCERTAIN_RECONCILE_MS`).
  - Expired `SUBMITTED`/`POLLING` leases resume polling the persisted `judge0Token`; `SUBMIT` early rejection marks remaining `QUEUED` jobs `SKIPPED`; `server.js` stops the execution worker gracefully before closing MongoDB.

---

## Automated Test Results

- **Commands**:
  - `npm --prefix backend run test:unit` (`vitest run tests/unit`) -> **11 test files passed (11)**; **67 passed, 0 failed, 0 skipped** (`12.51s`)
  - `npm --prefix backend run test:integration -- tests/integration/submissions.test.js` (`vitest run tests/integration ...`) -> **7 test files passed (7)**; **37 passed, 0 failed, 0 skipped** (`243.86s`)
  - **Combined Total**: **18 test files passed (18)**; **104 passed, 0 failed, 0 skipped (104 total)**
  - `npm --prefix backend run queue:verify` -> **Exit code 0** *(live Judge0 CE 1.13.1 queue smoke test across Python `RUN`, Java `SUBMIT` 3/3 `ACCEPTED`, C++ `WRONG_ANSWER` with early `SKIPPED`, C `COMPILATION_ERROR`, persisted token worker-restart recovery, peak capacity `3/8`, total `22287ms`)*
- **Unit / Mocked Tests (11 files, 67 tests)**:
  - `tests/unit/env.test.js`: 7 passed *(includes Phase 06/07 env defaults & lease bounds)*
  - `tests/unit/logger.test.js`: 7 passed
  - `tests/unit/database.test.js`: 3 passed
  - `tests/unit/app.test.js`: 11 passed
  - `tests/unit/oauth.test.js`: 6 passed
  - `tests/unit/team.test.js`: 6 passed
  - `tests/unit/competition.test.js`: 5 passed
  - `tests/unit/problems.test.js`: 5 passed
  - `tests/unit/judge0.test.js`: 10 passed
  - `tests/unit/execution.test.js`: 4 passed
  - `tests/unit/executionQueue.test.js`: 3 passed *(submission admission schema/fingerprinting, SUBMIT/admin confidentiality, RUN sample vs hidden separation)*
- **Real MongoDB Integration Tests (`code2create_test` — 7 files, 37 tests)**:
  - `tests/integration/database.test.js`: 5 passed
  - `tests/integration/user.test.js`: 7 passed
  - `tests/integration/auth.test.js`: 5 passed
  - `tests/integration/team.test.js`: 8 passed
  - `tests/integration/competition.test.js`: 4 passed
  - `tests/integration/problems.test.js`: 4 passed
  - `tests/integration/submissions.test.js`: 4 passed *(atomic admission/idempotency/teammate races/rollback/deadline/SETTLING survival, global capacity & fair round-robin scheduling, crash before/after token recovery/fencing/idempotent aggregation, WA early skip/infra failure classification/confidentiality/graceful worker shutdown/settlement contract)*

---

## Next-Phase Dependencies (Phase 08 Readiness)

Phase 07 is complete and ready for **Phase 08 (Challenge Selection, Attempt Accounting, Score Ledger & Drafts)**:

- Connect participant `RUN`/`SUBMIT` routes after `ChallengeAttempt` validation to `admitSubmission()` and settle terminal submissions inside transactions via `settleSubmissionInternal({ competitionId, teamId, submissionId, applyStateUpdateFn })`.
- Deduct attempts and award distance points only inside `applyStateUpdateFn` when `submission.status === 'EXECUTION_COMPLETED'`, releasing `SYSTEM_FAILED` reservations without consuming attempts.
