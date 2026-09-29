/**
 * Backfills `email` onto users that were already migrated from legacy MariaDB.
 *
 *   node migration/scripts/backfill-user-email.js            # dry run (default)
 *   node migration/scripts/backfill-user-email.js --apply    # write
 *
 * This is NOT the user migration. It creates no users, deletes none, and
 * touches no field other than `email`. Matching is strictly
 * m_user.user_id -> users.legacy.userId; phone and email are never used to
 * match. MariaDB is read-only throughout, and the existing production guard
 * (MIGRATION_ALLOW_PRODUCTION) still applies.
 */
import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import User from '../../src/models/user.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import { extractUserEmails } from '../extractors/user.extractor.js';
import { groupByEmail } from '../transformers/email.transformer.js';
import { backfillUserEmails } from '../loaders/user-email.loader.js';

export const runEmailBackfill = async ({ apply = false } = {}) => {
  const dryRun = !apply;

  logger.info(
    `Email backfill (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only]`,
  );

  // 1. Read legacy identity + email only.
  const entries = await extractUserEmails();

  // 2. Duplicate emails are reported, never used to merge or key anything.
  const duplicateGroups = groupByEmail(entries);

  // 3. Match on legacy.userId and classify.
  const summary = await backfillUserEmails(entries, { dryRun });

  const lines = [
    '',
    '──────────── EMAIL BACKFILL ────────────',
    `mode                    : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
    `legacy source           : ${migrationEnv.source}`,
    `legacy database         : ${migrationEnv.mysql.database}`,
    '',
    `Legacy users inspected  : ${summary.legacyInspected}`,
    `Users with email        : ${summary.withEmail}`,
    `Users without email     : ${summary.withoutEmail}`,
    `Mongo users matched     : ${summary.matched}`,
    `Mongo users not found   : ${summary.missingMongoUser.length}`,
    `${dryRun ? 'Emails would be added ' : 'Emails added          '}  : ${summary.toAdd}`,
    `Explicit nulls          : ${summary.nullsWritten}`,
    `Already matching        : ${summary.alreadyMatching}`,
    `Conflicts (not written) : ${summary.conflicts.length}`,
    `Duplicate email groups  : ${duplicateGroups.length}`,
    `Errors                  : ${summary.errors.length}`,
  ];

  if (!dryRun) lines.push(`Documents modified      : ${summary.updated}`);
  lines.push('────────────────────────────────────────', '');

  logger.info(lines.join('\n'));

  if (duplicateGroups.length > 0) {
    logger.warn(
      `${duplicateGroups.length} email address(es) are shared by more than one legacy user. ` +
        'Each user keeps its own email; nothing is merged and email is not an identity key.',
    );
    for (const group of duplicateGroups.slice(0, 10)) {
      logger.warn(`  ${group.email} -> legacy users ${group.legacyUserIds.join(', ')}`);
    }
    if (duplicateGroups.length > 10) {
      logger.warn(`  ... and ${duplicateGroups.length - 10} more`);
    }
  }

  if (summary.conflicts.length > 0) {
    logger.warn(
      `${summary.conflicts.length} user(s) already hold a different email. Left untouched:`,
    );
    for (const conflict of summary.conflicts.slice(0, 10)) {
      logger.warn(
        `  legacy ${conflict.legacyUserId} (${conflict.userId}): existing "${conflict.existingEmail}" vs legacy "${conflict.legacyEmail}"`,
      );
    }
  }

  if (summary.missingMongoUser.length > 0) {
    const shown = summary.missingMongoUser.slice(0, 25).join(', ');
    logger.warn(
      `Legacy user ids with no migrated Mongo user (skipped, never created): ${shown}` +
        (summary.missingMongoUser.length > 25 ? ' ...' : ''),
    );
  }

  return { summary, duplicateGroups };
};

const isEntryPoint =
  process.argv[1] && process.argv[1].endsWith('backfill-user-email.js');

if (isEntryPoint) {
  const apply = process.argv.includes('--apply');

  Promise.resolve()
    .then(assertMigrationEnv)
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => User.syncIndexes())
    .then(() => runEmailBackfill({ apply }))
    .catch((error) => {
      logger.error(`Email backfill failed: ${error.message}`);
      logger.debug(error.stack);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runEmailBackfill;
