import User from '../../src/models/user.model.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Marks the already-migrated legacy emails as verified, on
 * `profile.isEmailVerified`.
 *
 * Legacy addresses are trusted because they came from the legacy system, so no
 * verification is performed here - nothing is sent, nothing is validated and no
 * address is corrected. Only `isVerified` is written, and only for users that
 * carry a legacy mapping and a non-empty email.
 */
export const backfillEmailVerified = async ({
  dryRun = true,
  source = migrationEnv.source,
} = {}) => {
  // A legacy user with a real email address. Empty strings are excluded so a
  // blank value can never be presented as verified.
  const eligible = {
    'legacy.source': source,
    'profile.email': { $nin: [null, ''] },
  };

  const [matched, alreadyVerified, nativeUsers, legacyWithoutEmail] = await Promise.all([
    User.countDocuments(eligible),
    User.countDocuments({ ...eligible, 'profile.isEmailVerified': true }),
    User.countDocuments({ 'legacy.userId': { $exists: false } }),
    User.countDocuments({ 'legacy.source': source, 'profile.email': { $in: [null, ''] } }),
  ]);

  const summary = {
    matched,
    alreadyVerified,
    toVerify: matched - alreadyVerified,
    updated: 0,
    nativeUsers,
    legacyWithoutEmail,
    dryRun,
  };

  if (dryRun || summary.toVerify === 0) return summary;

  // Filtered on the flag so a re-run is a no-op rather than a rewrite.
  const result = await User.updateMany(
    { ...eligible, 'profile.isEmailVerified': { $ne: true } },
    { $set: { 'profile.isEmailVerified': true } },
  );

  summary.updated = result.modifiedCount ?? 0;
  return summary;
};

export default backfillEmailVerified;
