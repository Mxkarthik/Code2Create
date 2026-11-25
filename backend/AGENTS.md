# AGENTS.md — Mandatory Engineering, Architecture & Security Rules

This file defines mandatory constraints for all coding agents working on the **CODE 2 CREATE — Round 2 (CODE RUSH)** backend. Every future phase must adhere strictly to these rules.

---

## 1. Architecture & Code Organization

- **Architecture**: Modular monolithic Node.js + Express backend using ES Modules (`"type": "module"`).
- **Scale Target**: ~100 concurrent users and up to 50 competing teams.
- **Separation of App & Server**: Keep Express app construction (`src/app.js`) decoupled from HTTP server binding (`src/server.js`) so Supertest tests can execute without binding ports.
- **Module Boundaries**:
  - `src/config/`: Environment validation (`env.js`), database lifecycle (`database.js`), Passport OAuth setup (`passport.js`), and persistent session config (`session.js`).
  - `src/middleware/`: Cross-cutting HTTP middleware (`requestId.js`, `notFound.js`, `errorHandler.js`, `authenticate.js`, `authorize.js`, `csrf.js`, `rateLimiter.js`).
  - `src/modules/users`: User schema & atomic Google identity upsert (`user.model.js`, `user.service.js`).
  - `src/modules/auth`: Google OAuth routes, controller, state store, and portal validation (`auth.routes.js`, `auth.controller.js`, `auth.service.js`, `auth.validation.js`).
  - `src/modules/competition`: Competition lifecycle, Round 1 rank mapping/confirmation, head-start calculation, roster locking, authoritative timer & settlement transition (`competition.model.js`, `frozenRoster.model.js`, `teamRoundState.model.js`, `headStart.js`, `competition.service.js`, `competition.controller.js`, `adminCompetition.controller.js`, `competition.routes.js`, `competition.validation.js`).
  - `src/modules/teams`: Self-service team formation, invitation codes, membership, readiness & admin lobby read APIs.
  - `src/modules/problems`, `submissions`, `drafts`: Pending future phases — do not prematurely implement.
  - `src/integrations/`, `src/workers/`, `src/sockets/`: Reserved for Judge0 client, persistent execution queue workers, and Socket.IO in their respective phases.

---

## 2. Authentication, Persistent Sessions & Role Rules (Mandatory)

- **Google OAuth Authorization Code Flow + PKCE (S256)** via `passport` and `passport-google-oauth20` (`openid`, `email`, `profile` scopes only). Callback URL: `http://localhost:5000/api/auth/google/callback` in development.
- **No JWT Authentication**: Never implement JWT-based auth, even if `JWT_SECRET` / `JWT_EXPIRES_IN` appear in `.env`. Use persistent **MongoDB-backed `express-session` (`connect-mongo`)**.
- **OAuth State Security**: Cryptographically random, session-bound, 10-minute expiration (`OAUTH_STATE_TTL_MS`), atomic one-time consumption preventing concurrent callback replay, open-redirect prevention via predefined portal keys.
- **Default Account Role**: Every new user defaults to `PARTICIPANT` (`$setOnInsert` only).
- **Admin Privileges**:
  - `ADMIN` privileges are assigned manually in MongoDB (`db.users.updateOne({ _id: ObjectId("USER_ID") }, { $set: { role: "ADMIN" } })`).
  - Multiple `ADMIN` accounts must be supported.
  - **Subsequent Google logins must NEVER reset an existing `ADMIN` role to `PARTICIPANT`**, and must never overwrite `isActive`.
  - **`ADMIN_EMAILS` environment configuration is strictly prohibited.**
  - Never implement an API endpoint to assign administrators or accept role assignments from client requests.
- **Dynamic Authorization**:
  - Always retrieve current `role` and `isActive` from MongoDB (`requireAuth`), never from cached session fields or client input.
  - Manual promotion or demotion in MongoDB must take effect on the very next protected request without requiring Google reauthentication.
- **Role Independence & Portal Access**:
  - Global account roles (`PARTICIPANT`, `ADMIN`) remain independent of future team membership roles (`TEAM_LEADER`, `TEAM_MEMBER`).
  - `ADMIN` accounts can participate in teams without losing administrator privileges.
  - Every active authenticated user can access the Participant portal (`PARTICIPANT` and `ADMIN`). Only `ADMIN` can access the Admin portal.
