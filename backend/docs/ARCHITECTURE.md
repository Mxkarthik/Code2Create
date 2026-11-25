# Architecture — CODE 2 CREATE (Round 2: CODE RUSH)

## 1. Architectural Style

The backend is a **Modular Monolithic** Node.js (ES Modules) + Express 5 application backed by MongoDB Atlas (Mongoose), sized for **~100 concurrent users** and **up to 50 competing teams**.

## 2. Request Pipeline (Phases 01 & 02)

```text
HTTP Request
  │
  ▼
requestIdMiddleware          Assigns/validates X-Request-Id
  │
  ▼
createHttpLogger (pino-http) Structured logs; strips query strings & bodies; redacts secrets/cookies
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
  ├──► GET  /api/auth/google          Rate-limited; validates portal key; stores PKCE + atomic state
  ├──► GET  /api/auth/google/callback Rate-limited; consumes state atomically; upserts User; regenerates SID
  ├──► GET  /api/auth/session         Passive status + dual expiry timestamps (no-store)
  ├──► GET  /api/auth/me              requireAuth -> live MongoDB role & portal permissions (no-store)
  ├──► GET  /api/auth/csrf            requireAuth -> issues session-bound CSRF token (no-store)
  └──► POST /api/auth/logout          requireAuth + csrfProtection -> destroys session & clears cookie
  │
  ▼
notFoundMiddleware -> createErrorHandler (sanitized 500s in production, 503 on DB outages)
```

## 3. Authentication & Session Design

### Google OAuth 2.0 + PKCE State Lifecycle (`src/modules/auth/auth.service.js`, `src/config/passport.js`)

1. Client hits `GET /api/auth/google?portal=participant|admin|dev` (`dev` permitted in `development` only).
2. `createOAuthStateStore` generates a 256-bit random handle (`crypto.randomBytes(32).toString('base64url')`), stores its SHA-256 `handleHash` in `req.session.oauthTx` and `OAuthTransaction` (`oauth_transactions` collection with 10-minute TTL), and explicitly calls `req.session.save()` before redirecting to Google with `pkce: true` (`S256`) and scopes `['openid', 'email', 'profile']`.
3. On callback, `passport-google-oauth20` exchanges the authorization code + PKCE `code_verifier` with Google over HTTPS and retrieves verified user info from Google's UserInfo endpoint.
4. `verify` checks session binding, timing-safe `handleHash` equality, and 10-minute expiration, then atomically consumes the `OAuthTransaction` via `findOneAndUpdate({ handleHash, sessionId, consumed: false, expiresAt: { $gt: now } }, { $set: { consumed: true } })` — eliminating concurrent callback replay.
5. `findOrCreateGoogleUser` atomically upserts on `googleSub` (`$setOnInsert: { role: 'PARTICIPANT', isActive: true }`), rejects unverified emails (`emailVerified !== true`) and disabled accounts (`isActive === false`), and never overwrites `role` or `isActive` on subsequent logins.
6. `auth.controller.js` calls `req.session.regenerate()` to prevent session fixation, writes minimal `req.session.auth` metadata (`userId`, `authenticatedAt`, `absoluteExpiresAt`, `lastActivityAt`, `idleExpiresAt`) plus a fresh `csrfToken`, saves the session, and redirects only to the validated destination.

### Persistent Session & Expiration (`src/config/session.js`, `src/middleware/authenticate.js`)

- Stored in MongoDB (`sessions` collection via `connect-mongo` reusing Mongoose's client). `MemoryStore` is prohibited in runtime configuration.
- Cookie attributes: `name: 'c2c.sid'`, `httpOnly: true`, `secure: NODE_ENV === 'production'`, `sameSite: 'lax'`, `path: '/'`, host-only (no `Domain`), `saveUninitialized: false`, `resave: false`, `rolling: false`.
- **Dual Expiration**:
  - **Absolute lifetime**: 8 hours (`SESSION_MAX_AGE_MS=28800000`), fixed at login.
  - **Inactivity timeout**: 2 hours (`SESSION_IDLE_TIMEOUT_MS=7200000`). Authenticated requests extend `idleExpiresAt = Math.min(now + SESSION_IDLE_TIMEOUT_MS, absoluteExpiresAt)` throttled to at most once per `min(60s, idleTimeout / 4)` to avoid excessive database writes.
- **Infrastructure Outage Safety**: When MongoDB is unreachable, `sessionMiddleware` and `requireAuth` return HTTP `503` (`AUTH_INFRASTRUCTURE_UNAVAILABLE`) without returning `401` or destroying sessions.

### Production Same-Site Cookie Compatibility

- `SameSite=Lax` + `Secure` cookies require same-site deployment in production. Separate cross-site domains (e.g., independent Vercel frontend and Google Cloud backend origins) can be blocked by third-party cookie restrictions.
- **Recommendation**: Serve frontend and `/api` under a shared site domain (e.g., `app.domain.com` + `api.domain.com` or a same-origin reverse proxy routing `/api/*` to the backend) rather than weakening cookie security flags.

### Windows DNS Configuration (`src/config/database.js`, `src/config/env.js`)

- `MONGODB_DNS_SERVERS` allows operators to explicitly supply DNS resolvers.
- `MONGODB_DNS_FALLBACK` enables the Windows `c-ares` `127.0.0.1` `querySrv ECONNREFUSED` fallback (`1.1.1.1`, `8.8.8.8`) **only** when `NODE_ENV !== 'production'` by default (explicitly disabled by default in `production`).

## 4. Portal Permission Matrix & Future Integration

| Action / Resource | Unauthenticated | `PARTICIPANT` | `ADMIN` | Disabled (`isActive: false`) |
| :--- | :---: | :---: | :---: | :---: |
| `GET /api/health`, `GET /api/ready` | Allowed | Allowed | Allowed | Allowed |
| `GET /api/auth/session` | `authenticated: false` | `authenticated: true` | `authenticated: true` | `authenticated: false` |
| `GET /api/auth/me`, Participant Portal | `401` | Allowed | Allowed | `403` |
| Admin Portal (`requireAdmin`) | `401` | `403` | Allowed | `403` |

### Future Phase 03/04 Middleware Contracts (Pending)

- `requireTeamMembership({ requiredTeamRoles })`: Will verify in MongoDB that the authenticated user is an active member (`TEAM_LEADER` or `TEAM_MEMBER`) of the target team, completely orthogonal to global `PARTICIPANT`/`ADMIN` role.
- `requireRoundEligibility()`: Will verify roster lock, Round 1 qualification mapping, team readiness, and active competition window.
- Planned modules (`src/modules/teams`, `competition`, `problems`, `submissions`, `drafts`, `src/integrations`, `src/workers`, `src/sockets`) remain pending Phases 03–06.
