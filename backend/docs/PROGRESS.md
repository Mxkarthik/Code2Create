# Project Progress — CODE 2 CREATE (Round 2: CODE RUSH)

## Phase Overview

| Phase | Scope | Status |
| :--- | :--- | :--- |
| **Phase 01** | Modular Monolithic Backend Foundation | **Completed** |
| **Phase 02** | Google OAuth, Persistent Sessions & Role-Based Authorization | **Completed** |
| **Phase 02.1** | Clean and Minimal Backend Terminal Logging | **Completed** |
| **Phase 03** | Team Formation, Invitation Codes, Readiness & Roster Lock | Pending |
| **Phase 04** | Competition Lifecycle, Round 1 Head Start & Problem Pool | Pending |
| **Phase 05** | Judge0 Integration, Persistent Execution Queue, Drafts & Scoring | Pending |
| **Phase 06** | Real-Time Socket.IO Updates & Leaderboard Broadcasts | Pending |

---

## Phase 02 Implementation Summary

### Pending Phase 01 Verification Completed

- Verified `MONGODB_TEST_URI` points to `code2create_test` and differs from the application database (`test`).
- Executed the previously skipped isolated collection write/cleanup test against `code2create_test`.
- Verified real MongoDB multi-document transaction **commit** and **rollback** on `code2create_test`.
- Reviewed the Windows Cloudflare WARP `c-ares` DNS fallback: made `MONGODB_DNS_SERVERS` explicitly configurable and `MONGODB_DNS_FALLBACK` disabled by default in `production` (enabled by default in `development`/`test` for local connectivity).

### Implemented Phase 02 Capabilities

- **User Model & Atomic Identity (`src/modules/users/`)**: Mongoose `User` schema (`googleSub` unique/immutable, normalized `email`, `name`, `avatar`, `role` defaulting to `PARTICIPANT`, `isActive`, `lastLoginAt`, timestamps) with atomic `findOneAndUpdate` upsert that prevents concurrent duplicates, preserves existing `ADMIN` roles and `isActive` across relogins, rejects unverified Google emails, and never merges distinct `googleSub`s by email.
- **Google OAuth 2.0 + PKCE (`src/config/passport.js`, `src/modules/auth/`)**:
  - Passport `passport-google-oauth20` requesting `['openid', 'email', 'profile']` with `pkce: true` (`S256`).
  - Session-bound, 256-bit cryptographically random state with 10-minute expiration (`OAUTH_STATE_TTL_MS`) and atomic MongoDB `OAuthTransaction` consumption preventing concurrent callback replay.
  - Open-redirect prevention via predefined portal keys (`participant`, `admin`, and `development`-only `dev`).
- **Persistent MongoDB Sessions (`src/config/session.js`, `src/middleware/authenticate.js`)**:
  - `express-session` + `connect-mongo` (`sessions` collection), `HttpOnly`, `SameSite=Lax`, `Path=/`, host-only, `Secure` in `production`, `saveUninitialized: false`, `resave: false`, `rolling: false`.
  - Session ID rotated via `req.session.regenerate()` on login.
  - Application-enforced 8-hour absolute lifetime (`28800000` ms) and 2-hour inactivity timeout (`7200000` ms) with throttled rolling activity capped at `absoluteExpiresAt`.
  - Returns HTTP `503` without destroying sessions during MongoDB/session-store outages.
- **Authorization, CSRF & Rate Limiting (`src/middleware/`)**:
  - `requireAuth`, `requireActiveUser`, `requireAdmin`, `requireParticipantAccess` reading live `role` and `isActive` from MongoDB so manual promotions/demotions take effect without relogin.
  - Session-bound CSRF token (`GET /api/auth/csrf`, `X-CSRF-Token`) + `Origin`/`Referer`/`Sec-Fetch-Site` checks.
  - Campus-NAT-aware rate limiters (`300` / `15m`) on OAuth and auth mutations; passive session restoration (`/api/auth/me`, `/api/auth/session`) left unrestricted.
