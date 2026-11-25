# CODE 2 CREATE — Round 2 (CODE RUSH) Backend

Modular monolithic Express backend for the **CODE 2 CREATE** college technical competition platform (**Round 2: CODE RUSH**).

## Tech Stack (Phases 01 & 02)

- **Runtime**: Node.js `>=22.0.0` (verified on `v24.16.0`, ES Modules)
- **Framework**: Express 5 (`express`)
- **Database**: MongoDB Atlas via Mongoose (`mongoose`)
- **Authentication**: Passport (`passport`, `passport-google-oauth20`) with Google OAuth 2.0 Authorization Code Flow + PKCE (S256)
- **Sessions**: Persistent MongoDB sessions (`express-session`, `connect-mongo`)
- **Validation & Security**: Zod (`zod`), Helmet (`helmet`), explicit-allowlist CORS (`cors`), `express-rate-limit`, session-bound CSRF middleware
- **Logging**: Pino (`pino`, `pino-http`) with redaction for secrets, cookies, OAuth codes/tokens, and CSRF tokens
- **Testing**: Vitest (`vitest`) & Supertest (`supertest`)

## Project Structure

```text
backend/
  src/
    config/
      env.js            # Zod environment validation & dotenv loading
      database.js       # MongoDB connection lifecycle, readiness, DNS config & transaction check
      session.js        # Persistent connect-mongo session configuration & cookie helpers
      passport.js       # Google OAuth 2.0 + PKCE strategy & profile verification
    middleware/
      requestId.js      # X-Request-Id correlation middleware
      authenticate.js   # Live MongoDB session & user loading, dual expiry enforcement
      authorize.js      # requireActiveUser, requireAdmin, requireParticipantAccess
      csrf.js           # Origin/Referer + session-bound CSRF token validation
      rateLimiter.js    # Campus-NAT-aware auth rate limiters
      notFound.js       # 404 route handler
      errorHandler.js   # Centralized JSON, infra-503 & production-sanitized error handler
    modules/
      auth/             # Google OAuth flow, atomic state store, session/CSRF/logout routes
      competition/      # Lifecycle (LOBBY->LOCKED->LIVE->SETTLING), rank import, head starts & timer
      execution/        # Multi-case evaluation, durable ExecutionJob queue, scheduler, capacity & recovery
      problems/         # Problem/TestCase bank, Judge0 language IDs, output comparison & readiness
      submissions/      # Persistent Submission model, idempotency, serializers & admission/settlement contracts
      teams/            # Team & TeamMembership models, readiness, join codes & admin lobby
      users/            # User Mongoose schema & atomic upsert service
    integrations/
      judge0/           # Judge0 CE HTTP client, config, errors, Base64/status mapper & service
    workers/            # Durable execution queue worker (execution.worker.js)
    sockets/            # Reserved for Socket.IO real-time layer
    scripts/            # Diagnostic scripts (verify-judge0.js, verify-reference.js, verify-execution-queue.js)
    utils/
      AppError.js       # Operational HTTP error class
      logger.js         # Redacted Pino logger & URI sanitizer
    app.js              # Express app factory (no port binding)
    server.js           # HTTP server bootstrap & graceful shutdown
  tests/
    unit/               # Pure unit & mocked-Google Supertest suites
    integration/        # Real MongoDB (code2create_test) persistence, transaction & RBAC suites
  docs/
    ARCHITECTURE.md
    REQUIREMENTS.md
    API.md
    PROGRESS.md
  AGENTS.md
  .env.example
  .gitignore
  package.json
```

## Setup & Environment Configuration

1. Install dependencies from `backend/`:

   ```bash
   npm install
   ```

