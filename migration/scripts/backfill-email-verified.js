/**
 * Marks the already-backfilled legacy emails as verified.
 *
 *   node migration/scripts/backfill-email-verified.js           # dry run
 *   node migration/scripts/backfill-email-verified.js --apply   # write
 *
 * Legacy addresses are trusted because they came from the legacy system. This
 * script performs NO verification: it sends nothing, validates nothing and
 * corrects nothing - a malformed legacy address stays exactly as migrated.
 *
 * It reads MongoDB only, so no MariaDB connection is opened; the production
 * database guard still applies. Only `isVerified` is written.
 */
import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import User from '../../src/models/user.model.js';
import { assertMigrationEnv, migrationEnv } from '../config/migration.env.js';
import { backfillEmailVerified } from '../loaders/email-verified.loader.js';

export const runEmailVerifiedBackfill = async ({ apply = false } = {}) => {
  const dryRun = !apply;

  logger.info(`Email-verified backfill (${dryRun ? 'DRY RUN' : 'APPLY'}) [MongoDB only]`);

  const summary = await backfillEmailVerified({ dryRun });

  const lines = [
    '',
    '──────── EMAIL VERIFIED BACKFILL ────────',
    `mode                       : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
    `legacy source              : ${migrationEnv.source}`,
    '',
    `Legacy users with email    : ${summary.matched}`,
    `Already verified           : ${summary.alreadyVerified}`,
    `${dryRun ? 'Would mark verified      ' : 'Marked verified          '}  : ${summary.toVerify}`,
    `Legacy users without email : ${summary.legacyWithoutEmail}`,
    `New users (untouched)      : ${summary.nativeUsers}`,
  ];

  if (!dryRun) lines.push(`Documents modified         : ${summary.updated}`);
  lines.push('─────────────────────────────────────────', '');

  logger.info(lines.join('\n'));

  return summary;
};

const isEntryPoint =
  process.argv[1] && process.argv[1].endsWith('backfill-email-verified.js');

if (isEntryPoint) {
  const apply = process.argv.includes('--apply');

  Promise.resolve()
    // MongoDB-only backfill, so MariaDB credentials are not required; the
    // production-database guard still runs.
    .then(() => assertMigrationEnv({ requireMysql: false }))
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => User.syncIndexes())
    .then(() => runEmailVerifiedBackfill({ apply }))
    .catch((error) => {
      logger.error(`Email-verified backfill failed: ${error.message}`);
      logger.debug(error.stack);
      process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close().catch(() => {}));
}

export default runEmailVerifiedBackfill;
