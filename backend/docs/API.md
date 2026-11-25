# API Specification — Phases 01 & 02

All endpoints return JSON (except OAuth `302` redirects) and include an `X-Request-Id` response header for correlation.

> **Scope Notice**: Health/readiness (Phase 01) and Google OAuth, persistent session inspection, CSRF token issuance, and logout (Phase 02) are implemented. Team, competition, problem, submission, draft, and WebSocket APIs are pending future phases.

---

## 1. Infrastructure Endpoints

### `GET /api/health`

Reports process liveness independently of database or session-store availability.

- **Authentication**: None
- **Response (`200 OK`)**:

```json
{
  "success": true,
  "status": "ok",
  "service": "code2create-backend",
  "environment": "development",
  "timestamp": "2026-11-25T10:45:00.000Z",
  "uptimeSeconds": 12.34,
  "requestId": "9f2f7b1a-7c3d-4a56-9a3f-1b7c4e9f2d01"
}
```

### `GET /api/ready`

Reports whether MongoDB is connected and ready.

- **Authentication**: None
- **Ready (`200 OK`)** / **Unavailable (`503 Service Unavailable`)**:

```json
{
  "success": true,
  "status": "ready",
  "checks": {
    "database": {
      "status": "up"
    }
  },
  "timestamp": "2026-11-25T10:45:00.000Z",
  "requestId": "9f2f7b1a-7c3d-4a56-9a3f-1b7c4e9f2d01"
}
```

---

## 2. Authentication & Session Endpoints

### `GET /api/auth/google`

Initiates Google OAuth 2.0 Authorization Code Flow with PKCE (`S256`) and a session-bound 10-minute state token.

- **Query Parameters**:
  - `portal` (optional, default `participant`): Allowed values are `participant`, `admin`, or `dev` (`dev` is permitted **only** when `NODE_ENV=development`).
- **Rate Limit**: `300` requests / `15m` per IP.
- **Response**: `302 Found` redirect to `https://accounts.google.com/o/oauth2/v2/auth` (or `400 INVALID_PORTAL_DESTINATION`).

### `GET /api/auth/google/callback`

Validates and atomically consumes the one-time OAuth state, exchanges the authorization code, verifies Google identity & `email_verified`, atomically upserts the `User` record, rotates the session ID, persists the session in MongoDB, and redirects to the validated portal destination.

- **Rate Limit**: `300` requests / `15m` per IP.
- **Success Response**: `302 Found` to `PARTICIPANT_FRONTEND_URL`, `ADMIN_FRONTEND_URL`, or `/api/auth/me` (when `portal=dev` in `development`), setting `HttpOnly`, `SameSite=Lax` cookie `c2c.sid` (`Secure` in `production`).
- **Failure Responses**:
  - `302` to trusted frontend `?authError=OAUTH_CONSENT_CANCELLED` (or `401` JSON for `dev` / stateless) on consent cancellation
  - `400 MISSING_OAUTH_STATE`
  - `403 INVALID_OAUTH_STATE` / `EXPIRED_OAUTH_STATE` / `REPLAYED_OAUTH_STATE` / `ACCOUNT_DISABLED`
  - `401 UNVERIFIED_GOOGLE_EMAIL` / `OAUTH_EXCHANGE_FAILED`

### `GET /api/auth/me`

Returns the authenticated user's live profile and portal permissions directly from MongoDB.

- **Authentication**: Required (`requireAuth`, `requireActiveUser`, `requireParticipantAccess`)
- **Headers**: `Cache-Control: no-store`
- **Response (`200 OK`)**:

```json
{
  "success": true,
  "user": {
    "id": "6744...",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "avatar": "https://lh3.googleusercontent.com/...",
    "role": "PARTICIPANT",
    "permissions": {
      "participantPortal": true,
      "adminPortal": false
    }
  },
  "requestId": "..."
}
```

### `GET /api/auth/session`

Reports current authentication status and dual expiration timestamps without exposing the session ID.

- **Authentication**: Passive (`resolveSessionStatus` — returns `200` with `authenticated: false` when unauthenticated or expired, `503` on MongoDB outage).
- **Headers**: `Cache-Control: no-store`
- **Authenticated Response (`200 OK`)**:

```json
{
  "success": true,
  "authenticated": true,
  "absoluteExpiresAt": "2026-11-25T18:45:00.000Z",
  "idleExpiresAt": "2026-11-25T12:45:00.000Z",
  "serverTime": "2026-11-25T10:45:00.000Z",
  "requestId": "..."
}
```

### `GET /api/auth/csrf`

Issues a session-bound CSRF token for protected state-changing requests.

- **Authentication**: Required (`requireAuth`, `requireActiveUser`)
- **Headers**: `Cache-Control: no-store`
- **Response (`200 OK`)**:

```json
{
  "success": true,
  "csrfToken": "<64-hex-char-token>",
  "requestId": "..."
}
```

### `POST /api/auth/logout`

Destroys the current server-side MongoDB session and clears the `c2c.sid` cookie without affecting any user or future gameplay records.

- **Authentication & Security**: `requireAuth`, `csrfProtection` (`X-CSRF-Token` header + trusted `Origin`/`Referer`), `authMutationLimiter` (`300` / `15m` per user ID)
- **Headers**: `Cache-Control: no-store`
- **Response (`200 OK`)**:

```json
{
  "success": true,
  "message": "Logged out successfully",
  "requestId": "..."
}
```

---

## 3. Standard Error Contract

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "requestId": "..."
  }
}
```

| Status | Codes |
| :---: | :--- |
| `400` | `INVALID_JSON`, `INVALID_PORTAL_DESTINATION`, `MISSING_OAUTH_STATE` |
| `401` | `UNAUTHENTICATED`, `SESSION_EXPIRED`, `SESSION_INVALID`, `UNVERIFIED_GOOGLE_EMAIL`, `OAUTH_CONSENT_CANCELLED`, `OAUTH_EXCHANGE_FAILED` |
| `403` | `FORBIDDEN`, `ACCOUNT_DISABLED`, `CORS_ORIGIN_DENIED`, `CSRF_TOKEN_MISSING`, `CSRF_TOKEN_INVALID`, `CSRF_UNTRUSTED_ORIGIN`, `INVALID_OAUTH_STATE`, `EXPIRED_OAUTH_STATE`, `REPLAYED_OAUTH_STATE` |
| `404` | `ROUTE_NOT_FOUND` |
| `413` | `PAYLOAD_TOO_LARGE` |
| `429` | `RATE_LIMIT_EXCEEDED` |
| `500` | `INTERNAL_SERVER_ERROR` (message sanitized in `production`) |
| `503` | `AUTH_INFRASTRUCTURE_UNAVAILABLE`, `SERVICE_UNAVAILABLE` |
