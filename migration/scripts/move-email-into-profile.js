/**
 * Moves root-level `email` / `isVerified` into `profile.email` /
 * `profile.isEmailVerified`.
 *
 *   node migration/scripts/move-email-into-profile.js           # dry run
 *   node migration/scripts/move-email-into-profile.js --apply   # write
 *
 * Pure data restructuring: no verification is performed, no address is
 * validated or corrected, and no field other than those two is written. The
 * original MariaDB -> Mongo user migration is not involved and is not re-run.
 *
 * MongoDB only, so no MariaDB connection is opened; the production guard on
 * the legacy database still applies.
 */
import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import { assertMigrationEnv } from '../config/migration.env.js';
import {
  inspectEmailPlacement,
  moveEmailIntoProfile,
} from '../loaders/profile-email.loader.js';

export const runEmailMove = async ({ apply = false } = {}) => {
  const dryRun = !apply;

  logger.info(`Move email into profile (${dryRun ? 'DRY RUN' : 'APPLY'}) [MongoDB only]`);

  const before = await inspectEmailPlacement();
  const summary = await moveEmailIntoProfile({ dryRun });
  const after = dryRun ? before : await inspectEmailPlacement();

  const lines = [
    '',
    '──────── EMAIL → PROFILE MOVE ────────',
    `mode                        : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
    '',
    `Users carrying root fields  : ${summary.checked}`,
    `${dryRun ? 'Would move                ' : 'Users moved               '}  : ${summary.moved}`,
    `Already in profile          : ${summary.alreadyMigrated}`,
    `Conflicts (left untouched)  : ${summary.conflicts.length}`,
    `Errors                      : ${summary.errors.length}`,
    '',
    '--- MongoDB state ---',
    `users with root email       : ${after.rootEmail}`,
    `users with root isVerified  : ${after.rootVerified}`,
    `users with profile.email    : ${after.profileEmail}`,
    `profile.isEmailVerified true: ${after.profileVerified}`,
    `migrated users with email   : ${after.migratedWithEmail}`,
    `migrated but unverified     : ${after.migratedUnverified}`,
    `verified without an email   : ${after.verifiedWithoutEmail}`,
    '──────────────────────────────────────',
    '',
  ];

  logger.info(lines.join('\n'));

  if (summary.conflicts.length > 0) {
    logger.warn(
      `${summary.conflicts.length} user(s) already hold a different profile.email. Left untouched:`,
    );
    for (const conflict of summary.conflicts.slice(0, 10)) {
      logger.warn(
        `  ${conflict.userId}: root "${conflict.rootEmail}" vs profile "${conflict.profileEmail}"`,
      );
    }
  }

  return { summary, state: after };
};

const isEntryPoint =
  process.argv[1] && process.argv[1].endsWith('move-email-into-profile.js');

if (isEntryPoint) {
  const apply = process.argv.includes('--apply');

  Promise.resolve()
    .then(() => assertMigrationEnv({ requireMysql: false }))
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => runEmailMove({ apply }))
    .catch((error) => {
      logger.error(`Email move failed: ${error.message}`);
      logger.debug(error.stack);
      process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close().catch(() => {}));
}

export default runEmailMove;
