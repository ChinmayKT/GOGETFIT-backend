import {
  DIET_TYPES,
  FOOD_UNITS,
  MEAL_IDS,
  PLAN_STATUSES,
} from '../models/free-diet-plan.model.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * Backend-owned validation for the Free Diet Plan admin API.
 *
 * Deliberately stricter than the legacy Admin Portal, which validated almost
 * nothing server-side (it concatenated form values straight into SQL) - but only
 * where the stricter rule cannot make existing migrated data impossible to edit:
 *
 *   - no cap on food rows per meal. The legacy UI stopped at 8, yet one migrated
 *     meal holds 12, so a cap of 8 would lock that plan out of its own edit form.
 *   - calories may be 0: 457 migrated rows are.
 *   - "Select" is rejected as a diet type for writes, though 2 migrated plans
 *     carry it; those rows stay readable and only need a real type on the way out.
 */

/** A defensive ceiling only - see the note above about the legacy 8-row cap. */
const MAX_FOODS_PER_MEAL = 50;
const MAX_FOOD_NAME = 45; // legacy r_plan_meal.food_name is varchar(45)
const MAX_CALORIE_BAND = 20000;

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const integerIn = (value, { min, max, label }) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a number`);
  if (!Number.isInteger(value)) fail(`${label} must be a whole number`);
  if (value < min || value > max) fail(`${label} must be between ${min} and ${max}`);
  return value;
};

const nonNegative = (value, label) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a number or null`);
  if (value < 0) fail(`${label} cannot be negative`);
  return value;
};

const validateFood = (value, where) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }

  const name = typeof value.foodName === 'string' ? value.foodName.trim() : '';
  if (name === '') fail(`${where}.foodName is required`);
  if (name.length > MAX_FOOD_NAME) {
    fail(`${where}.foodName must be at most ${MAX_FOOD_NAME} characters`);
  }

  let unit = null;
  if (value.unit !== undefined && value.unit !== null && value.unit !== '') {
    if (typeof value.unit !== 'string') fail(`${where}.unit must be a string`);
    unit = value.unit.trim().toLowerCase();
    if (!FOOD_UNITS.includes(unit)) {
      fail(`${where}.unit must be one of: ${FOOD_UNITS.join(', ')}`);
    }
  }

  let quantity = null;
  if (value.quantity !== undefined && value.quantity !== null) {
    if (typeof value.quantity !== 'number' || !Number.isFinite(value.quantity)) {
      fail(`${where}.quantity must be a number`);
    }
    if (value.quantity <= 0) fail(`${where}.quantity must be greater than 0`);
    quantity = value.quantity;
  }

  return {
    foodName: name,
    foodType:
      typeof value.foodType === 'string' && value.foodType.trim() !== ''
        ? value.foodType.trim()
        : null,
    unit,
    quantity,
    calories: nonNegative(value.calories, `${where}.calories`),
    fat: nonNegative(value.fat, `${where}.fat`),
    carbs: nonNegative(value.carbs, `${where}.carbs`),
    protein: nonNegative(value.protein, `${where}.protein`),
  };
};

/**
 * Meals are validated as a whole: a write replaces the meal set, which is
 * exactly what the legacy edit did (DELETE every r_plan_meal row for the plan,
 * then re-insert). Ordering is taken from the payload and preserved.
 */
const validateMeals = (value) => {
  if (!Array.isArray(value)) fail('meals must be an array');
  if (value.length > MEAL_IDS.length) fail(`meals may contain at most ${MEAL_IDS.length} entries`);

  const seen = new Set();

  return value.map((meal, index) => {
    const where = `meals[${index}]`;
    if (meal === null || typeof meal !== 'object' || Array.isArray(meal)) {
      fail(`${where} must be an object`);
    }

    const mealId = integerIn(meal.mealId, { min: 1, max: MEAL_IDS.length, label: `${where}.mealId` });
    if (seen.has(mealId)) fail(`${where}.mealId ${mealId} is duplicated`);
    seen.add(mealId);

    const foods = meal.foods === undefined || meal.foods === null ? [] : meal.foods;
    if (!Array.isArray(foods)) fail(`${where}.foods must be an array`);
    if (foods.length > MAX_FOODS_PER_MEAL) {
      fail(`${where}.foods may contain at most ${MAX_FOODS_PER_MEAL} rows`);
    }

    return {
      mealId,
      foods: foods.map((food, foodIndex) => validateFood(food, `${where}.foods[${foodIndex}]`)),
    };
  });
};