2. Ensure `backend/.env` is configured (see [.env.example](file:///c:/Users/maxwh/Desktop/Code2Create/backend/.env.example)):

   - **Database**:
     - `MONGODB_URI` (legacy `MONGO_URI` fallback supported)
     - `MONGODB_TEST_URI` (isolated `code2create_test` database for integration tests)
     - Optional DNS overrides: `MONGODB_DNS_SERVERS` (comma-separated IPs), `MONGODB_DNS_FALLBACK` (`false` by default in `production`; `true` in `development`/`test` for Windows Cloudflare WARP `c-ares` SRV quirk)
   - **Application & CORS**:
     - `NODE_ENV` (`development` | `test` | `production`, default `development`)
     - `PORT` (default `5000`)
     - `PARTICIPANT_FRONTEND_URL` (default `http://localhost:5173`; required in `production`)
     - `ADMIN_FRONTEND_URL` (default `http://localhost:5174`; required in `production`)
     - `LOG_LEVEL` (default `info`)
   - **Authentication & Sessions (Phase 02)**:
     - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` (default `http://localhost:5000/api/auth/google/callback` in dev/test)
     - `SESSION_SECRET` (minimum 32 characters)
     - `SESSION_MAX_AGE_MS` (default `28800000` — 8 hours)
     - `SESSION_IDLE_TIMEOUT_MS` (default `7200000` — 2 hours)
     - `OAUTH_STATE_TTL_MS` (default `600000` — 10 minutes)

    - **Judge0 Execution (Phase 06)**:
      - `JUDGE0_URL` (default `http://127.0.0.1:2358` via local IAP tunnel; production requires direct private backend-to-Judge0 networking)
      - `JUDGE0_AUTH_TOKEN` (required for authenticated Judge0 requests)
      - `JUDGE0_MAX_IN_FLIGHT` (default `8`, bounded `1..64` — concurrent Judge0 jobs, not complete multi-case submissions)
      - `JUDGE0_REQUEST_TIMEOUT_MS` (default `10000`, `1000..60000`)
      - `JUDGE0_POLL_INTERVAL_MS` (default `750`, `100..10000`)
      - `JUDGE0_POLL_TIMEOUT_MS` (default `60000`, `1000..300000`)
    - **Execution Queue Worker (Phase 07)**:
      - `EXECUTION_WORKER_ENABLED` (default `true` in dev/prod, `false` in `test`; never auto-started by Supertest `app.js`)
      - `EXECUTION_WORKER_POLL_INTERVAL_MS` (default `250`, `50..10000`)
      - `EXECUTION_LEASE_DURATION_MS` (default `30000`, `1000..120000`)
      - `EXECUTION_LEASE_RENEW_INTERVAL_MS` (default `10000`, `500..60000`, must be `< EXECUTION_LEASE_DURATION_MS`)
      - `EXECUTION_MAX_QUEUED_SUBMISSIONS` (default `100`, `1..1000`)
      - `EXECUTION_RETRY_MAX_ATTEMPTS` (default `3`, `0..10`)
      - `EXECUTION_SHUTDOWN_TIMEOUT_MS` (default `8000`, `500..60000`)
      - `EXECUTION_UNCERTAIN_RECONCILE_MS` (default `90000`, `100..300000`)

   > **Note**: `ADMIN_EMAILS` and JWT variables are not used by authentication.

## Local Judge0 IAP Tunnel (Development Only)

In local development, connect to the GCP Judge0 VM (`code-rush-515802` / `judge0server` in `asia-south1-a`) over IAP before running `judge0:verify`:

```bash
gcloud compute start-iap-tunnel judge0server 2358 --project=code-rush-515802 --zone=asia-south1-a --local-host-port=127.0.0.1:2358
```

Production deployments must **not** rely on a developer laptop SSH tunnel; deploy the backend with direct private connectivity to the Judge0 instance.

## Manual Administrator Management

All new accounts register as `PARTICIPANT`. Promote or demote administrators directly in MongoDB (takes effect on the user's next request without requiring Google reauthentication):

```javascript
// Promote to ADMIN
db.users.updateOne(
  { _id: ObjectId("USER_ID") },
  { $set: { role: "ADMIN" } }
)

// Demote back to PARTICIPANT
db.users.updateOne(
  { _id: ObjectId("USER_ID") },
  { $set: { role: "PARTICIPANT" } }
)
```

## Running the Server & Tests

```bash
# Development server (auto-reload)
npm run dev

# Production / standard startup
npm start

# Run all unit + isolated MongoDB integration tests
npm test

# Run unit tests only
npm run test:unit

# Run isolated MongoDB integration tests only (requires MONGODB_TEST_URI)
npm run test:integration

# Run live Judge0 diagnostic suite (requires IAP tunnel / self-hosted Judge0)
npm run judge0:verify

# Run disposable reference-solution verification fixture against Judge0
npm run judge0:verify-reference -- --fixture

# Run live persistent queue + Judge0 smoke test against code2create_test
npm run queue:verify
```

## Backend-Only Google OAuth Browser Verification

Before frontends are built, you can test genuine Google OAuth login in `development` mode by navigating to:

- `http://localhost:5000/api/auth/google?portal=dev`

After completing Google sign-in, the callback establishes a persistent MongoDB session and redirects to `http://localhost:5000/api/auth/me` (`portal=dev` is automatically rejected in `production`).