- **Endpoints Implemented**: `GET /api/auth/google`, `GET /api/auth/google/callback`, `GET /api/auth/me`, `GET /api/auth/session`, `GET /api/auth/csrf`, `POST /api/auth/logout`.

---

## Phase 02.1 Logging Refinement Summary

- **Configurable Formats (`src/config/env.js`, `src/utils/logger.js`)**: Added `LOG_FORMAT` (`minimal` default in development/test, `debug`, `json` default in production) while preserving `LOG_LEVEL` and Pino secret redaction across all modes.
- **Human-Readable Terminal & Startup Banner (`src/utils/logger.js`, `src/server.js`)**: Implemented `[SUCCESS]`, `[INFO]`, `[WARN]`, and `[ERROR]` ANSI severity badges respecting `NO_COLOR`, plus a compact startup summary reflecting actual runtime port and verified initialization status.
- **Noise Suppression & Error Deduplication (`src/utils/logger.js`, `src/middleware/errorHandler.js`)**: Suppressed routine HTTP completions, health/ready probes, `/api/auth/me` & `/api/auth/session` traffic, `404`s, expected OAuth redirects, and client cancellations in `minimal` mode, and prevented duplicate logging between `errorHandler` and `pino-http`.
- **Clean MongoDB & DNS Fallback Logs (`src/config/database.js`)**: Eliminated misleading pre-connect disconnect/error events during recoverable Windows local DNS SRV fallback (emitting at most one concise `[WARN]`).
- **Tests**: `npm --prefix backend test` passed **8/8 test files, 50/50 tests** (including new tests for `minimal`/`debug`/`json` redaction, `NO_COLOR`, dynamic port banner, HTTP suppression, error deduplication, and DNS fallback distinction).

---

## Automated Test Results

- **Command**: `npm --prefix backend test` (`vitest run`)
- **Result**: **8 test files passed (8)**; **50 passed, 0 failed, 0 skipped (50 total)**
  - **Unit / Mocked Tests**:
    - `tests/unit/env.test.js`: 6 passed
    - `tests/unit/logger.test.js`: 7 passed
    - `tests/unit/database.test.js`: 3 passed
    - `tests/unit/app.test.js`: 11 passed
    - `tests/unit/oauth.test.js`: 6 passed (mocked Google HTTPS exchange; real Passport + PKCE + state + rate limiter + log redaction)
  - **Real MongoDB Integration Tests (`code2create_test`)**:
    - `tests/integration/database.test.js`: 5 passed (isolation verification, `/api/ready` 200→503, write/cleanup, transaction commit, transaction rollback)
    - `tests/integration/user.test.js`: 7 passed (default `PARTICIPANT`, repeated login ID preservation, concurrent upsert deduplication, multiple `ADMIN` preservation, disabled account preservation, unverified email rejection, no email-based identity merge, client role escalation rejection)
    - `tests/integration/auth.test.js`: 5 passed (persistent `MongoStore` across app reconstruction, SID rotation, cookie security flags, dual session expiration & capped rolling activity, live MongoDB promotion/demotion RBAC, CSRF & cross-session/origin rejection, independent logout, `503` outage handling)

---

## Manual Verification Status

- Live server startup, `/api/health`, `/api/ready`, unauthenticated `/api/auth/session` & `/api/auth/me`, `/api/auth/google?portal=dev` redirect to `https://accounts.google.com`, and graceful `SIGINT` shutdown were verified locally.
- Full interactive browser login through Google's live consent screen (`http://localhost:5000/api/auth/google?portal=dev`) requires interactive user sign-in and remains pending manual verification.

---

## Next-Phase Dependencies (Phase 03 Readiness)

Phase 02 is complete and ready for **Phase 03 (Team Formation, Invitation Codes, Readiness & Roster Lock)**:

- Implement `src/modules/teams` with self-service team creation (`TEAM_LEADER`), invitation code joining (`TEAM_MEMBER`), 50-team cap, persistent readiness, and admin roster lock.
- Implement `requireTeamMembership` and `requireRoundEligibility` middleware in `src/middleware/authorize.js` without modifying global `PARTICIPANT`/`ADMIN` role semantics.