const validateRange = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('range must be an object with from and to');
  }

  const from = integerIn(value.from, { min: 1, max: MAX_CALORIE_BAND, label: 'range.from' });
  const to = integerIn(value.to, { min: 1, max: MAX_CALORIE_BAND, label: 'range.to' });
  if (from >= to) fail('range.to must be greater than range.from');

  return { from, to };
};

const validateDietType = (value) => {
  if (typeof value !== 'string' || value.trim() === '') fail('dietType is required');
  const dietType = value.trim();
  if (!DIET_TYPES.includes(dietType)) {
    fail(`dietType must be one of: ${DIET_TYPES.join(', ')}`);
  }
  return dietType;
};

/**
 * Fields a client may never set, whatever it sends. Rejected loudly rather than
 * dropped silently, so a portal bug surfaces instead of appearing to work.
 */
const FORBIDDEN_FIELDS = [
  'id',
  '_id',
  'legacy',
  'migration',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deletedBy',
];

const assertNoForbiddenFields = (body) => {
  const present = FORBIDDEN_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  if (present.length > 0) {
    fail(`Field(s) not accepted from the client: ${present.join(', ')}`);
  }
};

export const validateCreatePlan = (body = {}) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) fail('A JSON body is required');
  assertNoForbiddenFields(body);

  return {
    dietType: validateDietType(body.dietType),
    range: validateRange(body.range),
    // An empty plan is allowed: the legacy system holds 5 of them, and the old
    // form let an admin save the plan row before touching the meal tabs.
    meals: validateMeals(body.meals ?? []),
    status: body.status === undefined ? 'active' : validateStatus(body.status),
  };
};

function validateStatus(value) {
  if (typeof value !== 'string' || !PLAN_STATUSES.includes(value)) {
    fail(`status must be one of: ${PLAN_STATUSES.join(', ')}`);
  }
  return value;
}

/** PATCH: only the supplied fields change. An empty patch is a 400. */
export const validateUpdatePlan = (body = {}) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) fail('A JSON body is required');
  assertNoForbiddenFields(body);

  const patch = {};
  if (body.dietType !== undefined) patch.dietType = validateDietType(body.dietType);
  if (body.range !== undefined) patch.range = validateRange(body.range);
  if (body.meals !== undefined) patch.meals = validateMeals(body.meals);
  if (body.status !== undefined) patch.status = validateStatus(body.status);

  if (Object.keys(patch).length === 0) fail('No editable fields supplied');
  return patch;
};

const SORT_KEYS = ['updatedAt', 'createdAt', 'dietType', 'rangeFrom', 'rangeTo', 'legacyPlanId'];

export const validatePlanListQuery = (query = {}) => {
  const out = {};

  if (query.page !== undefined) {
    const page = Number.parseInt(query.page, 10);
    if (Number.isNaN(page) || page < 1) fail('page must be a positive integer');
    out.page = page;
  }

  if (query.pageSize !== undefined) {
    const pageSize = Number.parseInt(query.pageSize, 10);
    if (Number.isNaN(pageSize) || pageSize < 1) fail('pageSize must be a positive integer');
    // Not an error when too large - the service clamps it, as the users list does.
    out.pageSize = pageSize;
  }

  if (query.dietType !== undefined && query.dietType !== '') {
    // Any stored value may be filtered on, including the legacy "Select" rows,
    // so this is not restricted to DIET_TYPES.
    out.dietType = String(query.dietType);
  }

  if (query.status !== undefined && query.status !== '') out.status = validateStatus(query.status);
  if (query.search !== undefined) out.search = String(query.search);

  if (query.sortKey !== undefined && query.sortKey !== '') {
    if (!SORT_KEYS.includes(query.sortKey)) {
      fail(`sortKey must be one of: ${SORT_KEYS.join(', ')}`);
    }
    out.sortKey = query.sortKey;
  }

  if (query.sortDir !== undefined) out.sortDir = query.sortDir === 'asc' ? 'asc' : 'desc';

  return out;
};

export default { validateCreatePlan, validateUpdatePlan, validatePlanListQuery };