- **Session Expiration & Resilience**:
  - Enforce 8-hour absolute lifetime (`SESSION_MAX_AGE_MS=28800000`) and 2-hour inactivity timeout (`SESSION_IDLE_TIMEOUT_MS=7200000`) in application logic (never rely solely on MongoDB TTL).
  - Activity may extend inactivity expiration up to—but never beyond—the absolute expiration.
  - Rotate session identifier on login (`req.session.regenerate`). Store minimal `auth` metadata (`userId`, timestamps), never full user documents.
  - On MongoDB or session-store outage, return controlled HTTP `503` — **never** return HTTP `401` and **never** destroy legitimate sessions due to temporary infrastructure errors.

---

## 3. Team Formation & Transaction Rules (Implemented in Phase 03)

- **Self-Service Teams**: Up to 50 active teams (`maxTeams=50`), configurable `teamSize=2`. Creator becomes `TEAM_LEADER`; invitee becomes `TEAM_MEMBER`.
- **Global vs. Team Role Independence**: Never store `teamRole` inside `User`; never overwrite `User.role` (`PARTICIPANT` / `ADMIN`) during team operations. Unassigned users have `teamId=null` and `teamRole=null`.
- **Invitation Codes**: 8-character cryptographically random codes (`crypto.randomInt`) from unambiguous uppercase alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, excluding `O`, `0`, `I`, `1`). Normalize input uppercase; invalidate on regeneration or dissolution; **never log invitation codes**.
- **Readiness Invariants**: `PATCH /api/teams/me/ready` updates only the authenticated caller's own readiness in MongoDB. Team status transitions `FORMING` (< `teamSize`) -> `FORMED` (full, not all ready) -> `READY` (full and all ready). Any membership composition change resets readiness for remaining members. Readiness is independent of online presence.
- **Transactional Concurrency & Roster Guard**:
  - All multi-document team/membership mutations must execute inside MongoDB transactions (`runInTransaction`), sequentially (`await`, **never `Promise.all` inside a single transaction**), and participate in `acquireLobbyMutationGuard` (atomic write lock + `rosterVersion` increment on `Competition` where `status === 'LOBBY'`).
  - Rely on MongoDB unique/partial indexes (`{ competitionId, userId }`, `{ teamId, teamRole }` for `TEAM_LEADER`, `{ competitionId, normalizedName }`, `{ competitionId, joinCode }`) — never process-local JS locks.
  - Log committed domain events only **after** transaction commit.
- **Future Phase 04/05 Integration**:
  - Competition lifecycle (`LOBBY -> LOCKED -> LIVE -> SETTLING -> COMPLETED`) is strictly controlled through centralized services; backwards transitions and duplicate starts are prohibited.
  - Round 1 rank mappings are replacement-based, require explicit admin confirmation, and invalidate when affected team membership changes.
  - `FrozenRosterEntry` and `TeamRoundState` are created atomically once at roster lock; never reset `TeamRoundState` on startup or auth recovery.
  - Authoritative timer relies exclusively on persisted `startedAt` and `endsAt` (synchronized server clocks required in production); `requireLiveCompetitionAdmission` rejects requests at or after `endsAt` with `COMPETITION_DEADLINE_REACHED`.
  - Phase 05 submission queues must re-verify deadline and pending execution slot **atomically inside the submission admission transaction** (a preliminary middleware check alone is insufficient).
  - Never prematurely finalize `SETTLING -> COMPLETED` until Phase 05/06 persistent execution queue and score settlement are implemented.

---

## 4. CRITICAL GAMEPLAY RECOVERY REQUIREMENTS

> **CRITICAL WARNING**: Authentication, Google login, logout, session restoration, browser refresh, browser restart, backend restart, and temporary internet disconnection must **NEVER** reset or delete authoritative game state.

