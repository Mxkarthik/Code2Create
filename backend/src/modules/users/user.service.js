import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';
import { USER_ROLES, User } from './user.model.js';

/**
 * Convert a User document into a safe API profile payload with live portal permissions.
 */
export function toPublicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    avatar: user.avatar ?? null,
    role: user.role,
    permissions: {
      participantPortal: true,
      adminPortal: user.role === USER_ROLES.ADMIN
    }
  };
}

/**
 * Atomically find or create a user from a verified Google OAuth identity.
 * - Uses googleSub as the immutable unique identity (never merges by email).
 * - Assigns default role PARTICIPANT and isActive=true only on initial insert.
 * - Preserves existing role and isActive flags on subsequent logins.
 */
export async function findOrCreateGoogleUser({
  googleSub,
  email,
  emailVerified,
  name,
  avatar = null
}) {
  const normalizedSub = typeof googleSub === 'string' ? googleSub.trim() : '';
  if (!normalizedSub) {
    throw AppError.unauthorized('Google account subject is missing', 'INVALID_GOOGLE_IDENTITY');
  }

  if (emailVerified !== true) {
    throw AppError.unauthorized(
      'A verified Google email address is required',
      'UNVERIFIED_GOOGLE_EMAIL'
    );
  }

  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalizedEmail) {
    throw AppError.unauthorized('Google email address is missing', 'INVALID_GOOGLE_IDENTITY');
  }

  const normalizedName =
    typeof name === 'string' && name.trim().length > 0
      ? name.trim()
      : normalizedEmail.split('@')[0];

  const normalizedAvatar =
    typeof avatar === 'string' && avatar.trim().length > 0 ? avatar.trim() : null;

  const filter = { googleSub: normalizedSub };
  const profileSet = {
    email: normalizedEmail,
    name: normalizedName,
    avatar: normalizedAvatar,
    lastLoginAt: new Date()
  };

  let user;
  try {
    user = await User.findOneAndUpdate(
      filter,
      {
        $set: profileSet,
        $setOnInsert: {
          googleSub: normalizedSub,
          role: USER_ROLES.PARTICIPANT,
          isActive: true
        }
      },
      {
        upsert: true,
        returnDocument: 'after',
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );
  } catch (err) {
    // Handle simultaneous first-login upsert race on the unique googleSub index.
    if (err?.code === 11000) {
      user = await User.findOneAndUpdate(
        filter,
        { $set: profileSet },
        { returnDocument: 'after', runValidators: true }
      );
    } else {
      throw err;
    }
  }

  if (!user) {
    throw new AppError('Unable to persist authenticated user', {
      statusCode: 500,
      code: 'USER_PERSISTENCE_FAILED'
    });
  }

  if (!user.isActive) {
    throw AppError.forbidden('Your account has been disabled', 'ACCOUNT_DISABLED');
  }

  return user;
}

/**
 * Retrieve the latest user record from MongoDB so manual role/status changes
 * apply immediately on subsequent requests without requiring reauthentication.
 */
export async function getUserById(userId) {
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }

  return User.findById(userId).lean();
}

export const defaultUserService = Object.freeze({
  findOrCreateGoogleUser,
  getUserById,
  toPublicUser
});
