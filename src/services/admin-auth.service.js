import env from '../config/env.js';
import logger from '../config/logger.js';
import User from '../models/user.model.js';
import { ROLE_ADMIN, hasRole } from '../constants/roles.js';
import { ERROR_CODES, unauthorized } from '../utils/errors.js';
import { signUserToken } from '../utils/jwt.js';
import { verifyPassword } from '../utils/password.js';
import { refreshAge } from './user.service.js';
import { toAdminUser } from './admin.service.js';

/**
 * Every rejection below returns this same error. Wrong email, no password set,
 * not an admin, wrong password and inactive account are indistinguishable to the
 * caller, so the endpoint cannot be used to discover which addresses exist or
 * which of them are administrators.
 *
 * The specific reason is logged server-side instead.
 */
const rejectLogin = (reason, context) => {
  logger.warn(`Admin login rejected (${reason})${context ? `: ${context}` : ''}`);
  return unauthorized(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid email or password');
};

/** Case-insensitive, anchored match. Escaped so an address cannot inject a pattern. */
const emailQuery = (email) => ({
  'profile.email': new RegExp(`^${String(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
});

const isLocked = (user, now) => {
  const until = user.auth?.lockedUntil;
  return Boolean(until && until.getTime() > now.getTime());
};

/**
 * Records a failure and locks the account once the threshold is reached. The
 * counter lives on the document, so it is not reset by a server restart and is
 * shared across every instance - unlike the request rate limiter.
 */
const registerFailure = async (user, now) => {
  const attempts = (user.auth?.failedLoginAttempts ?? 0) + 1;
  const shouldLock = attempts >= env.adminAuth.maxFailedAttempts;
  const lockedUntil = shouldLock
    ? new Date(now.getTime() + env.adminAuth.lockoutMinutes * 60_000)
    : (user.auth?.lockedUntil ?? null);

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        'auth.failedLoginAttempts': shouldLock ? 0 : attempts,
        'auth.lockedUntil': lockedUntil,
      },
    },
  );

  if (shouldLock) {
    logger.warn(`Admin account locked until ${lockedUntil.toISOString()}: ${user._id}`);
  }
};

const registerSuccess = (user, now) =>
  User.updateOne(
    { _id: user._id },
    {
      $set: {
        'auth.failedLoginAttempts': 0,
        'auth.lockedUntil': null,
        'auth.lastLoginAt': now,
      },
    },
  );

/**
 * Email + password login for the Admin Portal.
 *
 * Issues the SAME token shape as the mobile phone+OTP flow (subject = Mongo
 * _id) so that one requireAuth implementation serves both. Authorization is not
 * decided here - the token grants no privilege by itself; requireRole('admin')
 * re-reads the stored roles on every subsequent request.
 */
export const loginWithPassword = async (email, password, now = new Date()) => {
  // passwordHash is select:false on the schema, so it must be asked for.
  const user = await User.findOne(emailQuery(email)).select('+auth.passwordHash');

  if (!user) throw rejectLogin('unknown email', String(email));
  if (isLocked(user, now)) throw rejectLogin('account locked', String(user._id));
  if (!user.auth?.passwordHash) throw rejectLogin('no password set', String(user._id));
  if (!hasRole(user, ROLE_ADMIN)) throw rejectLogin('not an admin', String(user._id));
  if (user.status !== 'active') throw rejectLogin(`status=${user.status}`, String(user._id));

  const ok = await verifyPassword(user.auth.passwordHash, password);

  if (!ok) {
    await registerFailure(user, now);
    throw rejectLogin('wrong password', String(user._id));
  }

  await registerSuccess(user, now);
  const age = await refreshAge(user);
  logger.info(`Admin logged in: ${user._id}`);

  return { token: signUserToken(user), user: toAdminUser(user, age) };
};
