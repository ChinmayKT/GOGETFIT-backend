/**
 * Reference implementation for migrating any legacy table that references
 * m_user.user_id (t_payment, enrollment, food logs, questionnaire, ...).
 *
 *   node migration/scripts/migrate-child-records.js --table t_payment
 *   node migration/scripts/migrate-child-records.js --table t_payment --apply
 *
 * The only supported linkage is legacy user_id -> users.legacy.userId ->
 * users._id. Phone number is never used to resolve a relationship.
 *
 * This script deliberately stops at resolution and reporting: the destination
 * collection shape for each child table is a separate decision, so it does not
 * invent one. Run it to prove the identity mapping holds before writing any
 * dependent collection.
 */
import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import { closePool, query } from '../config/mariadb.js';
import { assertMigrationEnv, migrationEnv } from '../config/migration.env.js';
import { mapChildRecords } from '../identity/legacy-id-map.js';

const flagValue = (argv, flag, fallback) => {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
};

const run = async () => {
  const argv = process.argv.slice(2);
  const table = flagValue(argv, '--table', null);
  const userIdField = flagValue(argv, '--user-id-field', 'user_id');
  const limit = Number.parseInt(flagValue(argv, '--limit', '1000'), 10);

  if (!table) throw new Error('Usage: migrate-child-records.js --table <legacy_table> [--limit N]');

  assertMigrationEnv();
  await mongoose.connect(process.env.MONGODB_URI);

  const rows = await query('SELECT * FROM ?? ORDER BY ?? ASC LIMIT ?', [table, userIdField, limit]);
  logger.info(`Read ${rows.length} row(s) from ${table} (read-only)`);

  const { resolved, unresolved } = await mapChildRecords(rows, {
    legacyUserIdField: userIdField,
    source: migrationEnv.source,
  });

  logger.info(`Resolved to a Mongo user: ${resolved.length}`);
  logger.info(`Unresolved (owner not migrated): ${unresolved.length}`);

  const unresolvedIds = [...new Set(unresolved.map((entry) => entry.legacyUserId))];
  if (unresolvedIds.length > 0) {
    logger.warn(
      `Legacy user ids with no migrated Mongo user: ${unresolvedIds.slice(0, 25).join(', ')}${unresolvedIds.length > 25 ? ' ...' : ''}`,
    );
    logger.warn('These child rows must stay quarantined until their user conflict is resolved.');
  }

  for (const entry of resolved.slice(0, 5)) {
    logger.info(`  legacy user_id ${entry.legacyUserId} -> Mongo _id ${entry.userId}`);
  }
};

run()
  .catch((error) => {
    logger.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
    await mongoose.connection.close().catch(() => {});
  });
