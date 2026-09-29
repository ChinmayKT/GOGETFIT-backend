import User from '../../src/models/user.model.js';

/**
 * Moves the root-level `email` / `isVerified` onto `profile.email` /
 * `profile.isEmailVerified`.
 *
 * Works through the raw collection, because the Mongoose schema no longer
 * declares the root fields and would strip them from a normal read/write.
 * Values are carried across untouched - a malformed legacy address stays
 * exactly as it is. Nothing outside those two fields is written.
 */
export const moveEmailIntoProfile = async ({ dryRun = true } = {}) => {
  const collection = User.collection;

  // Anything still carrying either root field is in scope.
  const pending = await collection
    .find(
      { $or: [{ email: { $exists: true } }, { isVerified: { $exists: true } }] },
      { projection: { email: 1, isVerified: 1, 'profile.email': 1, 'profile.isEmailVerified': 1 } },
    )
    .toArray();

  const summary = {
    checked: pending.length,
    moved: 0,
    alreadyMigrated: 0,
    conflicts: [],
    errors: [],
    dryRun,
  };

  const operations = [];

  for (const doc of pending) {
    const rootEmail = doc.email ?? null;
    const rootVerified = doc.isVerified ?? false;

    const profile = doc.profile || {};
    const hasProfileEmail = Object.prototype.hasOwnProperty.call(profile, 'email');
    const profileEmail = profile.email ?? null;

    // A different address already sitting in the profile is a real conflict:
    // report it and leave the document alone rather than picking a winner.
    if (hasProfileEmail && profileEmail !== null && rootEmail !== null && profileEmail !== rootEmail) {
      summary.conflicts.push({
        userId: String(doc._id),
        rootEmail,
        profileEmail,
      });
      continue;
    }

    const alreadyInPlace =
      hasProfileEmail &&
      profileEmail === rootEmail &&
      (profile.isEmailVerified ?? false) === rootVerified;

    if (alreadyInPlace) summary.alreadyMigrated += 1;
    else summary.moved += 1;

    operations.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: { 'profile.email': rootEmail, 'profile.isEmailVerified': rootVerified },
          // The root copies must not survive: profile is the single source.
          $unset: { email: '', isVerified: '' },
        },
      },
    });
  }

  if (dryRun || operations.length === 0) return summary;

  try {
    await collection.bulkWrite(operations, { ordered: false });
  } catch (error) {
    for (const writeError of error.writeErrors || []) {
      const detail = writeError.err || writeError;
      summary.errors.push(detail.errmsg || detail.message || String(writeError));
    }
    if (!error.writeErrors) throw error;
  }

  return summary;
};

/** Read-only picture of where email data currently lives. */
export const inspectEmailPlacement = async () => {
  const collection = User.collection;

  const [
    rootEmail,
    rootVerified,
    profileEmail,
    profileVerified,
    migratedWithEmail,
    migratedUnverified,
    verifiedWithoutEmail,
  ] = await Promise.all([
    collection.countDocuments({ email: { $exists: true } }),
    collection.countDocuments({ isVerified: { $exists: true } }),
    collection.countDocuments({ 'profile.email': { $nin: [null, ''] } }),
    collection.countDocuments({ 'profile.isEmailVerified': true }),
    collection.countDocuments({
      'legacy.source': 'gogetfit',
      'profile.email': { $nin: [null, ''] },
    }),
    collection.countDocuments({
      'legacy.source': 'gogetfit',
      'profile.email': { $nin: [null, ''] },
      'profile.isEmailVerified': { $ne: true },
    }),
    collection.countDocuments({
      'profile.isEmailVerified': true,
      'profile.email': { $in: [null, ''] },
    }),
  ]);

  return {
    rootEmail,
    rootVerified,
    profileEmail,
    profileVerified,
    migratedWithEmail,
    migratedUnverified,
    verifiedWithoutEmail,
  };
};

export default moveEmailIntoProfile;
