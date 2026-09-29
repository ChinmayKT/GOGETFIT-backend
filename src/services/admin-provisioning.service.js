import logger from '../config/logger.js';
import User from '../models/user.model.js';
import { ROLE_ADMIN, mergeRoles } from '../constants/roles.js';
import { normalizePhone } from '../utils/phone.js';
import { assertPasswordAcceptable, hashPassword } from '../utils/password.js';

/**
 * Grants roles to an EXISTING account and optionally sets an Admin Portal
 * password.
 *
 * Two rules make this safe to re-run and safe to point at a live database:
 *
 *  1. It never creates a user. An unknown phone returns
 *     { found: false } and writes nothing, rather than producing an
 *     administrator with no verified identity and no legacy mapping.
 *  2. It only ever issues `$set` on the specific paths it is changing. No
 *     `$unset`, no document replacement - so `legacy`, `migration`, `createdAt`,
 *     the profile and every unrelated field survive untouched.
 *
 * Idempotent: a second identical call computes an empty change set and reports
 * changed: false.
 */
export const provisionAdmin = async ({
  phone,
  email = null,
  roles = [ROLE_ADMIN],
  password = null,
  apply = false,
  now = new Date(),
} = {}) => {
  const normalized = normalizePhone(phone);

  if (password !== null && password !== '') assertPasswordAcceptable(password);

  const user = await User.findOne({ 'phone.normalized': normalized }).select('+auth.passwordHash');

  if (!user) return { found: false, normalized, changed: false, before: null, after: null, plan: null };

  const before = {
    id: String(user._id),
    phone: { raw: user.phone.raw, normalized: user.phone.normalized },
    legacy: user.legacy ? { source: user.legacy.source, userId: user.legacy.userId } : null,
    profile: { name: user.profile?.name ?? null, email: user.profile?.email ?? null },
    roles: [...(user.roles ?? [])],
    status: user.status,
    hasPassword: Boolean(user.auth?.passwordHash),
    createdAt: user.createdAt,
  };

  const nextRoles = mergeRoles(user.roles, roles);
  const rolesChanged = JSON.stringify(nextRoles) !== JSON.stringify(before.roles);

  const set = {};
  if (rolesChanged) set.roles = nextRoles;
  // Only fills a BLANK email. An existing address is never rewritten, so this
  // cannot quietly change someone's contact details.
  if (email && !user.profile?.email) set['profile.email'] = email;
  if (user.status !== 'active') set.status = 'active';

  if (password) {
    set['auth.passwordHash'] = await hashPassword(password);
    set['auth.passwordUpdatedAt'] = now;
    // A password reset also clears any standing lockout.
    set['auth.failedLoginAttempts'] = 0;
    set['auth.lockedUntil'] = null;
  }

  const plan = {
    rolesChanged,
    roles: { from: before.roles, to: nextRoles },
    passwordChanged: Boolean(password),
    emailFilled: Boolean(set['profile.email']),
    statusChanged: Boolean(set.status),
  };

  const changed = Object.keys(set).length > 0;

  if (!changed || !apply) {
    return { found: true, normalized, changed: false, wouldChange: changed, before, after: null, plan };
  }

  await User.updateOne({ _id: user._id }, { $set: set }, { runValidators: true });
  logger.info(`Provisioned roles ${nextRoles.join(',')} on user ${user._id}`);

  const fresh = await User.findById(user._id).select('+auth.passwordHash').lean();
  const after = {
    id: String(fresh._id),
    phone: fresh.phone,
    legacy: fresh.legacy ?? null,
    profile: { name: fresh.profile?.name ?? null, email: fresh.profile?.email ?? null },
    roles: fresh.roles,
    status: fresh.status,
    // The hash itself is never returned.
    hasPassword: Boolean(fresh.auth?.passwordHash),
    createdAt: fresh.createdAt,
    updatedAt: fresh.updatedAt,
  };

  return { found: true, normalized, changed: true, wouldChange: true, before, after, plan };
};
