/**
 * Migrates the legacy food master (m_food INNER JOIN r_food_energy) into the
 * foods collection.
 *
 *   npm run migrate:foods              # dry run (report only, writes nothing)
 *   npm run migrate:foods -- --apply   # write
 *
 * MariaDB is read-only throughout and the production-database rail applies, so
 * this runs against staging-ggf unless someone deliberately overrides it.
 *
 * Safe to re-run: identity is (legacy.source, legacy.foodId). An already
 * migrated food is never updated, never overwritten and never deleted - only
 * reported. See docs/foods-legacy.md for the source analysis.
 *
 * Not migrated, by design: foods with no r_food_energy row (invisible in legacy
 * too), orphan energy rows, delete_flg = 1 rows, and any row that does not map
 * cleanly onto the new Food model - each reported by legacy food_id with its
 * reason.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import Food from '../../src/models/food.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import {
  countEnergyRows,
  countFoods,
  countJoinedFoods,
  extractFoods,
  findFoodsWithoutEnergy,
  findOrphanEnergyRows,
  resolveFoodColumns,
} from '../extractors/food.extractor.js';
import { loadFoods, verifyFoods } from '../loaders/food.loader.js';
import { writeReport } from '../reports/migration-report.js';

const ids = (items, key = 'food_id') => (items.length ? items.map((i) => i[key]).join(', ') : 'none');
const rowsOf = (items) =>
  items.length
    ? items.map((i) => `    ${String(i.foodId).padEnd(6)} ${String(i.name ?? '').slice(0, 38).padEnd(40)} ${i.reason}`)
    : ['    -'];

export const runFoodMigration = async ({ apply = false, runId = null } = {}) => {
  const dryRun = !apply;
  const id = runId ?? `foods-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  logger.info(`Food migration (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only]`);

  const columns = await resolveFoodColumns();

  // Every count is measured against the database, never assumed.
  const sourceFoods = await countFoods();
  const sourceEnergy = await countEnergyRows();
  const joined = await countJoinedFoods();
  const withoutEnergy = await findFoodsWithoutEnergy();
  const orphanEnergy = await findOrphanEnergyRows();

  const rows = await extractFoods();
  const before = await Food.countDocuments();

  const s = await loadFoods(rows, { dryRun, runId: id });
  const verify = dryRun ? null : await verifyFoods(rows);
  const after = await Food.countDocuments();

  const unitLine = Object.entries(s.unitCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([unit, n]) => `${unit} ${n}`)
    .join(' · ');

  logger.info(
    [
      '',
      '────────── FOOD MIGRATION (m_food ⋈ r_food_energy → foods) ──────────',
      `mode                       : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `run id                     : ${id}`,
      `source                     : ${migrationEnv.mysql.database} (${migrationEnv.foodTable} ⋈ ${migrationEnv.foodEnergyTable})`,
      '',
      '── source reconciliation (counted now) ──',
      `m_food rows                : ${sourceFoods}`,
      `r_food_energy rows         : ${sourceEnergy}`,
      `INNER JOIN rows            : ${joined}`,
      `foods without energy       : ${withoutEnergy.length}`,
      `  food_ids                 : ${ids(withoutEnergy)}`,
      `orphan energy rows         : ${orphanEnergy.length}`,
      `  food_ids                 : ${ids(orphanEnergy)}`,
      `deleted (delete_flg = 1)   : ${s.deleted.length}`,
      `  food_ids                 : ${s.deleted.length ? s.deleted.map((d) => d.foodId).join(', ') : 'none'}`,
      `invalid / unmappable       : ${s.invalid.length}`,
      `duplicate source food_ids  : ${s.duplicateSourceIds.length}`,
      '',
      '── migration ──',
      `eligible                   : ${s.eligible}`,
      `already migrated           : ${s.alreadyMigrated}`,
      `${dryRun ? 'would insert               ' : 'newly migrated             '}: ${dryRun ? s.toCreate : s.created}`,
      `failed                     : ${s.errors.length}`,
      `food type                  : Vegetarian ${s.counts.Vegetarian} · Non-Vegetarian ${s.counts['Non-Vegetarian']}`,
      `serving units              : ${unitLine || '-'}`,
      '',
      '── data quality (migrated anyway, reported not repaired) ──',
      `unit case corrected        : ${s.unitNormalised.length}${s.unitNormalised.length ? ` (${[...new Set(s.unitNormalised.map((u) => `${u.from} → ${u.to}`))].join(', ')})` : ''}`,
      `all-zero nutrition         : ${s.zeroNutrition.length}${s.zeroNutrition.length ? ` (food_ids ${s.zeroNutrition.map((z) => z.foodId).join(', ')})` : ''}`,
      `legacy image filenames     : ${s.withLegacyImageFileName} (image set to null: the files are not in the legacy database)`,
      '',
      'skipped - deleted in legacy:', ...rowsOf(s.deleted),
      'skipped - invalid:', ...rowsOf(s.invalid),
      'skipped - duplicate source food_id:', ...rowsOf(s.duplicateSourceIds),
      'failed:', ...rowsOf(s.errors),
      ...(verify
        ? [
            '',
            '── verification (independent re-read of MongoDB) ──',
            `foods in MongoDB           : ${before} before → ${after} after`,
            `migrated foods in MongoDB  : ${verify.migratedInMongo}`,
            `eligible legacy foods      : ${verify.eligibleCount}`,
            `eligible but missing       : ${verify.missing.length ? verify.missing.join(', ') : 'none'}`,
            `migrated but not eligible  : ${verify.notEligible.length ? verify.notEligible.join(', ') : 'none'}`,
            `duplicate legacy food ids  : ${verify.duplicateLegacyIds.length ? verify.duplicateLegacyIds.join(', ') : 'none'}`,
            `invariant problems         : ${verify.problems.length ? '' : 'none'}`,
            ...verify.problems.map((p) => `    ${p}`),
            `field mismatches vs legacy : ${verify.mismatches.length ? '' : 'none'}`,
            ...verify.mismatches.map((m) => `    ${m.foodId}: ${m.fields.join(', ')}`),
            `portal foods with legacy   : ${verify.portalFoodsWithLegacy}`,
            `migrated foods without image: ${verify.withoutImage}`,
          ]
        : []),
      columns.missing.length ? `\nlegacy columns ABSENT      : ${columns.missing.join(', ')}` : '',
      '─────────────────────────────────────────────────────────────────────',
    ]
      .filter((l) => l !== '')
      .join('\n'),
  );

  const report = {
    runId: id,
    dryRun,
    source: migrationEnv.source,
    database: migrationEnv.mysql.database,
    tables: { food: migrationEnv.foodTable, energy: migrationEnv.foodEnergyTable },
    sourceCounts: {
      food: sourceFoods,
      energy: sourceEnergy,
      joined,
      withoutEnergy: withoutEnergy.map((r) => r.food_id),
      orphanEnergy: orphanEnergy.map((r) => r.food_id),
    },
    before,
    after,
    summary: s,
    verify,
    finishedAt: new Date().toISOString(),
  };
  const file = await writeReport(report);
  logger.info(`report (incl. legacy food_id → Mongo _id map): ${file ?? 'migration/reports/runs'}`);
  return report;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('migrate-foods.js');
if (isEntryPoint) {
  const apply = process.argv.includes('--apply');
  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => Food.syncIndexes())
    .then(() => runFoodMigration({ apply }))
    .catch((error) => {
      logger.error(`Food migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runFoodMigration;
