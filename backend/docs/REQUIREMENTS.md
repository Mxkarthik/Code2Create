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

## 3. Team Formation Requirements (Pending Phase 03)

- Self-service team creation with secure randomly generated invitation codes.
- Configurable team size (initially **2 participants**), capped at **50 teams**.
- Each team member independently confirms readiness; membership and readiness persist in MongoDB.
- Disconnecting does not automatically reset readiness.
- Administrators lock the roster before starting the competition; membership changes are prohibited after roster lock.
- Admin privileges must never be overwritten by team roles.

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

## 5. Competition Rules & Settlement Requirements (Pending Phases 04–06)

- **Duration**: 30-minute active competition.
- **Problem Pool**: 18 planned problems — 6 Easy (**10** distance units), 6 Medium (**25** distance units), 6 Hard (**45** distance units).
- **Team Limits**: 6 challenge opportunities/team; 1 active challenge/team; 1 pending execution/team; 4 sample runs/challenge (16/team); 3 final attempts/challenge (18/team).
- **Head Start**: Round 1 head start between **0 and 20**; Round 1 qualification mapping finalized prior to roster admission.
- **Languages**: C, C++, Python, Java.
- **Execution & Scoring**: Persistent MongoDB execution queue; idempotent submission admission; transactional score settlement; infrastructure failures never penalize participants.
- **Advancement**: Top **10** teams advance to Round 3.

---

## 6. Security Requirements

- Session-bound CSRF tokens + trusted `Origin`/`Referer` verification on cookie-authenticated mutations.
- Campus-NAT-aware authentication rate limiting without throttling normal session restoration.
- Never expose hidden test cases, Judge0 credentials, session IDs, OAuth codes/tokens, or DB secrets.
- Never trust client-supplied scores, roles, resource limits, or team identifiers without server-side authorization.
- Admin privileges do not bypass gameplay consistency constraints.
- Production deployment must use shared-site or same-origin reverse-proxy topology for reliable `SameSite=Lax` + `Secure` cookies.
