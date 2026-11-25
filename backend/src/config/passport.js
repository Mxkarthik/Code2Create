import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import passport from 'passport';
import { defaultUserService } from '../modules/users/user.service.js';

/**
 * Extract normalized Google profile fields obtained from Google's authenticated UserInfo endpoint.
 */
export function extractGoogleProfile(profile) {
  const json = profile?._json ?? {};
  const googleSub = json.sub || profile?.id;
  const email = json.email || profile?.emails?.[0]?.value;
  const emailVerified =
    json.email_verified === true || profile?.emails?.[0]?.verified === true;
  const name = profile?.displayName || json.name;
  const avatar = json.picture || profile?.photos?.[0]?.value || null;

  return {
    googleSub,
    email,
    emailVerified,
    name,
    avatar
  };
}

/**
 * Create an isolated Passport instance configured for Google OAuth Authorization Code Flow + PKCE.
 */
export function createPassportAuthenticator({
  env,
  oauthStateStore,
  userService = defaultUserService
}) {
  const authenticator = new passport.Passport();

  const strategy = new GoogleStrategy(
    {
      clientID: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackURL: env.GOOGLE_CALLBACK_URL,
      scope: ['openid', 'email', 'profile'],
      pkce: true,
      store: oauthStateStore
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const googleProfile = extractGoogleProfile(profile);
        const user = await userService.findOrCreateGoogleUser(googleProfile);
        return done(null, user);
      } catch (err) {
        if (err?.statusCode === 401 || err?.statusCode === 403) {
          return done(null, false, {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode
          });
        }
        return done(err);
      }
    }
  );

  authenticator.use('google', strategy);

  return authenticator;
}
