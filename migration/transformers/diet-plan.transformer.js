import { canonicalFoodUnit } from '../../src/models/food.model.js';
import { startOfBusinessDay } from '../../src/utils/business-date.js';

/**
 * Legacy coach diet plan -> DietPlan documents (pure; no database access).
 * See docs/diet-plans-design.md for every rule below.
 *
 *   - one document per contiguous run of assigned days, further split where an
 *     enrollment window starts or ends, so no document covers a day the plan
 *     was not assigned to and each document has at most one enrollment;
 *   - all documents of a plan share planId "<source>:<diet_plan_id>", content
 *     and assignedAt (legacy create_date), which is the precedence key;
 *   - nutrition is the meal row's snapshot, never recalculated; `portion` is the
 *     legacy display divisor CAST(m_food.qty AS INT) and `servingUnit` the food's
 *     unit, frozen with it;
 *   - nothing is guessed: an unresolved reference blocks the plan with a reason.
 */

const DAY_MS = 86_400_000;
const IST_OFFSET = '+05:30';

export const NOT_MIGRATED_NO_DATES = 'not_migrated_no_dates';
export const BLOCKED_MISSING_USER = 'blocked_missing_user';
export const BLOCKED_MISSING_FOOD = 'blocked_missing_food';
export const BLOCKED_FOOD_SNAPSHOT = 'blocked_food_snapshot_mismatch';
export const BLOCKED_AMBIGUOUS_ENROLLMENT = 'blocked_ambiguous_enrollment';
export const BLOCKED_INVALID = 'blocked_invalid_data';

