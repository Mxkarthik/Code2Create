# Requirements — CODE 2 CREATE (Round 2: CODE RUSH)

This document records the finalized architectural, competition, access-control, and resilience requirements governing all phases of the Round 2 backend.

---

## 1. Platform & Scale Requirements

- **Platform**: CODE 2 CREATE college technical competition platform — Round 2 (**CODE RUSH**).
- **Concurrency Target**: Approximately **100 concurrent users** across up to **50 competing teams**.
- **Execution Isolation**: A self-hosted **Judge0** server on Google Cloud executes untrusted participant code. Participant code must **never** be executed inside Node.js.

---

## 2. Authentication & Access Control Requirements (Implemented in Phase 02)

- **OAuth Flow**: Google OAuth 2.0 Authorization Code Flow + PKCE (`S256`), scopes `openid`, `email`, `profile`; development callback URL `http://localhost:5000/api/auth/google/callback`.
- **Session Persistence**: Persistent MongoDB-backed sessions via `express-session` and `connect-mongo` (no JWT authentication).
  - 8-hour absolute session lifetime (`28800000` ms); 2-hour inactivity timeout (`7200000` ms).
  - Rolling activity extends inactivity expiration up to—but never beyond—the absolute lifetime.
  - Session ID regenerated on login; server-side session destroyed on logout.
  - Database/session-store outages return HTTP `503` (never `401`, never destroying legitimate sessions).
- **Role Assignment**:
  - Newly created accounts default to `PARTICIPANT`.
  - `ADMIN` privileges are granted manually in MongoDB (`db.users.updateOne(...)`).
  - Multiple `ADMIN` accounts are supported.
  - Subsequent Google logins never overwrite existing `role` or `isActive`.
  - `ADMIN_EMAILS` environment configuration is prohibited.
  - No admin-assignment API or client-supplied role assignment is permitted.
- **Portal Authorization**:
  - `ADMIN` users can access both Admin and Participant portals.
  - Non-admin (`PARTICIPANT`) users can access only the Participant portal.
  - Role changes in MongoDB take effect on subsequent protected requests without Google reauthentication.
- **Team vs. Global Roles**:
  - Global account privileges (`PARTICIPANT` / `ADMIN`) are independent of future team roles (`TEAM_LEADER` / `TEAM_MEMBER`).
  - Team creation will assign `TEAM_LEADER`; joining via invitation code will assign `TEAM_MEMBER`.

---

## 3. Team Formation Requirements (Implemented in Phase 03)

- Self-service team creation (`TEAM_LEADER`) with 8-character cryptographically random invitation codes from an unambiguous uppercase alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, excluding `O`, `0`, `I`, `1`).
- Configurable team size (initially **2 participants**), capped at **50 active teams** (`maxTeams=50`), enforced transactionally.
- Normalized lowercase/whitespace join-code matching; regeneration immediately invalidates prior codes; codes are hidden from non-leader/non-admin participants and never logged.
- Each team member independently confirms readiness (`PATCH /api/teams/me/ready`); a leader cannot mark a teammate ready.
- Team status transitions: `FORMING` (< `teamSize`) → `FORMED` (full, not all ready) → `READY` (full and all ready). Membership composition changes reset readiness for remaining members.
- Readiness and membership persist in MongoDB across reloads, disconnects, and server restarts; readiness does not claim online presence.
- All team formation mutations are permitted only while `Competition.status === 'LOBBY'` and participate in an atomic `Competition` write guard ready for Phase 04 roster locking.
- Global `PARTICIPANT` / `ADMIN` account roles remain strictly independent of `TEAM_LEADER` / `TEAM_MEMBER` team roles.
- Administrative lobby APIs (`GET /api/admin/lobby`, `GET /api/admin/teams`) require `ADMIN` privileges and expose sanitized lobby/team/member readiness state without session IDs or OAuth credentials.

---

