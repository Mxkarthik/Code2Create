import express from 'express';
import { requireActiveUser, requireParticipantAccess } from '../../middleware/authorize.js';

/**
 * Create router for Phase 02 Google OAuth, persistent session inspection, CSRF, and logout.
 */
export function createAuthRouter({
  authController,
  authMiddleware,
  csrfProtection,
  rateLimiters
}) {
  const router = express.Router();

  router.get('/google', rateLimiters.authOAuthLimiter, authController.initiateGoogleOAuth);
  router.get(
    '/google/callback',
    rateLimiters.authOAuthLimiter,
    authController.handleGoogleCallback
  );

  router.get(
    '/me',
    authMiddleware.requireAuth,
    requireActiveUser,
    requireParticipantAccess,
    authController.getCurrentUser
  );

  router.get(
    '/session',
    authMiddleware.resolveSessionStatus,
    authController.getSessionStatus
  );

  router.get(
    '/csrf',
    authMiddleware.requireAuth,
    requireActiveUser,
    authController.getCsrfToken
  );

  router.post(
    '/logout',
    rateLimiters.authMutationLimiter,
    authMiddleware.requireAuth,
    csrfProtection,
    authController.logout
  );

  return router;
}