export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** A legacy IST wall-clock datetime ("2024-06-23 20:16:07") as an instant. */
export const legacyInstant = (value) => {
  if (value == null || value === '') return null;
  const text = String(value).trim().replace(' ', 'T');
  const date = new Date(`${text}${IST_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Distinct days, ascending, grouped into maximal runs of consecutive days. */
export const dateRuns = (days) => {
  const sorted = [...new Set(days)].sort();
  const runs = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDays(last.to, 1) === day) last.to = day;
    else runs.push({ from: day, to: day });
  }
  return runs;
};

/**
 * The enrollment for one day. `enrollments` are the client's windows as
 * { id, from, to, legacyCoachId } in IST days. One covering window wins; several
 * are narrowed to the one whose legacy coach authored the plan; anything else
 * is ambiguous. No window -> null (legacy plans were user/date driven).
 */
export const enrollmentForDay = (day, enrollments, creatorLegacyCoachId) => {
  const covering = enrollments.filter((e) => e.from <= day && day <= e.to);
  if (covering.length === 0) return { id: null };
  if (covering.length === 1) return { id: covering[0].id };
  const byCreator = creatorLegacyCoachId == null ? [] : covering.filter((e) => e.legacyCoachId === creatorLegacyCoachId);
  if (byCreator.length === 1) return { id: byCreator[0].id, resolvedBy: 'creator_coach' };
  return { ambiguous: covering.map((e) => String(e.id)) };
};

/** Splits a run wherever the day's enrollment changes. */
export const splitRunByEnrollment = (run, enrollments, creatorLegacyCoachId) => {
  const parts = [];
  for (let day = run.from; day <= run.to; day = addDays(day, 1)) {
    const hit = enrollmentForDay(day, enrollments, creatorLegacyCoachId);
    const key = hit.ambiguous ? `?${hit.ambiguous.join('+')}` : String(hit.id);
    const last = parts[parts.length - 1];
    if (last && last.key === key) last.to = day;
    else parts.push({ from: day, to: day, key, enrollmentId: hit.ambiguous ? null : hit.id, ambiguous: hit.ambiguous ?? null, resolvedBy: hit.resolvedBy ?? null });
  }
  return parts;
};

/**
 * Meal rows (already in legacy display order) -> meals[]. `foods` maps a legacy
 * food_id to { _id, servingUnit, servingQuantity } of the migrated Food.
 */
export const buildMeals = (rows, foods) => {
  const problems = [];
  const meals = [];
  for (const row of rows) {
    const where = { mealId: Number(row.meal_id), foodId: Number(row.food_id) };
    const food = foods.get(Number(row.food_id));
    if (!food) {
      problems.push({ code: BLOCKED_MISSING_FOOD, ...where, reason: `legacy food_id ${row.food_id} has no Mongo Food` });
      continue;
    }
    const portion = Number(row.originalqty);
    const servingUnit = canonicalFoodUnit(row.unit);
    if (!(portion > 0)) problems.push({ code: BLOCKED_FOOD_SNAPSHOT, ...where, reason: `display divisor CAST(qty AS INT) is ${row.originalqty}` });
    if (servingUnit === null) problems.push({ code: BLOCKED_FOOD_SNAPSHOT, ...where, reason: `legacy unit "${row.unit}" is not a supported unit` });
    // The Food was migrated from the same m_food row; a disagreement means one of them is wrong.
    if (portion !== food.servingQuantity) problems.push({ code: BLOCKED_FOOD_SNAPSHOT, ...where, reason: `divisor ${portion} != Food.servingQuantity ${food.servingQuantity}` });
    if (servingUnit !== null && servingUnit !== food.servingUnit) problems.push({ code: BLOCKED_FOOD_SNAPSHOT, ...where, reason: `unit ${servingUnit} != Food.servingUnit ${food.servingUnit}` });

    const values = { qty: Number(row.quantity), calories: Number(row.calories), fat: Number(row.fats), carbs: Number(row.carbs), protein: Number(row.proteins) };
    for (const [key, value] of Object.entries(values)) {
      if (!Number.isFinite(value) || value < 0) problems.push({ code: BLOCKED_INVALID, ...where, reason: `${key} is ${value}` });
    }

    let meal = meals[meals.length - 1];
    if (!meal || meal.meal !== where.mealId) {
      meal = { meal: where.mealId, foods: [] };
      meals.push(meal);
    }
    meal.foods.push({ foodId: food._id, qty: values.qty, portion, servingUnit, calories: values.calories, fat: values.fat, carbs: values.carbs, protein: values.protein });
  }
  return { meals, problems };
};

/**
 * One legacy plan -> { status, reasons, documents }.
 *
 * @param plan        m_diet_plan row
 * @param ctx.days    the plan's assigned days (yyyy-mm-dd, duplicates allowed)
 * @param ctx.mealRows the plan's visible meal rows, in display order
 * @param ctx.clientId Mongo User _id of the owner, or null
 * @param ctx.coachId  verified Coach _id, or null
 * @param ctx.creatorLegacyCoachId m_coach.coach_id of the author, or null
 * @param ctx.enrollments the owner's windows (see enrollmentForDay)
 * @param ctx.foods    legacy food_id -> Food reference
 */
export const transformDietPlan = (plan, ctx) => {
  const { source, runId = null, version = null, migratedAt = null } = ctx;
  const id = Number(plan.diet_plan_id);
  const reasons = [];

  const runs = dateRuns(ctx.days ?? []);
  if (runs.length === 0) return { planId: id, status: NOT_MIGRATED_NO_DATES, reasons: ['no assigned dates'], documents: [] };

  if (!ctx.clientId) reasons.push({ code: BLOCKED_MISSING_USER, reason: `legacy user ${plan.user_id} has no Mongo User` });

  const assignedAt = legacyInstant(plan.create_date);
  if (!assignedAt) reasons.push({ code: BLOCKED_INVALID, reason: 'create_date is missing: precedence is undefined' });

  const { meals, problems } = buildMeals(ctx.mealRows ?? [], ctx.foods);
  reasons.push(...problems);

  const parts = runs.flatMap((run) => splitRunByEnrollment(run, ctx.enrollments ?? [], ctx.creatorLegacyCoachId ?? null));
  for (const part of parts.filter((p) => p.ambiguous)) {
    reasons.push({ code: BLOCKED_AMBIGUOUS_ENROLLMENT, reason: `${part.from}..${part.to} is inside enrollments ${part.ambiguous.join(', ')}` });
  }

  if (reasons.length > 0) {
    return { planId: id, status: reasons[0].code, reasons, documents: [] };
  }

  const legacyBase = {
    source,
    dietPlanId: id,
    createdBy: plan.created_by == null ? null : Number(plan.created_by),
    createDate: assignedAt,
    lastUpdateDate: legacyInstant(plan.last_update_date),
  };
  const documents = parts.map((part, index) => ({
    planId: `${source}:${id}`,
    clientId: ctx.clientId,
    enrollmentId: part.enrollmentId,
    coachId: ctx.coachId ?? null,
    name: plan.diet_plan_name,
    fromDate: startOfBusinessDay(part.from),
    toDate: startOfBusinessDay(part.to),
    assignedAt,
    bmr: plan.bmr == null ? null : Number(plan.bmr),
    tdee: plan.tdee == null ? null : Number(plan.tdee),
    goal: plan.goal ?? null,
    targets: {
      calories: Number(plan.total_calories),
      fat: Number(plan.fat),
      carbs: Number(plan.carbs),
      protein: Number(plan.protein),
    },
    meals: meals.map((m) => ({ meal: m.meal, foods: m.foods.map((f) => ({ ...f })) })),
    status: 'active',
    legacy: { ...legacyBase, segment: { index, of: parts.length } },
    migration: { runId, migratedAt, version },
    createdBy: null,
    updatedBy: null,
  }));

  return {
    planId: id,
    status: 'migratable',
    reasons: [],
    days: runs.reduce((n, r) => n + Math.round((Date.parse(r.to) - Date.parse(r.from)) / DAY_MS) + 1, 0),
    runs: runs.length,
    enrollmentResolvedByCreator: parts.some((p) => p.resolvedBy === 'creator_coach'),
    documents,
  };
};

export default transformDietPlan;