### Future Frontend Requirements
- Restore valid authentication through `GET /api/auth/me` (never force Google login on every refresh).
- Distinguish unauthenticated states (`401`) from connectivity failures (`503` / network timeout); **never treat HTTP `503` or timeouts as logout**.
- Preserve locally typed source code during authentication recovery using **IndexedDB**, namespaced by `(userId, teamId, competitionId, challengeId, language)`.
- Never expose another account's private drafts.
- Synchronize code drafts to MongoDB with revision-based conflict protection.
- Restore team membership, readiness, active challenges, remaining challenge opportunities, submission attempts, scores, and server-authoritative competition timestamps.
- Retrieve existing/pending submissions after refresh instead of automatically resubmitting.

### Future Backend Requirements
- Persist team membership, readiness (independent of online status), challenge attempts, pending execution records, scoring records, and personal code drafts in MongoDB.
- Preserve all game state across authentication changes and server restarts.
- **Never execute participant code directly inside Node.js.** All execution must go through the isolated Judge0 server via the persistent MongoDB queue.

---

## 5. Competition, Security & Operational Hygiene

- 30-minute active competition; 18 planned problems (6E=10, 6M=25, 6H=45); 6 opportunities/team, 1 active challenge/team, 1 pending execution/team; 4 sample runs/challenge (16/team); 3 final attempts/challenge (18/team); Round 1 head start 0–20; C/C++/Python/Java; top 10 teams advance to Round 3.
- Persistent MongoDB execution queue with idempotent submission admission and transactional score settlement (infrastructure failures never penalize participants).
- **CSRF & CORS**: Session-bound CSRF token (`X-CSRF-Token`) + trusted `Origin`/`Referer` verification on cookie-authenticated mutations; explicit CORS allowlist with `credentials: true` (never `*`).
- **Production Cookie Compatibility**: Same-site cookies (`SameSite=Lax`, `HttpOnly`, `Secure` in production) require a shared parent site or same-origin reverse proxy in production; never weaken cookie flags to work around cross-site browser blocks.
- **DNS & TLS Hygiene**: Custom DNS fallback (`MONGODB_DNS_FALLBACK`) is disabled by default in production; never disable MongoDB TLS certificate verification.
- **Secret Redaction & Testing Safety**: Never log or expose secrets, cookies, `Set-Cookie`, OAuth codes/tokens, CSRF tokens, or DB URIs. Never run destructive tests against the application database (`code2create_test` only via `MONGODB_TEST_URI`; never use `dropDatabase` for routine cleanup). Never commit/push without explicit permission.

---

## 7. Backend Logging Contract (`LOG_FORMAT` & Future Modules)

- **Logging Modes**:
  - `minimal` (default in `development` / `test`): Concise human-readable terminal output using `[SUCCESS]` (green), `[INFO]` (cyan), `[WARN]` (yellow), `[ERROR]` (red), respecting `NO_COLOR`. Suppresses routine `2xx`/`3xx`/health/readiness/session-restoration/`404`/client-cancellation noise; never prints raw JSON in normal dev mode.
  - `debug`: Detailed human-readable diagnostics including HTTP request summaries (with query strings, bodies, and secrets redacted).
  - `json` (default in `production`): Structured Pino JSON logging with full redaction and probe noise suppression.
- **No Duplicate Error Logging**: `errorHandler` sets `res.locals.errorLoggedByHandler = true` so `pino-http` never logs the same error twice.
- **Future Module Logging Rules (Phases 03–06)**:
  - **Team creation & membership changes**: Log concise `INFO`/`SUCCESS` events with `teamId` and `userId` only (no invitation codes or personal PII); never log routine team-list polling.
  - **Competition lifecycle**: Log state transitions (`ROSTER_LOCKED`, `COMPETITION_STARTED`, `COMPETITION_ENDED`) once at `SUCCESS`/`INFO`.
  - **Judge0 availability**: Log connectivity state transitions (unavailable/recovered) cleanly; do not log every successful execution poll.
  - **Submission queue & execution infrastructure failures**: Log actionable `WARN`/`ERROR` entries with `submissionId`, `teamId`, and sanitized error codes — never source code or hidden test cases.
  - **Score settlement errors**: Always log `ERROR` with `teamId`, `challengeId`, and transaction rollback reason.
  - **Server shutdown**: Log signal receipt (`INFO`), MongoDB close (`INFO`), and completion (`SUCCESS`).
  - **Suppressed high-frequency traffic**: Never emit terminal logs for code autosave requests, Socket.IO heartbeats, or execution status polling.
