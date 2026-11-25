import { z } from 'zod';
import { AppError } from '../../utils/AppError.js';
import { PORTAL_DESTINATIONS } from './auth.service.js';

const portalSchema = z.enum([
  PORTAL_DESTINATIONS.PARTICIPANT,
  PORTAL_DESTINATIONS.ADMIN,
  PORTAL_DESTINATIONS.DEV
]);

/**
 * Validate and normalize the predefined portal destination identifier for OAuth initiation.
 * Rejects arbitrary URLs or disabled development destinations outside development mode.
 */
export function validateOAuthPortalQuery(query, env) {
  const rawPortal = query?.portal;
  const candidate =
    typeof rawPortal === 'string' && rawPortal.trim().length > 0
      ? rawPortal.trim().toLowerCase()
      : PORTAL_DESTINATIONS.PARTICIPANT;

  const parsed = portalSchema.safeParse(candidate);
  if (!parsed.success) {
    throw AppError.badRequest(
      'Invalid portal destination identifier',
      'INVALID_PORTAL_DESTINATION'
    );
  }

  if (parsed.data === PORTAL_DESTINATIONS.DEV && env.NODE_ENV !== 'development') {
    throw AppError.badRequest(
      'Development login destination is disabled outside development',
      'INVALID_PORTAL_DESTINATION'
    );
  }

  return parsed.data;
}
