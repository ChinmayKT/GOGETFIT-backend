/**
 * Initializes `profile.profilePicture` to null on users that predate the field.
 *
 *   node migration/scripts/init-profile-picture-field.js           # dry run
 *   node migration/scripts/init-profile-picture-field.js --apply   # write
 *
 * Profile pictures are new in GoGetFit 2.0 - the legacy application had none,
 * so nothing is migrated from MariaDB and no picture is invented. This only
 * adds the missing field, and never overwrites a picture a user has set.
 *
 * MongoDB only; the production guard on the legacy database still applies.
 */
import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import User from '../../src/models/user.model.js';
import { assertMigrationEnv } from '../config/migration.env.js';

export const initProfilePictureField = async ({ dryRun = true } = {}) => {
  const collection = User.collection;

  const [inspected, missing, alreadySet, withPicture, rootField] = await Promise.all([
    collection.countDocuments({}),
    collection.countDocuments({ 'profile.profilePicture': { $exists: false } }),
    collection.countDocuments({ 'profile.profilePicture': { $exists: true } }),
    collection.countDocuments({ 'profile.profilePicture': { $nin: [null, ''] } }),
    collection.countDocuments({ profilePicture: { $exists: true } }),
  ]);

  const summary = {
    inspected,
    alreadyContaining: alreadySet,
    initialized: 0,
    wouldInitialize: missing,
    skipped: withPicture,
    conflicts: [],
    errors: [],
    rootField,
    dryRun,
  };

  // A picture stored at the root would mean something wrote outside the agreed
  // contract; report it rather than quietly moving or deleting it.
  if (rootField > 0) {
    const offenders = await collection
      .find({ profilePicture: { $exists: true } }, { projection: { _id: 1 } })
      .limit(20)
      .toArray();
    summary.conflicts = offenders.map((doc) => String(doc._id));
  }

  if (dryRun || missing === 0) return summary;

  try {
    // $exists:false means only documents lacking the field are touched, so a
    // user's own picture can never be overwritten and a re-run is a no-op.
    const result = await collection.updateMany(
      { 'profile.profilePicture': { $exists: false } },
      { $set: { 'profile.profilePicture': null } },
    );
    summary.initialized = result.modifiedCount ?? 0;
  } catch (error) {
    summary.errors.push(error.message);
  }

  return summary;
};

export const runProfilePictureInit = async ({ apply = false } = {}) => {
  const dryRun = !apply;
  logger.info(`Profile picture field init (${dryRun ? 'DRY RUN' : 'APPLY'}) [MongoDB only]`);

  const summary = await initProfilePictureField({ dryRun });

  logger.info(
    [
      '',
      '──── PROFILE PICTURE FIELD ────',
      `mode                       : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      '',
      `Users inspected            : ${summary.inspected}`,
      `Already containing field   : ${summary.alreadyContaining}`,
      `${dryRun ? 'Would initialize to null ' : 'Initialized to null      '}  : ${dryRun ? summary.wouldInitialize : summary.initialized}`,
      `Skipped (picture already set): ${summary.skipped}`,
      `Root-level profilePicture  : ${summary.rootField}`,
      `Conflicts                  : ${summary.conflicts.length}`,
      `Errors                     : ${summary.errors.length}`,
      '───────────────────────────────',
      '',
    ].join('\n'),
  );

  if (summary.conflicts.length > 0) {
    logger.warn(`Users carrying a ROOT-level profilePicture: ${summary.conflicts.join(', ')}`);
  }

  return summary;
};

const isEntryPoint =
  process.argv[1] && process.argv[1].endsWith('init-profile-picture-field.js');

if (isEntryPoint) {
  const apply = process.argv.includes('--apply');

  Promise.resolve()
    .then(() => assertMigrationEnv({ requireMysql: false }))
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => runProfilePictureInit({ apply }))
    .catch((error) => {
      logger.error(`Profile picture init failed: ${error.message}`);
      logger.debug(error.stack);
      process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close().catch(() => {}));
}

export default runProfilePictureInit;
