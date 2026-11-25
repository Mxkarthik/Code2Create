import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { defaultDatabaseAdapter } from './config/database.js';
import {
  DEFAULT_OAUTH_STATE_TTL_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_MAX_AGE_MS
} from './config/env.js';
import { createPassportAuthenticator } from './config/passport.js';
import {
  createDefaultMongoStore,
  createSessionMiddleware
} from './config/session.js';
import { createAuthMiddleware } from './middleware/authenticate.js';
import { createCsrfMiddleware } from './middleware/csrf.js';
import { createErrorHandler } from './middleware/errorHandler.js';
import { notFoundMiddleware } from './middleware/notFound.js';
import { createAuthRateLimiters } from './middleware/rateLimiter.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { createAuthController } from './modules/auth/auth.controller.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createOAuthStateStore } from './modules/auth/auth.service.js';
import { createAdminCompetitionController } from './modules/competition/adminCompetition.controller.js';
import { createCompetitionController } from './modules/competition/competition.controller.js';
import { createCompetitionRouter } from './modules/competition/competition.routes.js';
import { createAdminProblemController } from './modules/problems/adminProblem.controller.js';
import { createAdminProblemRouter } from './modules/problems/adminProblem.routes.js';
import { createProblemController } from './modules/problems/problem.controller.js';
import { createProblemRouter } from './modules/problems/problem.routes.js';
import { createAdminLobbyController } from './modules/teams/adminLobby.controller.js';
import { createAdminLobbyRouter } from './modules/teams/adminLobby.routes.js';
import { createTeamController } from './modules/teams/team.controller.js';
import { createTeamRouter } from './modules/teams/team.routes.js';
import { defaultUserService } from './modules/users/user.service.js';
import { AppError } from './utils/AppError.js';
import { LOG_FORMATS, createHttpLogger, createLogger } from './utils/logger.js';

function normalizeOrigin(origin) {
  return typeof origin === 'string' ? origin.trim().replace(/\/+$/, '') : '';
}

