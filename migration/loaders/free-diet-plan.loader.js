import FreeDietPlan, { DIET_TYPES, MEAL_IDS } from '../../src/models/free-diet-plan.model.js';
import { migrationEnv } from '../config/migration.env.js';
import { transformLegacyPlan } from '../transformers/plan.transformer.js';

/**
 * Loads legacy Free Diet Plan templates into MongoDB.
 *
 * Identity is (legacy.source, legacy.planId), backed by a partial unique index,
 * so a second run updates the same documents instead of creating a second copy.
 * A re-run rewrites the plan from source, which is what makes it idempotent: the
 * legacy edit path did exactly the same thing (delete every child row, re-insert).
 *
 * Nothing about the legacy data is repaired - see plan.transformer.js. Defects
 * are counted into `quality` and reported by the script.
 */
export const loadFreeDietPlans = async (
  planRows,
  mealRows,
  { dryRun = true, source = migrationEnv.source, runId = null, version = migrationEnv.version } = {},
) => {
  const summary = {
    plansInspected: planRows.length,
    mealRowsInspected: mealRows.length,
    plansToCreate: 0,
    plansToUpdate: 0,
    plansUnchanged: 0,
    mealsMigrated: 0,
    foodsMigrated: 0,
    created: 0,
    updated: 0,
    skippedNoLegacyId: [],
    conflicts: [],
    errors: [],
    quality: {
      emptyPlans: [],
      plansMissingMeal5: 0,
      plansMissingAnyMeal: 0,
      duplicateBands: [],
      unknownDietTypes: {},
      nonNumericRange: [],
      blankFoodNames: 0,
      // Food names whose only difference from the legacy value is surrounding
      // whitespace. Counted rather than left silent, since it is the one place
      // the migrated string is not byte-identical to the source.
      trimmedFoodNames: 0,
      zeroCalorieFoods: 0,
      totalsOutsideBand: [],
      orphanMealRows: [],
      mealsOverLegacyRowCap: [],
    },
  };

  // Group the food rows by plan once; extractPlanMeals already ordered them by
  // (plan_id, meal_id, food_id), and that order is preserved here.
  const mealsByPlan = new Map();
  for (const row of mealRows) {
    const planId = Number(row.plan_id);
    if (!mealsByPlan.has(planId)) mealsByPlan.set(planId, []);
    mealsByPlan.get(planId).push(row);
  }

  const legacyPlanIds = new Set(planRows.map((row) => Number(row.plan_id)));
  for (const planId of mealsByPlan.keys()) {
    if (!legacyPlanIds.has(planId)) summary.quality.orphanMealRows.push(planId);
  }

  const bandSeen = new Map();
  const documents = [];

  for (const planRow of planRows) {
    const rows = mealsByPlan.get(Number(planRow.plan_id)) ?? [];
    const doc = transformLegacyPlan(planRow, rows, { source });

    if (doc.legacy.planId === null) {
      // Without a legacy id there is no migration identity, so a re-run could
      // not recognise the document. Reported, never guessed at.
      summary.skippedNoLegacyId.push(planRow.plan_id ?? null);
      continue;
    }

    // ---- data-quality accounting (report only, nothing is changed) ----
    const foodCount = doc.meals.reduce((sum, meal) => sum + meal.foods.length, 0);
    if (doc.meals.length === 0) summary.quality.emptyPlans.push(doc.legacy.planId);
    if (!doc.meals.some((meal) => meal.mealId === 5)) summary.quality.plansMissingMeal5 += 1;
    if (doc.meals.length < MEAL_IDS.length) summary.quality.plansMissingAnyMeal += 1;
    if (!DIET_TYPES.includes(doc.dietType)) {
      const key = doc.dietType === '' ? '(blank)' : doc.dietType;
      summary.quality.unknownDietTypes[key] = (summary.quality.unknownDietTypes[key] ?? 0) + 1;
    }
    if (doc.range.from === null || doc.range.to === null) {
      summary.quality.nonNumericRange.push(doc.legacy.planId);
    }
    for (const meal of doc.meals) {
      // The legacy add/edit grid refused a 9th row; one migrated meal has 12.
      if (meal.foods.length > 8) {
        summary.quality.mealsOverLegacyRowCap.push({
          planId: doc.legacy.planId,
          mealId: meal.mealId,
          rows: meal.foods.length,
        });
      }
      for (const food of meal.foods) {
        if (food.foodName === '') summary.quality.blankFoodNames += 1;
        if ((food.calories ?? 0) <= 0) summary.quality.zeroCalorieFoods += 1;
      }
    }
    for (const row of rows) {
      const raw = row.food_name;
      if (typeof raw === 'string' && raw !== raw.trim()) summary.quality.trimmedFoodNames += 1;
    }
    const calories = doc.meals.reduce(
      (sum, meal) => sum + meal.foods.reduce((inner, food) => inner + (food.calories ?? 0), 0),
      0,
    );
    if (
      foodCount > 0 &&
      doc.range.from !== null &&
      doc.range.to !== null &&
      (calories < doc.range.from || calories > doc.range.to)
    ) {
      summary.quality.totalsOutsideBand.push({
        planId: doc.legacy.planId,
        calories: Number(calories.toFixed(4)),
        from: doc.range.from,
        to: doc.range.to,
      });
    }

    const bandKey = `${doc.dietType}|${doc.range.from}|${doc.range.to}`;
    if (bandSeen.has(bandKey)) {
      // Preserved, not merged: both templates are migrated as separate documents.
      summary.quality.duplicateBands.push({
        dietType: doc.dietType,
        from: doc.range.from,
        to: doc.range.to,
        planIds: [bandSeen.get(bandKey), doc.legacy.planId],
      });
    } else {
      bandSeen.set(bandKey, doc.legacy.planId);
    }

    summary.mealsMigrated += doc.meals.length;
    summary.foodsMigrated += foodCount;
    documents.push(doc);
  }

  // Which legacy plans already exist, so the run can report create vs update.
  const existing = await FreeDietPlan.collection
    .find(
      {
        'legacy.source': source,
        'legacy.planId': { $in: documents.map((doc) => doc.legacy.planId) },
      },
      { projection: { _id: 1, 'legacy.planId': 1, dietType: 1, range: 1, meals: 1, status: 1 } },
    )
    .toArray();

  const byLegacyId = new Map(existing.map((doc) => [doc.legacy.planId, doc]));
  const operations = [];

  for (const doc of documents) {
    const current = byLegacyId.get(doc.legacy.planId);

    if (!current) {
      summary.plansToCreate += 1;
    } else if (isSameContent(current, doc)) {
      summary.plansUnchanged += 1;
      continue;
    } else {
      summary.plansToUpdate += 1;
    }

    operations.push({
      updateOne: {
        filter: { 'legacy.source': source, 'legacy.planId': doc.legacy.planId },
        update: {
          $set: {
            dietType: doc.dietType,
            range: doc.range,
            meals: doc.meals,
            legacy: doc.legacy,
            migration: { runId, migratedAt: new Date(), version },
          },
          // Only on insert: an administrator may have archived a template since
          // the last run, and a re-run must not quietly bring it back.
          $setOnInsert: { status: doc.status, createdBy: null, updatedBy: null },
        },
        upsert: true,
      },
    });
  }

  if (dryRun || operations.length === 0) return summary;

  try {
    const result = await FreeDietPlan.collection.bulkWrite(operations, { ordered: false });
    summary.created = result.upsertedCount ?? 0;
    summary.updated = result.modifiedCount ?? 0;
  } catch (error) {
    for (const writeError of error.writeErrors || []) {
      const detail = writeError.err || writeError;
      summary.errors.push(detail.errmsg || detail.message || String(writeError));
    }
    if (!error.writeErrors) throw error;
  }

  return summary;
};

/**
 * Whether the stored document already matches the source, so an unchanged plan
 * is not rewritten on every run (keeping updatedAt and the migration stamp
 * stable, and making a second run a genuine no-op).
 */
const isSameContent = (current, next) => {
  if (current.dietType !== next.dietType) return false;
  if ((current.range?.from ?? null) !== next.range.from) return false;
  if ((current.range?.to ?? null) !== next.range.to) return false;

  const a = current.meals ?? [];
  if (a.length !== next.meals.length) return false;

  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = next.meals[i];
    if (left.mealId !== right.mealId) return false;

    const leftFoods = left.foods ?? [];
    if (leftFoods.length !== right.foods.length) return false;

    for (let j = 0; j < leftFoods.length; j += 1) {
      const lf = leftFoods[j];
      const rf = right.foods[j];
      for (const key of [
        'legacyPlanMealId',
        'foodName',
        'foodType',
        'unit',
        'quantity',
        'calories',
        'fat',
        'carbs',
        'protein',
      ]) {
        if ((lf[key] ?? null) !== (rf[key] ?? null)) return false;
      }
    }
  }

  return true;
};

export default loadFreeDietPlans;
