import mongoose from 'mongoose';

import { FOOD_LOG_MEALS } from '../models/food-log.model.js';
import { isCalendarDay } from '../utils/business-date.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

const MAX_ENTRIES_PER_MEAL = 50;
const MAX_ENTRY_ID = 100;
const MAX_STORAGE_KEY = 300;

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * PUT /api/users/me/food-log body - today's whole meal state:
 *
 *   { meals: [{ meal: 1-8, image?: { storageKey } | null,
 *               foods: [{ entryId, foodId, qty }] }],
 *     day?: 'YYYY-MM-DD', memberGoal?: { calories, fat, carbs, protein } }
 *
 * `foods` was `entries` before; an older app still sending `entries` is read
 * the same way. A meal's `image` is a key from the meal-image upload
 * (`{ storageKey }`, a url beside it is ignored - the server derives it), or
 * null to remove the meal's photo; left out, the saved photo stays.
 *
 * `day` is the day the app's meals were loaded for. It never chooses the
 * day saved to (the server's today does); it only lets the server refuse a
 * submission of yesterday's meals made after midnight.
 *
 * Only what the member chose is accepted: which food, how much, and the
 * app's id for the entry. Portions, nutrition, totals, targets, dates and
 * every id of a client, coach or plan are the server's - any such field is
 * ignored. memberGoal is the member's own goal, used only on a day with no
 * diet plan.
 */
export const validateFoodLogSubmission = (body = {}) => {
  if (!isPlainObject(body)) fail('Body must be an object');
  if (!Array.isArray(body.meals)) fail('meals must be a list');

  const seenMeals = new Set();
  const seenEntries = new Set();
  const meals = body.meals.map((m, i) => {
    if (!isPlainObject(m)) fail(`meals[${i}] must be an object`);
    if (!FOOD_LOG_MEALS.includes(m.meal)) fail(`meals[${i}].meal must be 1 to 8`);
    if (seenMeals.has(m.meal)) fail(`Meal ${m.meal} is listed twice`);
    seenMeals.add(m.meal);
    const list = m.foods !== undefined ? m.foods : m.entries;
    if (!Array.isArray(list)) fail(`meals[${i}].foods must be a list`);
    if (list.length > MAX_ENTRIES_PER_MEAL) fail(`Meal ${m.meal} has more than ${MAX_ENTRIES_PER_MEAL} foods`);
    // undefined: keep the saved photo; null: remove it; else the new one.
    let image;
    if (m.image === null) image = null;
    else if (m.image !== undefined) {
      if (!isPlainObject(m.image) || typeof m.image.storageKey !== 'string' || m.image.storageKey === '' || m.image.storageKey.length > MAX_STORAGE_KEY) {
        fail(`meals[${i}].image must be an uploaded image or null`);
      }
      image = { storageKey: m.image.storageKey };
    }
    return {
      meal: m.meal,
      image,
      foods: list.map((e, j) => {
        const at = `meals[${i}].foods[${j}]`;
        if (!isPlainObject(e)) fail(`${at} must be an object`);
        if (typeof e.entryId !== 'string' || e.entryId.trim() === '' || e.entryId.length > MAX_ENTRY_ID) {
          fail(`${at}.entryId is required`);
        }
        if (seenEntries.has(e.entryId)) fail(`entryId ${e.entryId} is used twice`);
        seenEntries.add(e.entryId);
        if (typeof e.foodId !== 'string' || !mongoose.isValidObjectId(e.foodId)) fail(`${at}.foodId is not a food`);
        if (!finite(e.qty) || e.qty <= 0) fail(`${at}.qty must be a number greater than 0`);
        return { entryId: e.entryId, foodId: e.foodId, qty: e.qty };
      }),
    };
  });

  let memberGoal = null;
  if (body.memberGoal !== undefined && body.memberGoal !== null) {
    const g = body.memberGoal;
    if (!isPlainObject(g)) fail('memberGoal must be an object');
    for (const k of ['calories', 'fat', 'carbs', 'protein']) {
      if (!finite(g[k]) || g[k] < 0) fail(`memberGoal.${k} must be 0 or more`);
    }
    // A goal of 0 kcal is no goal (the app's "not set").
    memberGoal = g.calories > 0 ? { calories: g.calories, fat: g.fat, carbs: g.carbs, protein: g.protein } : null;
  }
  let day = null;
  if (body.day !== undefined && body.day !== null) {
    if (!isCalendarDay(body.day)) fail('day must be a YYYY-MM-DD date');
    day = body.day;
  }
  return { meals, memberGoal, day };
};

export default { validateFoodLogSubmission };
