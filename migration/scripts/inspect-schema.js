/**
 * Read-only reconnaissance against the legacy database.
 *
 *   node migration/scripts/inspect-schema.js
 *
 * Verifies connectivity, lists the columns of the legacy user table, reports
 * which expected columns are present or missing, and confirms that the
 * authentication columns are excluded from what the migration reads. Writes
 * nothing, anywhere.
 */
import logger from '../../src/config/logger.js';
import { closePool, query } from '../config/mariadb.js';
import { describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import {
  FORBIDDEN_COLUMNS,
  READABLE_COLUMNS,
  countUsers,
  resolveSelectableColumns,
} from '../extractors/user.extractor.js';

const run = async () => {
  logger.info(`Inspecting ${describeMysqlTarget()} (read-only)`);

  const version = await query('SELECT VERSION() AS version');
  logger.info(`Server version: ${version[0].version}`);

  const { selected, missing, forbiddenPresent, allColumns } = await resolveSelectableColumns();

  logger.info(`Table "${migrationEnv.userTable}" has ${allColumns.length} columns`);
  logger.info(`Rows: ${await countUsers()}`);

  logger.info(`Expected columns present (${selected.length}/${READABLE_COLUMNS.length}):`);
  logger.info(`  ${selected.join(', ')}`);

  if (missing.length > 0) {
    logger.warn(`Expected columns MISSING from this database: ${missing.join(', ')}`);
  }

  if (forbiddenPresent.length > 0) {
    logger.info(
      `Authentication columns exist in legacy but are never selected: ${forbiddenPresent.join(', ')}`,
    );
  }

  const unexpected = allColumns
    .map((column) => column.name)
    .filter((name) => !READABLE_COLUMNS.includes(name) && !FORBIDDEN_COLUMNS.includes(name));

  if (unexpected.length > 0) {
    logger.info(`Other columns present (not read by the migration): ${unexpected.join(', ')}`);
  }

  // Duplicate-phone pressure test, still read-only.
  const duplicates = await query(
    'SELECT phone_number, COUNT(*) AS total FROM ?? WHERE phone_number IS NOT NULL AND phone_number <> ? GROUP BY phone_number HAVING COUNT(*) > 1 ORDER BY total DESC LIMIT 20',
    [migrationEnv.userTable, ''],
  );

  logger.info(`Raw duplicate phone_number values (top ${duplicates.length}):`);
  for (const row of duplicates) {
    logger.info(`  ${row.phone_number} -> ${row.total} accounts`);
  }
};

run()
  .catch((error) => {
    logger.error(`Schema inspection failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
