import User from '../../src/models/user.model.js';
import { migrationEnv } from '../config/migration.env.js';
import { transformLegacyEmail } from '../transformers/email.transformer.js';

/**
 * Backfills the `email` field on users that were already migrated.
 *
 * This never creates, deletes or re-identifies a user: it matches strictly on
 * (legacy.source, legacy.userId) and touches only `email`. A legacy account
 * with no Mongo user is reported, not created. A Mongo user that already holds
 * a different email is reported as a conflict and left untouched.
 */
export const backfillUserEmails = async (
  legacyEntries,
  { dryRun = true, source = migrationEnv.source } = {},
) => {
  const summary = {
    legacyInspected: legacyEntries.length,
    withEmail: 0,
    withoutEmail: 0,
    matched: 0,
    missingMongoUser: [],
    toAdd: 0,
    alreadyMatching: 0,
    conflicts: [],
    nullsWritten: 0,
    updated: 0,
    errors: [],
  };

  if (legacyEntries.length === 0) return summary;

  const legacyIds = legacyEntries.map((entry) => entry.legacyUserId);

  const existing = await User.find({
    'legacy.source': source,
    'legacy.userId': { $in: legacyIds },
  })
    .select('_id profile.email legacy.userId')
    .lean();

  const byLegacyId = new Map(existing.map((user) => [user.legacy.userId, user]));
  const operations = [];

  for (const entry of legacyEntries) {
    const email = transformLegacyEmail(entry.rawEmail);
    if (email === null) summary.withoutEmail += 1;
    else summary.withEmail += 1;

    const user = byLegacyId.get(entry.legacyUserId);
    if (!user) {
      summary.missingMongoUser.push(entry.legacyUserId);
      continue;
    }
    summary.matched += 1;

    const profile = user.profile || {};
    const hasField = Object.prototype.hasOwnProperty.call(profile, 'email');
    const current = profile.email ?? null;

    if (current === email && hasField) {
      // Already correct, including the null === null case.
      if (email !== null) summary.alreadyMatching += 1;
      continue;
    }

    // An existing, different address is a decision for a person to make, not
    // something the backfill silently overwrites.
    if (current !== null && email !== null && current !== email) {
      summary.conflicts.push({
        legacyUserId: entry.legacyUserId,
        userId: String(user._id),
        existingEmail: current,
        legacyEmail: email,
      });
      continue;
    }

    // Legacy has no email but Mongo holds one: keep what is there rather than
    // erasing data the app may have collected.
    if (email === null && current !== null) {
      summary.conflicts.push({
        legacyUserId: entry.legacyUserId,
        userId: String(user._id),
        existingEmail: current,
        legacyEmail: null,
      });
      continue;
    }

    // The model's default is null, so a document that predates the field gets
    // an explicit null rather than staying absent.
    if (email === null) summary.nullsWritten += 1;
    else summary.toAdd += 1;

    operations.push({
      updateOne: {
        filter: { 'legacy.source': source, 'legacy.userId': entry.legacyUserId },
        // Only `profile.email` is ever written.
        update: { $set: { 'profile.email': email } },
      },
    });
  }

  if (dryRun || operations.length === 0) return summary;

  try {
    const result = await User.bulkWrite(operations, { ordered: false });
    summary.updated = result.modifiedCount ?? 0;
  } catch (error) {
    for (const writeError of error.writeErrors || []) {
      const detail = writeError.err || writeError;
      summary.errors.push(detail.errmsg || detail.message || String(writeError));
    }
    if (!error.writeErrors) throw error;
  }

  return summary;
};

export default backfillUserEmails;
