/**
 * Migrates the legacy Free Diet Plan templates (m_plan + r_plan_meal) into the
 * FreeDietPlan collection.
 *
 *   npm run migrate:free-diet-plans            # dry run
 *   npm run migrate:free-diet-plans -- --apply # write
 *
 * MariaDB is read-only throughout (every statement goes through the guarded
 * query layer), and the production-database rail in assertMigrationEnv applies,
 * so this cannot touch production without MIGRATION_ALLOW_PRODUCTION=true.
 *
 * The migration is faithful: no meal or food is invented, no range recalculated,
 * no duplicate merged, no empty template dropped. Known legacy defects are
 * counted and printed at the end instead.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import FreeDietPlan from '../../src/models/free-diet-plan.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import {
  countPlanMeals,
  countPlans,
  extractPlanMeals,
  extractPlans,
  resolvePlanColumns,
} from '../extractors/plan.extractor.js';
import { loadFreeDietPlans } from '../loaders/free-diet-plan.loader.js';

const list = (values, limit = 20) => {
  const shown = values.slice(0, limit).join(', ');
  return values.length > limit ? `${shown} ...` : shown;
};

export const runFreeDietPlanMigration = async ({ apply = false, runId = null } = {}) => {
  const dryRun = !apply;
  const id = runId ?? `freediet-${new Date().toISOString()}-${randomUUID().slice(0, 6)}`;

  logger.info(
    `Free diet plan migration (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only]`,
  );

  const columns = await resolvePlanColumns();
  const [sourcePlanCount, sourceMealCount] = await Promise.all([countPlans(), countPlanMeals()]);
  const [planRows, mealRows] = await Promise.all([extractPlans(), extractPlanMeals()]);

  const summary = await loadFreeDietPlans(planRows, mealRows, { dryRun, runId: id });
  const q = summary.quality;

  logger.info(
    [
      '',
      '────────── FREE DIET PLAN MIGRATION ──────────',
      `mode                        : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `run id                      : ${id}`,
      `legacy source               : ${migrationEnv.source}`,
      `legacy database             : ${migrationEnv.mysql.database}`,
      `legacy tables               : ${migrationEnv.planTable}, ${migrationEnv.planMealTable}`,
      '',
      `Source m_plan rows          : ${sourcePlanCount}`,
      `Source r_plan_meal rows     : ${sourceMealCount}`,
      `Plans inspected             : ${summary.plansInspected}`,
      `Food rows inspected         : ${summary.mealRowsInspected}`,
      `Meals migrated              : ${summary.mealsMigrated}`,
      `Food rows migrated          : ${summary.foodsMigrated}`,
      '',
      `${dryRun ? 'Would create               ' : 'Created                    '} : ${dryRun ? summary.plansToCreate : summary.created}`,
      `${dryRun ? 'Would update               ' : 'Updated                    '} : ${dryRun ? summary.plansToUpdate : summary.updated}`,
      `Already migrated, unchanged : ${summary.plansUnchanged}`,
      `Skipped (no legacy plan id) : ${summary.skippedNoLegacyId.length}`,
      `Conflicts                   : ${summary.conflicts.length}`,
      `Errors                      : ${summary.errors.length}`,
      '',
      '── data quality (preserved as-is, never repaired) ──',
      `Empty templates (no foods)  : ${q.emptyPlans.length}${q.emptyPlans.length ? ` -> plan ${list(q.emptyPlans)}` : ''}`,
      `Templates with no meal 5    : ${q.plansMissingMeal5}`,
      `Templates under 5 meals     : ${q.plansMissingAnyMeal}`,
      `Duplicate diet type + range : ${q.duplicateBands.length}`,
      ...q.duplicateBands.map(
        (dup) => `    ${dup.dietType} ${dup.from}-${dup.to} -> plans ${dup.planIds.join(', ')}`,
      ),
      `Diet types off the dropdown : ${JSON.stringify(q.unknownDietTypes)}`,
      `Non-numeric calorie ranges  : ${q.nonNumericRange.length}`,
      `Blank food names            : ${q.blankFoodNames}`,
      `Food names trimmed only     : ${q.trimmedFoodNames}  (surrounding whitespace; values otherwise byte-identical)`,
      `Food rows with 0 calories   : ${q.zeroCalorieFoods}`,
      `Totals outside own band     : ${q.totalsOutsideBand.length}`,
      `Meals over the legacy 8-row cap : ${q.mealsOverLegacyRowCap.length}`,
      ...q.mealsOverLegacyRowCap.map(
        (meal) => `    plan ${meal.planId} meal ${meal.mealId}: ${meal.rows} rows`,
      ),
      `Orphan food rows (no plan)  : ${q.orphanMealRows.length}`,
      '',
      `Legacy columns present      : m_plan(${columns.plan.join(', ')})`,
      columns.planMissing.length > 0
        ? `Legacy columns ABSENT       : m_plan(${columns.planMissing.join(', ')})`
        : '',
      columns.planMealMissing.length > 0
        ? `Legacy columns ABSENT       : r_plan_meal(${columns.planMealMissing.join(', ')})`
        : '',
      '──────────────────────────────────────────────',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  if (summary.skippedNoLegacyId.length > 0) {
    logger.warn(
      `Rows without a usable plan_id were skipped (no migration identity): ${list(summary.skippedNoLegacyId)}`,
    );
  }
  if (summary.errors.length > 0) {
    for (const error of summary.errors.slice(0, 10)) logger.error(`  ${error}`);
  }

  // The gap the previous investigation found is a property of the source data,
  // not of this run - printed so it is not mistaken for a migration loss.
  logger.info(
    'Reminder: the legacy Veg/Egg band has a 2601-2700 gap and several bands overlap. Both are preserved verbatim.',
  );

  return summary;
};

const isEntryPoint =
  process.argv[1] && process.argv[1].endsWith('migrate-free-diet-plans.js');

if (isEntryPoint) {
  const apply = process.argv.includes('--apply');

  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => FreeDietPlan.syncIndexes())
    .then(() => runFreeDietPlanMigration({ apply }))
    .catch((error) => {
      logger.error(`Free diet plan migration failed: ${error.message}`);
      logger.debug(error.stack);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runFreeDietPlanMigration;