function buildCorsOptions(allowedOrigins) {
  const originSet = new Set(allowedOrigins.map(normalizeOrigin).filter(Boolean));

  return {
    origin(requestOrigin, callback) {
      if (!requestOrigin) {
        return callback(null, true);
      }

      const normalized = normalizeOrigin(requestOrigin);
      if (originSet.has(normalized)) {
        return callback(null, true);
      }

      return callback(
        AppError.forbidden('Origin not allowed by CORS policy', 'CORS_ORIGIN_DENIED')
      );
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-CSRF-Token'],
    exposedHeaders: ['X-Request-Id']
  };
}

/**
 * Construct and configure the Express application without binding a network port.
 */
export function createApp({
  env = {},
  logger,
  database = defaultDatabaseAdapter,
  sessionStore,
  userService = defaultUserService,
  oauthStateStore,
  authenticator,
  rateLimitOptions,
  competitionSlug,
  nowFn = () => Date.now(),
  mountExtraRoutes
} = {}) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const corsOrigins = env.CORS_ORIGINS ?? [
    env.PARTICIPANT_FRONTEND_URL ?? 'http://localhost:5173',
    env.ADMIN_FRONTEND_URL ?? 'http://localhost:5174'
  ];

  const normalizedEnv = {
    ...env,
    NODE_ENV: nodeEnv,
    PARTICIPANT_FRONTEND_URL: env.PARTICIPANT_FRONTEND_URL ?? 'http://localhost:5173',
    ADMIN_FRONTEND_URL: env.ADMIN_FRONTEND_URL ?? 'http://localhost:5174',
    CORS_ORIGINS: corsOrigins,
    SESSION_MAX_AGE_MS: env.SESSION_MAX_AGE_MS ?? DEFAULT_SESSION_MAX_AGE_MS,
    SESSION_IDLE_TIMEOUT_MS: env.SESSION_IDLE_TIMEOUT_MS ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    OAUTH_STATE_TTL_MS: env.OAUTH_STATE_TTL_MS ?? DEFAULT_OAUTH_STATE_TTL_MS
  };

  const logFormat =
    env.LOG_FORMAT ??
    logger?.format ??
    (nodeEnv === 'production' ? LOG_FORMATS.JSON : LOG_FORMATS.MINIMAL);

  const appLogger =
    logger ??
    createLogger({
      level: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
      format: logFormat
    });

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestIdMiddleware);
  app.use(createHttpLogger({ logger: appLogger, format: logFormat }));
  app.use(helmet());
  app.use(cors(buildCorsOptions(corsOrigins)));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Liveness and readiness probes must remain independent of session middleware.
  app.get('/api/health', (req, res) => {
    res.status(200).json({
      success: true,
      status: 'ok',
      service: 'code2create-backend',
      environment: nodeEnv,
      timestamp: new Date(nowFn()).toISOString(),
      uptimeSeconds: Number(process.uptime().toFixed(2)),
      requestId: req.id
    });
  });

  app.get('/api/ready', (req, res) => {
    const dbReady = Boolean(database?.isReady?.());
    const statusCode = dbReady ? 200 : 503;

    res.status(statusCode).json({
      success: dbReady,
      status: dbReady ? 'ready' : 'not_ready',
      checks: {
        database: {
          status: dbReady ? 'up' : 'down'
        }
      },
      timestamp: new Date(nowFn()).toISOString(),
      requestId: req.id
    });
  });

  if (normalizedEnv.SESSION_SECRET && (sessionStore || normalizedEnv.MONGODB_URI)) {
    const effectiveStore = sessionStore ?? createDefaultMongoStore(normalizedEnv);
    const sessionMiddleware = createSessionMiddleware({
      env: normalizedEnv,
      store: effectiveStore,
      database
    });

    const authMiddleware = createAuthMiddleware({
      env: normalizedEnv,
      database,
      userService,
      nowFn
    });

    const csrfProtection = createCsrfMiddleware({ env: normalizedEnv });
    const rateLimiters = createAuthRateLimiters(rateLimitOptions);

    const effectiveOAuthStateStore =
      oauthStateStore ??
      createOAuthStateStore({
        oauthStateTtlMs: normalizedEnv.OAUTH_STATE_TTL_MS,
        nowFn
      });

    const effectiveAuthenticator =
      authenticator ??
      createPassportAuthenticator({
        env: normalizedEnv,
        oauthStateStore: effectiveOAuthStateStore,
        userService
      });

    const authController = createAuthController({
      env: normalizedEnv,
      authenticator: effectiveAuthenticator,
      userService,
      logger: appLogger,
      competitionSlug,
      nowFn
    });

    const teamController = createTeamController({
      logger: appLogger,
      competitionSlug
    });

    const adminLobbyController = createAdminLobbyController({
      competitionSlug,
      logger: appLogger,
      nowFn
    });

    const adminCompetitionController = createAdminCompetitionController({
      competitionSlug,
      logger: appLogger,
      nowFn
    });

    const competitionController = createCompetitionController({
      competitionSlug,
      logger: appLogger,
      nowFn
    });

    const adminProblemController = createAdminProblemController({
      competitionSlug,
      logger: appLogger,
      nowFn
    });

    const problemController = createProblemController();

    app.use('/api/auth', sessionMiddleware, effectiveAuthenticator.initialize());
    app.use(
      '/api/auth',
      createAuthRouter({
        authController,
        authMiddleware,
        csrfProtection,
        rateLimiters
      })
    );

    app.use('/api/teams', sessionMiddleware);
    app.use(
      '/api/teams',
      createTeamRouter({
        teamController,
        authMiddleware,
        csrfProtection,
        rateLimiters
      })
    );

    app.use('/api/competition', sessionMiddleware);
    app.use(
      '/api/competition',
      createCompetitionRouter({
        competitionController,
        authMiddleware
      })
    );

    app.use('/api/problems', sessionMiddleware);
    app.use(
      '/api/problems',
      createProblemRouter({
        problemController,
        authMiddleware,
        competitionSlug,
        nowFn,
        logger: appLogger
      })
    );

    app.use('/api/admin', sessionMiddleware);
    app.use(
      '/api/admin/problems',
      createAdminProblemRouter({
        adminProblemController,
        authMiddleware,
        csrfProtection
      })
    );
    app.use(
      '/api/admin',
      createAdminLobbyRouter({
        adminLobbyController,
        adminCompetitionController,
        authMiddleware,
        csrfProtection
      })
    );

    if (typeof mountExtraRoutes === 'function') {
      mountExtraRoutes({
        app,
        sessionMiddleware,
        authMiddleware,
        csrfProtection
      });
    }
  }

  app.use(notFoundMiddleware);
  app.use(createErrorHandler({ nodeEnv, logFormat, logger: appLogger }));

  return app;
}
