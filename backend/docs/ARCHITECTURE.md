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
/api/problems/*              sessionMiddleware -> requireAuth -> requireActiveUser -> requireParticipantAccess -> requireLiveCompetitionAdmission
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
- **Phase 05 Problem Bank Integration**: Problem bank (`src/modules/problems`) exposes `GET /api/problems` behind `requireLiveCompetitionAdmission` using explicit summary/detail serializers that strictly omit hidden test cases, internal solutions, and administrative authoring fields.

---

## Phase 05 Problem Bank & Execution Policy Architecture

1. **`Problem` (`problems`)**: Competition-scoped problem definitions (`competitionId`, `title`, `slug`, `difficulty`, `statement`, `inputFormat`, `outputFormat`, `constraints`, `allowedLanguages`, `executionLimits`, `status`, `displayOrder`, `version`, `createdBy`, `updatedBy`, `publishedAt`, `archivedAt`), with server-derived `rewardDistance` (`10`/`25`/`45`) attached in serializers from `DIFFICULTY_CONFIG`. Unique `{ competitionId: 1, slug: 1 }` and indexed on `{ competitionId: 1, status: 1, difficulty: 1, displayOrder: 1 }`.
2. **`TestCase` (`test_cases`)**: Competition- and problem-scoped sample/hidden test cases (`competitionId`, `problemId`, `type` (`SAMPLE` | `HIDDEN`), `input`, `expectedOutput`, `explanation`, `displayOrder`). Supports empty string `""` inputs/outputs, unique `{ problemId: 1, type: 1, displayOrder: 1 }`, and fast lookup `{ competitionId: 1, problemId: 1, type: 1, displayOrder: 1 }`.
3. **Language & Execution Policy (`src/modules/problems/language.config.js`)**:
   - Canonical languages & Judge0 CE IDs: `C` (`50`), `CPP` (`54`), `PYTHON` (`71`), `JAVA` (`62`, `Main` entry class).
   - Difficulty rewards: `EASY` (`10`), `MEDIUM` (`25`), `HARD` (`45`).
   - Language-aware defaults and server-side bounds (`C/CPP/PYTHON`: `2.0s` CPU / `5.0s` wall / `128000 KB` memory; `JAVA`: `3.0s` CPU / `8.0s` wall / `256000 KB` memory; network disabled, `32 KB` max source, `256 KB` max captured output, single run per Judge0 job).
4. **Output Comparison (`src/modules/problems/outputComparison.js`)**: Line-ending normalization (`\r\n`/`\r` → `\n`), per-line trailing horizontal whitespace trimming, trailing blank-line stripping, and internal blank-line/token preservation.
5. **Security & Lifecycle Boundaries**:
   - All admin problem mutations and status transitions (`DRAFT <-> PUBLISHED`, `ARCHIVED`) acquire an atomic `Competition` lock (`status === 'LOBBY'`) via `acquireLobbyMutationGuard`.
   - `PUBLISHED` and `ARCHIVED` problems are immutable (`PUBLISHED` must be explicitly unpublished while still in `LOBBY` before editing); problem bank readiness requires 6 Easy, 6 Medium, and 6 Hard `PUBLISHED` problems.
   - `getInternalExecutionProblem(competitionId, problemId)` provides unredacted `HIDDEN` and `SAMPLE` test cases strictly to future internal execution services (never wired to HTTP participant handlers).

---

## Phase 06 Judge0 Integration & Multi-Case Evaluation Architecture

1. **Judge0 HTTP Client (`src/integrations/judge0/judge0.client.js`)**:
   - Uses native `fetch` + `AbortSignal.timeout`, attaches `X-Auth-Token`, sets `redirect: 'manual'` (rejects HTTP 3xx with `JUDGE0_REDIRECT_REJECTED`), and streams bodies within `JUDGE0_MAX_HTTP_RESPONSE_BYTES` (`2 MB`).
   - Targets `POST /submissions?base64_encoded=true&wait=false` and `GET /submissions/:token?base64_encoded=true&fields=...` (never exposing tokens or raw payloads).
   - **Retry & Admission Uncertainty Policy**: Safe `GET` calls retry with bounded exponential backoff + jitter (`429/502/503/504`/network/timeout). `POST /submissions` **never** automatically retries; timeouts, mid-stream resets, 5xx ambiguity, or missing tokens return `JUDGE0_SUBMISSION_ADMISSION_UNCERTAIN` (`admissionUncertain: true`) for Phase 07 queue reconciliation.
2. **Service & Trusted Request Construction (`src/integrations/judge0/judge0.service.js`)**:
   - Encodes `source_code` (max `32768` UTF-8 bytes) and `stdin` as Base64, enforces `enable_network: false`, `number_of_runs: 1`, server resource limits, `max_file_size: 1024` KB, and rejects forbidden client overrides (`compiler_options`, `callback_url`, `expected_output`, etc.).
   - Deployed Judge0 CE `1.13.1` notes: `enable_wait_result=false`, `cpu_extra_time=1s`, `max_queue_size=100`, `max_file_size=1024 KB`, `enable_network=false`. Node enforces `262144`-byte (`256 KB`) decoded stdout caps independently.
   - Exposes discrete async primitives: `createSubmission()`, `getSubmissionResult()`, bounded `waitForResult()`, and `checkAvailability()`.
3. **Result Mapping (`src/integrations/judge0/judge0.mapper.js`)**:
   - Maps CE statuses `1..14` (`EXECUTED` for status `3`, `OUTPUT_LIMIT_EXCEEDED` for `SIGXFSZ` or truncated stdout `> 262144` bytes, `INFRASTRUCTURE_ERROR` for `13`/`14`/corrupted Base64, `UNKNOWN_STATUS` flagged `isInfrastructureError: true`).
4. **Evaluation & Reference Verification (`src/modules/execution/`)**:
   - `evaluateProblemSubmission()` supports `RUN` (`SAMPLE` cases only), `SUBMIT` (`HIDDEN` cases only, strips hidden I/O/stdout/stderr/tokens), and `REFERENCE_VERIFICATION` (`SAMPLE` + `HIDDEN`), running case `0` first on early-stop to avoid wasted jobs on compilation failure, then bounded concurrent execution (`<= JUDGE0_MAX_IN_FLIGHT`).
   - **Workload Amplification**: Four Judge0 workers execute individual test-case jobs (`1` submission with `8` hidden cases = up to `8` jobs). Future Phase 07 queues must enforce per-team fair scheduling and bounded pending queues; problem authors may group logical cases into `T`-format inputs rather than backend auto-concatenation.
   - `verifyReferenceSolution()` executes outside MongoDB transactions and persists `Problem.verification` (`VERIFIED`) atomically only when all cases pass on the exact `expectedProblemVersion`; any problem/test edit resets `verification.status` to `UNVERIFIED`.
5. **Connectivity Topology**: Local development tunnels over GCP IAP (`http://127.0.0.1:2358`); production requires private VPC/backend-to-Judge0 networking independent of local workstations.

---

## Phase 07 Persistent Execution Queue, Scheduling & Recovery Architecture

1. **Durable Queue Schemas (`Submission`, `ExecutionJob`, `ExecutionCapacity`)**:
   - `Submission` (`submissions`): Persists `sourceCode` (`select: false`), `sourceCodeHash`, canonical `requestFingerprint`, scoped unique `{ competitionId, teamId, submittedByUserId, idempotencyKey }`, queue `status` (`QUEUED`, `PROCESSING`, `AWAITING_RECONCILIATION`, `EXECUTION_COMPLETED`, `SYSTEM_FAILED`), independent `verdict`, `settlementStatus` (`NOT_READY`, `PENDING_SETTLEMENT`, `SETTLED`), `admittedAt`, and `competitionEndsAt` with zero TTL auto-deletion.
   - `ExecutionJob` (`execution_jobs`): One record per test case per submission (`unique { submissionId, testCaseOrder }` and `{ submissionId, testCaseId }`), snapshotting `testCaseInput` (`select: false`), `expectedOutput` (`select: false`), `judge0Token` (`select: false`), `dispatchAttemptId`, `leaseOwner`, `leaseExpiresAt`, `fencingVersion`, `nextPollAt`, and bounded sample snapshots (`actualOutputSnapshot`, `stderrSnapshot`, strictly null for `HIDDEN`).
   - `ExecutionCapacity` (`execution_capacities`): MongoDB-backed global capacity set (`activeJobIds` capped at `JUDGE0_MAX_IN_FLIGHT=8`), distinguishing locally queued submissions/cases from remote occupied Judge0 jobs across restarts.
2. **Atomic Admission Transaction & Deadline Boundary (`src/modules/submissions/submission.service.js`)**:
   - Inside `runInTransaction`, verifies `Competition.status === 'LIVE'` and `admittedAt < competition.endsAt`, `FrozenRosterEntry` membership, scoped idempotency BEFORE reservation lookup (safe retry when `pendingSubmissionId` is already held), queue backpressure (`< EXECUTION_MAX_QUEUED_SUBMISSIONS`), immutable `Problem` version, and atomic `TeamRoundState.pendingSubmissionId: null -> submissionId`.
   - Boundary semantics: `admittedAt` is captured inside the transaction from trusted server clock; work is acknowledged (`202` in Phase 08) only after durable commit, and `LIVE -> SETTLING` deadline reconciliation preserves all admitted submissions cleanly.
3. **Fair Scheduling (`src/modules/execution/executionScheduler.js`)**:
   - Queries at most `<= 100` active submissions (max 50 teams) ordered by `lastDispatchedAt ASC, admittedAt ASC`. Pass 1 allocates 1 Judge0 slot to each idle team before Pass 2 grants bounded idle bursts (max 4, only for `RUN` or after case #1 passes), preventing worker monopolization or starvation while strictly bounding total outstanding remote jobs to `JUDGE0_MAX_IN_FLIGHT`.
4. **Leases, Fencing, Uncertain Admission & Crash Recovery (`executionQueue.service.js`, `executionRecovery.service.js`, `execution.worker.js`)**:
   - Claiming transitions `QUEUED -> DISPATCHING` (`fencingVersion++`, `dispatchAttemptId`, `ExecutionCapacity` reserved) strictly **before** external `POST /submissions`.
   - All worker updates verify `{ leaseOwner, fencingVersion }`. Expired `DISPATCHING` leases without a token and ambiguous `POST` errors enter `ADMISSION_UNCERTAIN` (`AWAITING_RECONCILIATION`) retaining remote capacity until conservative `EXECUTION_UNCERTAIN_RECONCILE_MS` reconciliation frees the slot as `SYSTEM_FAILED` — never issuing blind duplicate `POST`s.
   - Expired `SUBMITTED`/`POLLING` leases clear `leaseOwner` cleanly to resume polling the existing persisted `judge0Token`.
   - Early rejection in `SUBMIT` mode marks unsent `QUEUED` jobs `SKIPPED`; `reconcileSubmissionProgress()` deterministically re-counts terminal jobs (precedence: `COMPILATION_ERROR` > `RUNTIME_ERROR` > `TIME_LIMIT_EXCEEDED` > `OUTPUT_LIMIT_EXCEEDED` > `WRONG_ANSWER` / `SYSTEM_ERROR`) idempotently.
   - `server.js` runs `executionWorker.stop()` before `disconnectDatabase()` on `SIGINT`/`SIGTERM`, preserving recoverable jobs without cancelling running remote Judge0 executions.

---

## Pending Modules (Future Phases)

- **Challenge Selection, Attempt Accounting & Scoring (`Phase 08`)**: Challenge attempt validation, participant `RUN`/`SUBMIT` routes consuming `admitSubmission()` / `settleSubmissionInternal()`, attempt counters, and distance ledger.
- **Real-Time & Drafts (`Phase 09`)**: Code draft persistence and Socket.IO broadcasts.
