/**
 * Migrates the legacy GoGetFit Plans (m_package) into the GogetfitPlan collection.
 *
 *   npm run migrate:gogetfit-plans            # dry run
 *   npm run migrate:gogetfit-plans -- --apply # write
 *
 * MariaDB is read-only throughout, and the production-database rail applies.
 * Safe to re-run: identity is the legacy package_id, so a second run creates
 * nothing and reports every plan as unchanged. See docs/gogetfit-plans-legacy.md.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import { countPackages, extractPackages, resolvePackageColumns } from '../extractors/package.extractor.js';
import { loadGogetfitPlans, verifyGogetfitPlans } from '../loaders/gogetfit-plan.loader.js';

const list = (values) => (values.length ? values.join(', ') : '-');

export const runGogetfitPlanMigration = async ({ apply = false, runId = null } = {}) => {
  const dryRun = !apply;
  const id = runId ?? `gogetfit-plans-${new Date().toISOString()}-${randomUUID().slice(0, 6)}`;

  logger.info(`GoGetFit plan migration (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only]`);

  const columns = await resolvePackageColumns();
  const sourceCount = await countPackages();
  const rows = await extractPackages();

  const summary = await loadGogetfitPlans(rows, { dryRun, runId: id });
  const verify = dryRun ? null : await verifyGogetfitPlans(rows);
  const q = summary.quality;

  logger.info(
    [
      '',
      '────────── GOGETFIT PLAN MIGRATION ──────────',
      `mode                          : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `run id                        : ${id}`,
      `legacy source / database      : ${migrationEnv.source} / ${migrationEnv.mysql.database}.${migrationEnv.packageTable}`,
      `Source m_package rows         : ${sourceCount}`,
      `Rows inspected                : ${summary.inspected}`,
      `${dryRun ? 'Would create' : 'Created     '}                  : ${dryRun ? summary.toCreate : summary.created}`,
      `${dryRun ? 'Would update' : 'Updated     '}                  : ${dryRun ? summary.toUpdate : summary.updated}`,
      `Already migrated, unchanged   : ${summary.unchanged}`,
      `Conflicts (edited in portal)  : ${summary.conflicts.length}`,
      ...summary.conflicts.map((c) => `    package ${c.packageId} -> plan ${c.planId}: ${c.fields.join(', ')}`),
      `Duplicate legacy ids          : ${list(summary.duplicateLegacyIds)}`,
      `Errors                        : ${summary.errors.length}`,
      ...summary.errors.map((e) => `    ${e}`),
      '',
      '── data quality (preserved as-is) ──',
      `Types off the dropdown        : ${JSON.stringify(q.unknownTypes)}`,
      `Levels off the dropdown       : ${JSON.stringify(q.unknownLevels)}`,
      `Challenge without reward      : ${list(q.challengeWithoutReward)}`,
      `Enrollment with a reward      : ${list(q.enrollmentWithReward)}`,
      `Zero-week duration            : ${list(q.zeroDuration)}`,
      `Zero persons allowed          : ${list(q.zeroPersons)}`,
      `Inclusions with leading quote : ${list(q.leadingQuoteInclusions)}`,
      columns.missing.length ? `Legacy columns ABSENT         : ${columns.missing.join(', ')}` : '',
      ...(verify
        ? [
            '',
            '── verification (legacy vs MongoDB, field by field) ──',
            `Legacy rows                   : ${verify.legacyCount}`,
            `Migrated plans in MongoDB     : ${verify.mongoCount}`,
            `Missing in MongoDB            : ${list(verify.missing)}`,
            `Field mismatches              : ${verify.mismatches.length}`,
            ...verify.mismatches.map((m) => `    package ${m.packageId}: ${m.fields.join(', ')}${m.editedInPortal ? ' (edited in portal)' : ''}`),
            `In MongoDB but not in legacy  : ${list(verify.extra)}`,
          ]
        : []),
      '─────────────────────────────────────────────',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  return { summary, verify };
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('migrate-gogetfit-plans.js');

if (isEntryPoint) {
  const apply = process.argv.includes('--apply');
  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => GogetfitPlan.syncIndexes())
    .then(() => runGogetfitPlanMigration({ apply }))
    .catch((error) => {
      logger.error(`GoGetFit plan migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runGogetfitPlanMigration;
