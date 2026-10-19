/**
 * Migrates the legacy coach-assigned diet plans (m_diet_plan + r_diet_plan_meal
 * + r_diet_plan_dates) into dietplans. See docs/diet-plans-design.md.
 *
 *   npm run migrate:diet-plans              # dry run: transform, validate, replay - writes nothing
 *   npm run migrate:diet-plans -- --apply   # write (only after an approved dry run)
 *
 * DEVELOPMENT ONLY (migration/config/dev-target.js) on top of the production
 * legacy-database rail. MariaDB is read through the read-only pool.
 *
 * The dry run replays the legacy runtime for every day of every migratable
 * client - the verbatim GetDietPlanDetails and GetDietPlanMeals queries - and
 * compares what the member saw with what the new day lookup would return.
 * --apply refuses to write unless that replay has zero mismatches.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import DietPlan from '../../src/models/diet-plan.model.js';
import { closePool } from '../config/mariadb.js';
import { assertDevelopmentConnection, assertDevelopmentTarget } from '../config/dev-target.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import {
  extractDietPlanDates,
  extractDietPlans,
  extractHiddenMealRows,
  extractLegacyCoaches,
  extractLegacyUsers,
  extractVisibleMealRows,
  legacyAppDate,
  legacyMealsSql,
  legacySelectSql,
  read,
} from '../extractors/diet-plan.extractor.js';
import { applyDietPlans, buildReferences, gateByClient, replay, transformAll, validateDocuments, verifyPlanFields } from '../loaders/diet-plan.loader.js';
import { legacyInstant } from '../transformers/diet-plan.transformer.js';
import { writeReport } from '../reports/migration-report.js';

const LABEL = 'migrate diet plans';
const ids = (list) => (list.length ? list.join(', ') : 'none');

export const runDietPlanMigration = async ({ apply = false, runId = null } = {}) => {
  const dryRun = !apply;
  const target = assertDevelopmentConnection(undefined, LABEL);
  const id = runId ?? `diet-plans-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  const source = migrationEnv.source;
  logger.info(`Diet plan migration (${dryRun ? 'DRY RUN' : 'APPLY'}) ${describeMysqlTarget()} [read-only] -> ${target.host}/${target.database}`);

  const plans = await extractDietPlans();
  const dateRows = await extractDietPlanDates();
  const mealRows = await extractVisibleMealRows();
  const hidden = await extractHiddenMealRows();
  const personIds = [...new Set(plans.flatMap((p) => [Number(p.user_id), Number(p.created_by)]))];
  const legacyUsers = await extractLegacyUsers(personIds);
  const legacyCoaches = await extractLegacyCoaches();
  const nonMidnight = dateRows.filter((r) => r.time !== '00:00:00');
  if (nonMidnight.length > 0) throw new Error(`${nonMidnight.length} diet_date value(s) are not midnight; the date-only rule does not hold`);

  const refs = await buildReferences({ plans, legacyUsers, legacyCoaches, foodIds: [...new Set(mealRows.map((r) => Number(r.food_id)))], source });
  const results = gateByClient(
    transformAll({ plans, dateRows, mealRows, refs, source, runId: id, version: migrationEnv.version, migratedAt: dryRun ? null : new Date() }),
  );
  const migratable = results.filter((r) => r.status === 'migratable');
  const documents = migratable.flatMap((r) => r.documents);
  const validationErrors = await validateDocuments(documents);
  const planFields = verifyPlanFields(documents, plans, { legacyInstant });

  // Replay every day of every client whose plans are all migratable.
  const clientIds = new Map(migratable.map((r) => [r.legacyUserId, r.documents[0].clientId]));
  const daysByClient = new Map();
  for (const r of dateRows) {
    const plan = plans.find((p) => Number(p.diet_plan_id) === Number(r.diet_plan_id));
    const userId = Number(plan.user_id);
    if (!clientIds.has(userId)) continue;
    if (!daysByClient.has(userId)) daysByClient.set(userId, []);
    daysByClient.get(userId).push(r.day);
  }
  const foodLegacyId = new Map([...refs.foods].map(([legacyId, f]) => [String(f._id), legacyId]));
  const replayResult = await replay({
    documents,
    clients: [...daysByClient].map(([legacyUserId, days]) => ({ legacyUserId, clientId: clientIds.get(legacyUserId), days })),
    legacySelect: async (userId, day) => (await read(legacySelectSql(userId, legacyAppDate(day))))[0] ?? null,
    legacyMeals: async (dietPlanId) => {
      const meals = [];
      for (let mealId = 1; mealId < 9; mealId += 1) meals.push({ mealId, foods: await read(legacyMealsSql(dietPlanId, mealId)) });
      return meals;
    },
    foodLegacyId,
  });

  const byStatus = {};
  for (const r of results) (byStatus[r.status] ??= []).push(r.planId);
  const coachStats = { verified: documents.filter((d) => d.coachId).length, none: documents.filter((d) => !d.coachId).length };
  const enrollmentStats = { linked: documents.filter((d) => d.enrollmentId).length, none: documents.filter((d) => !d.enrollmentId).length };
  const foodAssignments = documents.reduce((n, d) => n + d.meals.reduce((m, meal) => m + meal.foods.length, 0), 0);
  const planMeals = migratable.reduce((n, r) => n + r.documents[0].meals.length, 0);
  const planFoods = migratable.reduce((n, r) => n + r.documents[0].meals.reduce((m, meal) => m + meal.foods.length, 0), 0);
  const ready = validationErrors.length === 0 && planFields.mismatches.length === 0 && replayResult.mismatches.length === 0;

  let applied = null;
  if (!dryRun) {
    if (!ready) throw new Error('Refusing to apply: the dry-run checks did not pass (validation errors, plan-field mismatches or replay mismatches)');
    await DietPlan.syncIndexes();
    applied = await applyDietPlans(documents);
  }

  logger.info(
    [
      '',
      '────────── COACH DIET PLANS (m_diet_plan → dietplans) ──────────',
      `mode                        : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `run id                      : ${id}`,
      `legacy plans / meal rows / date rows : ${plans.length} / ${mealRows.length} visible (+${hidden.length} never shown) / ${dateRows.length}`,
      `plans with assigned dates   : ${results.filter((r) => r.status !== 'not_migrated_no_dates').length}`,
      ...Object.entries(byStatus).map(([status, list]) => `${status.padEnd(28)}: ${list.length}${status === 'migratable' ? '' : `  [${ids(list)}]`}`),
      `documents (date runs)       : ${documents.length}`,
      `meals / food assignments    : ${planMeals} / ${planFoods} per plan; ${foodAssignments} across all documents`,
      `coachId verified / null     : ${coachStats.verified} / ${coachStats.none}`,
      `enrollmentId linked / null  : ${enrollmentStats.linked} / ${enrollmentStats.none}`,
      `schema validation errors    : ${validationErrors.length}`,
      '',
      '── plan-level fields vs m_diet_plan (every document) ──',
      ...Object.entries(planFields.checked).map(([f, n]) => `${f.padEnd(42)}: ${n} checked`),
      `plan-field mismatches       : ${planFields.mismatches.length}`,
      ...planFields.mismatches.slice(0, 30).map((m) => `    plan ${m.dietPlanId}#${m.segment} ${m.field}: legacy ${JSON.stringify(m.legacy)} / new ${JSON.stringify(m.mongo)}`),
      '',
      '── replay vs legacy runtime ──',
      `client-days compared        : ${replayResult.days} (${replayResult.assignedDays} with a plan, ${replayResult.emptyDays} without)`,
      `food assignments compared   : ${replayResult.foodsCompared}`,
      `mismatches                  : ${replayResult.mismatches.length}`,
      ...replayResult.mismatches.slice(0, 30).map((m) => `    user ${m.legacyUserId} ${m.day} ${m.field}: legacy ${JSON.stringify(m.legacy)} / new ${JSON.stringify(m.mongo)}`),
      ...(applied ? ['', `created ${applied.created}, unchanged ${applied.unchanged}, conflicts ${applied.conflicts.length}, segment-count changes ${applied.segmentCountChanged.length}`] : []),
      `RESULT                      : ${ready ? (dryRun ? 'DRY RUN PASS' : 'APPLIED') : 'BLOCKED'}`,
      '────────────────────────────────────────────────────────────────',
    ].join('\n'),
  );

  const report = {
    runId: id,
    dryRun,
    target,
    counts: { plans: plans.length, visibleMealRows: mealRows.length, hiddenMealRows: hidden.length, dateRows: dateRows.length },
    byStatus,
    plans: results.map(({ documents: docs, ...r }) => ({ ...r, documentCount: docs.length })),
    documents,
    validationErrors,
    planFields,
    replay: replayResult,
    hiddenMealRows: hidden,
    applied,
    ready,
    finishedAt: new Date().toISOString(),
  };
  logger.info(`report: ${await writeReport(report)}`);
  return report;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('migrate-diet-plans.js');
if (isEntryPoint) {
  const apply = process.argv.includes('--apply');
  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => assertDevelopmentTarget(process.env, LABEL))
    // No implicit collection or index creation: a dry run must leave MongoDB exactly as it was.
    .then(() => mongoose.connect(process.env.MONGODB_URI, { autoCreate: false, autoIndex: false }))
    .then(() => runDietPlanMigration({ apply }))
    .catch((error) => {
      logger.error(`Diet plan migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runDietPlanMigration;