## 4. CRITICAL GAMEPLAY RECOVERY REQUIREMENTS

> Authentication and competition state are independent. Google login, logout, session restoration, browser refresh, browser restart, backend restart, or temporary network disconnection must **NEVER** reset or delete authoritative gameplay records.

### Future Frontend Requirements
- Restore valid authentication through `GET /api/auth/me`; never force Google login on every refresh.
- Distinguish unauthenticated states (`401`) from connectivity failures (`503` / network timeout); never treat HTTP `503` or network timeouts as logout.
- Preserve locally typed source code during authentication recovery using **IndexedDB**.
- Namespace local drafts by `(authenticatedUserId, teamId, competitionId, challengeId, language)`.
- Never expose another account's private drafts.
- Synchronize code drafts to MongoDB using revision-based conflict protection.
- Restore existing team membership, readiness, active challenges, remaining challenge opportunities, submission attempts, scores, and server-authoritative competition timestamps.
- Retrieve existing pending submissions instead of automatically resubmitting.

### Future Backend Requirements
- Persist team membership, readiness (independent of online status), challenge attempts, pending execution records, scoring records, and personal code drafts in MongoDB.
- Preserve game state across authentication changes and server restarts.

---

## 5. Competition Lifecycle, Timer & Settlement Rules (Phase 04 Implemented; Problem/Execution Pending Phase 05)

- **Duration & Timer (Implemented in Phase 04)**: 30-minute active coding (`durationSeconds = 1800`, configurable in `LOBBY`, short durations supported for isolated tests) plus ~5 minutes outside the coding timer for briefing/settlement. Authoritative `startedAt` and `endsAt` persist in MongoDB; `remainingSeconds` is derived from `endsAt - serverTime` (never decremented in DB, never extended by refresh/restart).
- **Lifecycle (Implemented in Phase 04)**: `LOBBY -> LOCKED -> LIVE -> SETTLING -> COMPLETED`. Round 1 rank import uses complete replacement semantics with explicit admin confirmation; membership changes invalidate affected rank mappings; exclusions preserve team memberships while blocking gameplay admission; roster locking freezes eligible teams and initializes `TeamRoundState` once; expired `LIVE` competitions reconcile atomically into `SETTLING`.
- **Problem Pool (Pending Phase 05)**: 18 planned problems — 6 Easy (**10** distance units), 6 Medium (**25** distance units), 6 Hard (**45** distance units).
- **Team Limits (Counters Initialized in Phase 04; Enforcement Pending Phase 05)**: 6 challenge opportunities/team (`maxChallengeOpportunities=6`); 1 active challenge/team; 1 pending execution/team; 4 sample runs/challenge (16/team); 3 final attempts/challenge (18/team).
- **Head Start (Implemented in Phase 04)**: Round 1 head start (`maxHeadStart=20`) computed from `round1Rank` and `round1RankedTeamCount` and frozen at roster lock.
- **Languages & Execution (Pending Phase 05)**: C, C++, Python, Java; persistent MongoDB execution queue; idempotent submission admission (atomic deadline check inside admission tx); transactional score settlement; infrastructure failures never penalize participants.
- **Advancement (Pending Phase 05/06)**: Top **10** teams (`qualificationLimit=10`) advance to Round 3; finalization occurs only after queue settlement.

---

## 6. Security Requirements

- Session-bound CSRF tokens + trusted `Origin`/`Referer` verification on cookie-authenticated mutations.
- Campus-NAT-aware authentication rate limiting without throttling normal session restoration.
- Never expose hidden test cases, Judge0 credentials, session IDs, OAuth codes/tokens, or DB secrets.
- Never trust client-supplied scores, roles, resource limits, or team identifiers without server-side authorization.
- Admin privileges do not bypass gameplay consistency constraints.
- Production deployment must use shared-site or same-origin reverse-proxy topology for reliable `SameSite=Lax` + `Secure` cookies.
