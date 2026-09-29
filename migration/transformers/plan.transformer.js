/**
 * Maps legacy m_plan + r_plan_meal onto the FreeDietPlan document.
 *
 * Fidelity first. The legacy data is known to contain defects - 5 templates with
 * no food rows, three exact duplicate (diet_type, range) triples, two rows whose
 * diet type is the literal dropdown placeholder "Select", a 2601-2700 gap in
 * Veg/Egg, 504 templates with no meal 5, and 71 whose food calories fall outside
 * their own declared band. None of them are corrected here: nothing is invented,
 * recalculated, merged, moved or dropped. The defects are counted and reported
 * by the loader so they stay visible.
 */

/**
 * Legacy range_from/range_to are varchar(45). Every one of the 777 staging rows
 * is a plain integer string, so they are stored as numbers; anything that is not
 * numeric is preserved as null and reported rather than guessed at.
 */
export const transformNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;

  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const text = (value) => {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
};

/** One r_plan_meal row as a stored food entry. */
export const transformPlanFood = (row) => ({
  // r_plan_meal.food_id: that table's own primary key, NOT m_food.food_id. The
  // legacy insert never wrote a food reference, so this links to nothing.
  legacyPlanMealId: transformNumber(row.food_id),
  // Kept even when blank so a row is never silently dropped; the loader counts
  // blank names as a data-quality finding instead.
  foodName: text(row.food_name) ?? '',
  // char(1), empty in every legacy row - stored as null rather than "".
  foodType: text(row.food_type),
  unit: text(row.unit)?.toLowerCase() ?? null,
  quantity: transformNumber(row.qty),
  calories: transformNumber(row.calories),
  fat: transformNumber(row.fat),
  carbs: transformNumber(row.carbs),
  protein: transformNumber(row.protein),
});

const toDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Builds one FreeDietPlan from its m_plan row plus the r_plan_meal rows that
 * belong to it. `mealRows` must already be in (meal_id, food_id) order - that
 * order is the authored order and is what gets stored.
 *
 * Meals are grouped in ascending meal_id, and a meal with no rows produces no
 * entry: the legacy plan genuinely has no meal 5 in 504 cases, and writing an
 * empty meal 5 would be inventing structure the source does not have.
 */
export const transformLegacyPlan = (planRow, mealRows = [], { source }) => {
  const byMeal = new Map();
  for (const row of mealRows) {
    const mealId = transformNumber(row.meal_id);
    if (mealId === null) continue;
    if (!byMeal.has(mealId)) byMeal.set(mealId, []);
    byMeal.get(mealId).push(transformPlanFood(row));
  }

  const meals = [...byMeal.keys()]
    .sort((a, b) => a - b)
    .map((mealId) => ({ mealId, foods: byMeal.get(mealId) }));

  return {
    // diet_type carried across verbatim, including the "Select" placeholder.
    dietType: text(planRow.diet_type) ?? '',
    range: {
      from: transformNumber(planRow.range_from),
      to: transformNumber(planRow.range_to),
    },
    meals,
    // Every migrated template starts active; the legacy table had no status.
    status: 'active',
    legacy: {
      source,
      planId: transformNumber(planRow.plan_id),
      createdAt: toDate(planRow.create_date),
      createdBy: text(planRow.created_by),
      updatedAt: toDate(planRow.last_update_date),
      updatedBy: text(planRow.last_update_by),
    },
  };
};

export default transformLegacyPlan;
