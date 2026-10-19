import mongoose from 'mongoose';

import { DIET_PLAN_MEALS } from '../models/diet-plan.model.js';
import { addCalendarDays, isCalendarDay } from '../utils/business-date.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';
import { ACTIVITY_LEVELS, GENDERS } from '../utils/fitness-calculations.js';

/**
 * The body of a NEW diet plan - the same for the coach's app
 * (POST /api/coach/enrollments/:enrollmentId/diet-plans) and the Admin Portal
 * (POST /api/admin/enrollments/:enrollmentId/diet-plans).
 *
 * Ownership is not in here: client, coach and enrollment come from the
 * enrollment and the token, never from the body (a clientId or coachId sent
 * is ignored). bmr, tdee and the four targets are the coach's figures as
 * the app showed them, stored as sent - so every one is required and checked.
 * Each food's nutrition is not: the server calculates it from the Food
 * database (diet-plan.service createDietPlan), so any sent is ignored.
 */

/** The diet plan goal vocabulary - what migrated plans already store. */
export const DIET_PLAN_GOALS = ['Fat/Weight Loss', 'Muscle/Weight Gain', 'Maintain Physique'];

/** Each diet plan goal as the profile's FITNESS_GOALS value (the app's dietPlanGoal, reversed). */
export const DIET_PLAN_GOAL_TO_FITNESS_GOAL = {
  'Fat/Weight Loss': 'fatLoss',
  'Muscle/Weight Gain': 'muscleGain',
  'Maintain Physique': 'maintainPhysique',
};

const MAX_NAME = 120;
const MAX_FOODS_PER_MEAL = 50;

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const number = (value, label, { positive = false, optional = false } = {}) => {
  if (value === null || value === undefined) {
    if (optional) return null;
    fail(`${label} is required`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a number`);
  if (positive ? value <= 0 : value < 0) fail(`${label} must be ${positive ? 'greater than 0' : '0 or more'}`);
  return value;
};

const day = (value, label) => {
  if (!isCalendarDay(value)) fail(`${label} must be a YYYY-MM-DD date`);
  return value;
};

/**
 * The days a plan applies on, in the most compact form: Date Range or a
 * continuous run of picked days -> fromDate + toDate only; picked days with a
 * gap -> fromDate + toDate + exactly those days (sorted, duplicates dropped).
 * A single day is a one-day run.
 */
export const normaliseDietPlanDates = ({ fromDate, toDate, selectedDates }) => {
  const from = day(fromDate, 'fromDate');
  const to = day(toDate, 'toDate');
  if (from > to) fail('fromDate must not be after toDate');
  if (selectedDates === undefined || selectedDates === null) return { fromDate: from, toDate: to };
  if (!Array.isArray(selectedDates)) fail('selectedDates must be a list of dates');

  const days = [...new Set(selectedDates.map((d, i) => day(d, `selectedDates[${i}]`)))].sort();
  if (days.length === 0) return { fromDate: from, toDate: to };
  if (days[0] !== from || days[days.length - 1] !== to) {
    fail('selectedDates must start on fromDate and end on toDate');
  }
  const continuous = days.every((d, i) => i === 0 || addCalendarDays(days[i - 1], 1) === d);
  return continuous ? { fromDate: from, toDate: to } : { fromDate: from, toDate: to, selectedDates: days };
};

/** A food and its ACTUAL amount (200 ml is qty 200 - never a multiplier). */
const foodAssignment = (raw, label) => {
  if (!isPlainObject(raw)) fail(`${label} must be an object`);
  if (!mongoose.isValidObjectId(raw.foodId)) fail(`${label}.foodId must be a valid id`);
  if (typeof raw.servingUnit !== 'string' || raw.servingUnit.trim() === '') fail(`${label}.servingUnit is required`);
  return {
    foodId: String(raw.foodId),
    qty: number(raw.qty, `${label}.qty`, { positive: true }),
    servingUnit: raw.servingUnit.trim(),
  };
};

export const validateCreateDietPlan = (body = {}) => {
  if (!isPlainObject(body)) fail('body must be an object');

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') fail('name is required');
  if (name.length > MAX_NAME) fail(`name must be at most ${MAX_NAME} characters`);

  // The profile the coach's figures were calculated from: every one is
  // required (the app's Create Diet Plan cannot calculate without them).
  if (!isPlainObject(body.targets)) fail('targets is required');
  if (!GENDERS.includes(body.gender)) fail(`gender must be one of: ${GENDERS.join(', ')}`);
  if (!ACTIVITY_LEVELS.some((a) => a.value === body.activityLevel)) {
    fail(`activityLevel must be one of: ${ACTIVITY_LEVELS.map((a) => a.value).join(', ')}`);
  }
  if (!DIET_PLAN_GOALS.includes(body.goal)) fail(`goal must be one of: ${DIET_PLAN_GOALS.join(', ')}`);

  if (!Array.isArray(body.meals)) fail('meals must be a list');
  const seen = new Set();
  const meals = [];
  body.meals.forEach((raw, i) => {
    if (!isPlainObject(raw)) fail(`meals[${i}] must be an object`);
    if (!DIET_PLAN_MEALS.includes(raw.meal)) fail(`meals[${i}].meal must be one of ${DIET_PLAN_MEALS.join(', ')}`);
    if (seen.has(raw.meal)) fail(`meal ${raw.meal} appears twice`);
    seen.add(raw.meal);
    if (!Array.isArray(raw.foods)) fail(`meals[${i}].foods must be a list`);
    if (raw.foods.length > MAX_FOODS_PER_MEAL) fail(`meal ${raw.meal} has more than ${MAX_FOODS_PER_MEAL} foods`);
    const foods = raw.foods.map((f, j) => foodAssignment(f, `meals[${i}].foods[${j}]`));
    // Meals with no food are not stored (the model's own rule).
    if (foods.length) meals.push({ meal: raw.meal, foods });
  });
  if (meals.length === 0) fail('a diet plan needs at least one food');
  meals.sort((a, b) => a.meal - b.meal);

  return {
    name,
    gender: body.gender,
    age: number(body.age, 'age', { positive: true }),
    height: number(body.height, 'height', { positive: true }),
    weight: number(body.weight, 'weight', { positive: true }),
    activityLevel: body.activityLevel,
    goal: body.goal,
    // The coach's figures, as the app showed them.
    bmr: number(body.bmr, 'bmr', { positive: true }),
    tdee: number(body.tdee, 'tdee', { positive: true }),
    targets: {
      dailyCalorieTarget: number(body.targets.dailyCalorieTarget, 'targets.dailyCalorieTarget', { positive: true }),
      fat: number(body.targets.fat, 'targets.fat'),
      carbs: number(body.targets.carbs, 'targets.carbs'),
      protein: number(body.targets.protein, 'targets.protein'),
    },
    meals,
    ...normaliseDietPlanDates(body),
  };
};

/**
 * Set Calorie Intake body: all four daily targets, as numbers - calories in
 * kcal (more than 0), protein / carbs / fat in grams (0 or more). Nothing is
 * derived from anything else, and no other field is read.
 */
export const validateCoachTargets = (body = {}) => {
  if (!isPlainObject(body)) fail('Body must be an object');
  return {
    calories: number(body.calories, 'calories', { positive: true }),
    protein: number(body.protein, 'protein'),
    carbs: number(body.carbs, 'carbs'),
    fat: number(body.fat, 'fat'),
  };
};

export default { validateCoachTargets, validateCreateDietPlan, normaliseDietPlanDates, DIET_PLAN_GOALS, DIET_PLAN_GOAL_TO_FITNESS_GOAL };
