import { query } from '../config/mariadb.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Read-only extraction of the legacy Free Diet Plan templates: m_plan and its
 * r_plan_meal children.
 *
 * Column lists mirror what the legacy Admin Portal actually used (GGF.DAL/DietDAL.cs)
 * plus the audit columns, so the migrated document can carry the original
 * create/update trail. Nothing outside these two tables is touched.
 */

export const PLAN_COLUMNS = [
  'plan_id',
  'diet_type',
  'range_from',
  'range_to',
  'create_date',
  'created_by',
  'last_update_date',
  'last_update_by',
];

export const PLAN_MEAL_COLUMNS = [
  'food_id',
  'plan_id',
  'meal_id',
  'food_name',
  'food_type',
  'unit',
  'qty',
  'calories',
  'fat',
  'carbs',
  'protein',
  'create_date',
  'created_by',
  'last_update_date',
  'last_update_by',
];

const describe = async (table) => {
  const rows = await query('SHOW COLUMNS FROM ??', [table]);
  return new Set(rows.map((row) => row.Field));
};

/** Which of the wanted columns the live tables actually have. */
export const resolvePlanColumns = async ({
  planTable = migrationEnv.planTable,
  planMealTable = migrationEnv.planMealTable,
} = {}) => {
  const [planAvailable, mealAvailable] = await Promise.all([
    describe(planTable),
    describe(planMealTable),
  ]);

  if (!planAvailable.has('plan_id')) {
    throw new Error(`Legacy table "${planTable}" has no plan_id column; cannot migrate plans`);
  }
  if (!mealAvailable.has('plan_id') || !mealAvailable.has('meal_id')) {
    throw new Error(`Legacy table "${planMealTable}" has no plan_id/meal_id column`);
  }

  return {
    plan: PLAN_COLUMNS.filter((column) => planAvailable.has(column)),
    planMissing: PLAN_COLUMNS.filter((column) => !planAvailable.has(column)),
    planMeal: PLAN_MEAL_COLUMNS.filter((column) => mealAvailable.has(column)),
    planMealMissing: PLAN_MEAL_COLUMNS.filter((column) => !mealAvailable.has(column)),
  };
};

export const countPlans = async (table = migrationEnv.planTable) => {
  const rows = await query('SELECT COUNT(*) AS total FROM ??', [table]);
  return Number(rows[0].total);
};

export const countPlanMeals = async (table = migrationEnv.planMealTable) => {
  const rows = await query('SELECT COUNT(*) AS total FROM ??', [table]);
  return Number(rows[0].total);
};

/** Every template row, ordered by plan_id so a run is reproducible. */
export const extractPlans = async (options = {}) => {
  const table = options.planTable ?? migrationEnv.planTable;
  const { plan } = await resolvePlanColumns(options);

  return query('SELECT ?? FROM ?? ORDER BY plan_id ASC', [plan, table]);
};

/**
 * Every food row, ordered by (plan_id, meal_id, food_id).
 *
 * food_id is r_plan_meal's own auto-increment primary key and the legacy read
 * (DietDAL.GetFoodList) had no ORDER BY at all, so primary-key order is the
 * order the admin saw in the grid. Ordering by it here is what preserves the
 * authored food order.
 */
export const extractPlanMeals = async (options = {}) => {
  const table = options.planMealTable ?? migrationEnv.planMealTable;
  const { planMeal } = await resolvePlanColumns(options);

  return query('SELECT ?? FROM ?? ORDER BY plan_id ASC, meal_id ASC, food_id ASC', [
    planMeal,
    table,
  ]);
};

export default { extractPlans, extractPlanMeals, resolvePlanColumns };
