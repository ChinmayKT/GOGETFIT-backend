import mongoose from 'mongoose';

import env from '../config/env.js';
import DietPlan from '../models/diet-plan.model.js';
import Food from '../models/food.model.js';
import FoodLog, { FOOD_LOG_DAILY_SUBMISSIONS, FOOD_LOG_MEALS, mealFoodsOf } from '../models/food-log.model.js';
import User from '../models/user.model.js';
import { businessDayOf, isCalendarDay, startOfBusinessDay } from '../utils/business-date.js';
import { ERROR_CODES, badRequest, conflict, notFound, tooManyRequests } from '../utils/errors.js';
import { assertValidImage } from '../utils/image.js';
import { clientOfCoachEnrollment, contributed, effectiveTargetsOf } from './diet-plan.service.js';
import { toFoodRow } from './food.service.js';
import { foodLogMealImageFolder, getStorage } from './storage/index.js';

/**
 * The member's Intake food log, one document per business day.
 *
 * Submitting saves the day's whole meal state as the app holds it - the
 * same document is updated on every submission, entries keep their identity
 * (entryId) and their nutrition snapshot, and nothing on another day is ever
 * touched. Each meal holds its `foods` and at most one photo (`image`). The day is always the server's business day (env.businessTimezone);
 * a new day is a new document, so yesterday's log stays as it was.
 */

const NUTRIENTS = ['calories', 'fat', 'carbs', 'protein'];
const round1 = (n) => Math.round(n * 10) / 10;
const DUPLICATE_KEY = 11000;

/** A day's submissions so far, out of the daily limit (0 used with no log). */
const submissionsOf = (doc) => {
  const used = Math.min(doc?.submissionCount ?? 0, FOOD_LOG_DAILY_SUBMISSIONS);
  return { used, limit: FOOD_LOG_DAILY_SUBMISSIONS, remaining: FOOD_LOG_DAILY_SUBMISSIONS - used };
};

const limitReached = () =>
  tooManyRequests(
    ERROR_CODES.INTAKE_DAILY_LIMIT_REACHED,
    "You've reached your daily Intake submission limit. You can submit again tomorrow.",
  );

const findUser = async (userId) => {
  if (!mongoose.isValidObjectId(userId)) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  const user = await User.findById(userId, { _id: 1 }).lean();
  if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  return user;
};

/** All four as finite numbers, or null - targets are whole or absent. */
const completeTargets = (t) =>
  t && NUTRIENTS.every((k) => typeof t[k] === 'number' && Number.isFinite(t[k]))
    ? { calories: t.calories, fat: t.fat, carbs: t.carbs, protein: t.protein }
    : null;

const sumConsumed = (meals) => {
  const raw = { calories: 0, fat: 0, carbs: 0, protein: 0 };
  for (const meal of meals) {
    for (const e of mealFoodsOf(meal)) {
      // The diet plan's own rule: value / portion * qty.
      if (!(e.portion > 0)) continue;
      for (const k of NUTRIENTS) raw[k] += (e[k] / e.portion) * e.qty;
    }
  }
  return Object.fromEntries(NUTRIENTS.map((k) => [k, round1(raw[k])]));
};

const remainingOf = (targets, consumed) =>
  targets ? Object.fromEntries(NUTRIENTS.map((k) => [k, round1(targets[k] - consumed[k])])) : null;

/** What the app reads for one log: totals plus each entry with its food. */
const toFoodLogView = (doc, foodsById) => ({
  id: String(doc._id),
  date: doc.logDate,
  timezone: doc.timezone,
  dietPlanId: doc.dietPlanId ? String(doc.dietPlanId) : null,
  planId: doc.planId ?? null,
  status: doc.status ?? 'open',
  targets: doc.targets ?? null,
  targetsSource: doc.targetsSource ?? null,
  consumed: doc.consumed,
  remaining: doc.remaining ?? null,
  meals: (doc.meals ?? []).map((m) => ({
    meal: m.meal,
    image: m.image?.storageKey ? { url: m.image.url, storageKey: m.image.storageKey } : null,
    foods: mealFoodsOf(m).map((e) => {
      const food = foodsById.get(String(e.foodId)) ?? null;
      const row = food ? toFoodRow(food) : null;
      return {
        entryId: e.entryId,
        foodId: String(e.foodId),
        /** The name it was logged under. */
        foodName: e.foodName ?? null,
        qty: e.qty,
        portion: e.portion,
        servingUnit: e.servingUnit,
        /** The snapshot: values for `portion` of the food. */
        perPortion: { calories: e.calories, fat: e.fat, carbs: e.carbs, protein: e.protein },
        /** What this entry contributes. */
        nutrition: contributed(e),
        food: row
          ? { id: row.id, name: row.name, brand: row.brand, notes: row.notes, foodType: row.foodType, image: row.image, status: row.status }
          : null,
      };
    }),
  })),
  submittedAt: doc.submittedAt ? new Date(doc.submittedAt).toISOString() : null,
});

const viewOf = async (doc) => {
  // (Read only: a view never writes to the log.)
  if (!doc) return null;
  const ids = [...new Set(doc.meals.flatMap((m) => mealFoodsOf(m).map((e) => String(e.foodId))))];
  const foods = ids.length ? await Food.find({ _id: { $in: ids } }).lean() : [];
  return toFoodLogView(doc, new Map(foods.map((f) => [String(f._id), f])));
};

/**
 * A meal photo a submission refers to, as stored: only a key the meal-image
 * upload issued for this member, this day and this meal, and only while the
 * file is there. The URL is always derived here, never taken from the app.
 */
const ownImage = async (clientId, logDate, meal, image) => {
  if (image === null) return null;
  const key = image.storageKey;
  const folder = foodLogMealImageFolder(clientId, logDate, meal);
  if (!(key.startsWith(`${folder}/`) && /^[0-9a-f]{32}\.(jpg|png|webp)$/.test(key.slice(folder.length + 1)))) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `Meal ${meal}'s photo is not one uploaded for it today`);
  }
  const storage = getStorage();
  if (!(await storage.exists(key))) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `Meal ${meal}'s photo was not found - add it again`);
  }
  return { url: storage.urlFor(key), storageKey: key };
};

/**
 * Member upload: one photo of [meal] (1-8) for today, stored by its bytes
 * (validated by them, never by the declared type). Returns its reference for
 * the next submission - the log itself is not changed until that is saved.
 * Stored names are content hashes, so sending the same photo again (a retry)
 * stores nothing new and returns the same reference.
 *
 * ponytail: a photo uploaded and then never submitted (or replaced before
 * submitting) stays in storage - nothing is deleted here, so a file a saved
 * log points at can never be lost. A cleanup would sweep food-logs/ folders
 * for files no FoodLog references, a day or more after their day.
 */
export const uploadFoodLogMealImage = async (userId, meal, buffer, { now = new Date() } = {}) => {
  const n = Number(meal);
  if (!FOOD_LOG_MEALS.includes(n)) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'meal must be 1 to 8');
  const type = assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes });
  const user = await findUser(userId);
  const logDate = businessDayOf(now);
  const storage = getStorage();
  const url = await storage.save(buffer, { folder: foodLogMealImageFolder(user._id, logDate, n), extension: type.extension });
  return { date: logDate, meal: n, image: { url, storageKey: storage.keyFor(url) } };
};

/** The plan, coach and targets a day's log starts with. */
const resolveDaySnapshot = async (clientId, logDate, memberGoal) => {
  const plan = await DietPlan.findForDay(clientId, startOfBusinessDay(logDate)).lean();
  let targets = null;
  let targetsSource = null;
  if (plan) {
    const effective = effectiveTargetsOf(plan);
    targets = completeTargets(effective.targets);
    targetsSource = targets ? effective.source : null;
  } else if (memberGoal) {
    targets = completeTargets(memberGoal);
    targetsSource = targets ? 'member' : null;
  }
  return {
    dietPlanId: plan?._id ?? null,
    planId: plan?.planId ?? null,
    coachId: plan?.coachId ?? null,
    enrollmentId: plan?.enrollmentId ?? null,
    targets,
    targetsSource,
  };
};

/**
 * Member read: the log of [date] (YYYY-MM-DD, default today), or null when
 * nothing was submitted that day. Always the authenticated member's own.
 */
export const getFoodLogForDay = async (userId, { date, now = new Date() } = {}) => {
  const today = businessDayOf(now);
  const day = date ?? today;
  if (!isCalendarDay(day)) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'date must be a valid YYYY-MM-DD day');
  const user = await findUser(userId);
  const doc = await FoodLog.findOne({ clientId: user._id, logDate: day }).lean();
  return {
    date: day,
    today,
    timezone: env.businessTimezone,
    foodLog: await viewOf(doc),
    submissions: submissionsOf(doc),
  };
};

/**
 * Member write: today's whole meal state ([input] is
 * validateFoodLogSubmission's output). Creates today's log or updates it in
 * place - never another day's, never a second document.
 *
 *  - An entry already in today's log with the same food keeps its stored
 *    snapshot (only its qty can change), so an unchanged food is never
 *    re-priced by a later edit to the Food database; a new or changed entry
 *    takes the food's current values, and must be an active food.
 *  - Entries no longer sent are gone; an empty submission is refused unless
 *    it is clearing a log that exists.
 *  - consumed is computed here; targets are the diet plan's for the day
 *    (coach's Set Calorie Intake, else the plan's own), or - with no plan -
 *    the member's own goal they sent, else none.
 */
export const submitFoodLog = async (userId, input, { now = new Date() } = {}) => {
  const user = await findUser(userId);
  const logDate = businessDayOf(now);
  // Meals loaded for another day (the app kept yesterday's screen past
  // midnight) are never written into today's log.
  if (input.day && input.day !== logDate) {
    throw conflict(ERROR_CODES.FOOD_LOG_DAY_CHANGED, 'A new day has started - your food log was refreshed for today');
  }
  const existing = await FoodLog.findOne({ clientId: user._id, logDate }).lean();
  const result = async (doc) => ({
    date: logDate,
    timezone: env.businessTimezone,
    foodLog: await viewOf(doc),
    submissions: submissionsOf(doc),
  });
  const id = input.submissionId ?? null;
  // A retry of the submission already saved (its response was lost): the
  // saved log, not counted again.
  if (id && existing?.lastSubmissionId === id) return result(existing);
  // At most FOOD_LOG_DAILY_SUBMISSIONS a day. Refused here before any work;
  // the save below refuses it again, atomically.
  if ((existing?.submissionCount ?? 0) >= FOOD_LOG_DAILY_SUBMISSIONS) throw limitReached();

  const sent = input.meals.flatMap((m) => m.foods);
  if (sent.length === 0 && !existing) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'Add at least one food before submitting');
  }

  const prior = new Map(
    (existing?.meals ?? []).flatMap((m) => mealFoodsOf(m).map((e) => [e.entryId, e])),
  );
  const keep = (e) => {
    const p = prior.get(e.entryId);
    return p && String(p.foodId) === e.foodId ? p : null;
  };

  // New or changed entries are priced from the Food database, active only.
  const needed = [...new Set(sent.filter((e) => !keep(e)).map((e) => e.foodId))];
  const active = needed.length
    ? await Food.find({ _id: { $in: needed }, status: 'active' }, { name: 1, servingUnit: 1, servingQuantity: 1, calories: 1, fat: 1, carbs: 1, protein: 1 }).lean()
    : [];
  const foods = new Map(active.map((f) => [String(f._id), f]));
  const unknown = needed.filter((id) => !foods.has(id));
  if (unknown.length) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'Some foods are not available', { foodIds: unknown });
  }
  // Names for entries saved before names were kept (fills them in once).
  const unnamed = [...new Set(sent.filter((e) => keep(e) && !keep(e).foodName).map((e) => e.foodId))];
  const names = new Map(
    unnamed.length
      ? (await Food.find({ _id: { $in: unnamed } }, { name: 1 }).lean()).map((f) => [String(f._id), f.name ?? null])
      : [],
  );

  // Each meal's photo: the one sent, removed when null is sent, and kept as
  // saved when the meal says nothing about it.
  const savedImages = new Map((existing?.meals ?? []).filter((m) => m.image?.storageKey).map((m) => [m.meal, m.image]));
  const sentMeals = new Map(input.meals.map((m) => [m.meal, m]));
  const images = new Map();
  for (const meal of FOOD_LOG_MEALS) {
    const m = sentMeals.get(meal);
    const image = m && m.image !== undefined ? await ownImage(user._id, logDate, meal, m.image) : savedImages.get(meal) ?? null;
    if (image) images.set(meal, { url: image.url, storageKey: image.storageKey });
  }

  const meals = FOOD_LOG_MEALS.map((meal) => sentMeals.get(meal) ?? { meal, foods: [] })
    .filter((m) => m.foods.length > 0 || images.has(m.meal))
    .map((m) => ({
      meal: m.meal,
      image: images.get(m.meal) ?? null,
      foods: m.foods.map((e) => {
        const p = keep(e);
        if (p) {
          return {
            entryId: e.entryId,
            foodId: p.foodId,
            foodName: p.foodName ?? names.get(e.foodId) ?? null,
            qty: e.qty,
            portion: p.portion,
            servingUnit: p.servingUnit,
            calories: p.calories,
            fat: p.fat,
            carbs: p.carbs,
            protein: p.protein,
          };
        }
        const f = foods.get(e.foodId);
        return {
          entryId: e.entryId,
          foodId: f._id,
          foodName: f.name ?? null,
          qty: e.qty,
          portion: f.servingQuantity,
          servingUnit: f.servingUnit,
          calories: f.calories,
          fat: f.fat,
          carbs: f.carbs,
          protein: f.protein,
        };
      }),
    }));

  // The day's targets and plan are snapshotted by its first submission and
  // kept for the rest of the day, so the log is always read against the
  // targets it started with. Resolved from the plan-for-day rule: the
  // coach's Set Calorie Intake, else the plan's own; with no plan, the
  // member's own goal.
  const snapshot = existing
    ? {
        dietPlanId: existing.dietPlanId ?? null,
        planId: existing.planId ?? null,
        coachId: existing.coachId ?? null,
        enrollmentId: existing.enrollmentId ?? null,
        targets: existing.targets ?? null,
        targetsSource: existing.targetsSource ?? null,
      }
    : await resolveDaySnapshot(user._id, logDate, input.memberGoal);
  const consumed = sumConsumed(meals);

  const set = {
    timezone: env.businessTimezone,
    consumed,
    remaining: remainingOf(snapshot.targets, consumed),
    meals,
    submittedAt: now,
  };
  // Counted in the same atomic write: it only matches a log still under the
  // limit (and not already holding this submission), so concurrent requests
  // can never take a fourth. With no match the upsert tries to insert, which
  // the unique { clientId, logDate } index refuses - read below.
  const save = () =>
    FoodLog.findOneAndUpdate(
      {
        clientId: user._id,
        logDate,
        submissionCount: { $not: { $gte: FOOD_LOG_DAILY_SUBMISSIONS } },
        ...(id ? { lastSubmissionId: { $ne: id } } : {}),
      },
      {
        $set: { ...set, lastSubmissionId: id },
        $inc: { submissionCount: 1 },
        $setOnInsert: { clientId: user._id, logDate, status: 'open', ...snapshot },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await result(await save());
    } catch (error) {
      if (error?.code !== DUPLICATE_KEY) throw error;
      // The day's log exists but did not match: this submission already
      // counted (a concurrent retry), the limit is reached - or two first
      // submissions raced and the other inserted it, so try again as an update.
      const current = await FoodLog.findOne({ clientId: user._id, logDate }).lean();
      if (id && current?.lastSubmissionId === id) return result(current);
      if ((current?.submissionCount ?? 0) >= FOOD_LOG_DAILY_SUBMISSIONS) throw limitReached();
      if (attempt >= 2) throw error;
    }
  }
};

const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 60;

/** One saved day in History: its totals only - no meals, no foods. */
const toHistoryItem = (doc) => ({
  date: doc.logDate,
  status: doc.status ?? 'open',
  targets: doc.targets ?? null,
  targetsSource: doc.targetsSource ?? null,
  consumed: doc.consumed,
  remaining: doc.remaining ?? null,
  mealsLogged: (doc.meals ?? []).filter((m) => mealFoodsOf(m).length).length,
  foodsLogged: (doc.meals ?? []).reduce((n, m) => n + mealFoodsOf(m).length, 0),
  submittedAt: doc.submittedAt ? new Date(doc.submittedAt).toISOString() : null,
});

/**
 * Member read: the days the member actually submitted a log, newest first,
 * as stored - their snapshot targets and totals, never recomputed from
 * today's plan or the food catalogue, and never a day with nothing saved.
 *
 * [from] / [to] (YYYY-MM-DD, inclusive) narrow it to a range - a week for
 * the Weekly Consistency card. [cursor] continues a previous page: the
 * nextCursor it returned (the last date it held). Pages are by date, the
 * unique key per member, so none overlap or skip a day.
 */
export const getFoodLogHistory = async (userId, { from, to, limit, cursor, now = new Date() } = {}) => {
  for (const [label, value] of [['from', from], ['to', to], ['cursor', cursor]]) {
    if (value !== undefined && !isCalendarDay(value)) {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, `${label} must be a valid YYYY-MM-DD day`);
    }
  }
  if (from && to && from > to) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'from must not be after to');
  let size = HISTORY_DEFAULT_LIMIT;
  if (limit !== undefined) {
    size = Number.parseInt(limit, 10);
    if (!Number.isInteger(size) || size < 1) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'limit must be a positive integer');
    size = Math.min(size, HISTORY_MAX_LIMIT);
  }
  const user = await findUser(userId);

  const logDate = {};
  if (from) logDate.$gte = from;
  if (to) logDate.$lte = to;
  if (cursor) logDate.$lt = cursor;
  const filter = { clientId: user._id, ...(Object.keys(logDate).length ? { logDate } : {}) };
  const docs = await FoodLog.find(filter, { meals: 1, logDate: 1, status: 1, targets: 1, targetsSource: 1, consumed: 1, remaining: 1, submittedAt: 1 })
    .sort({ logDate: -1 })
    .limit(size + 1)
    .lean();
  const page = docs.slice(0, size);
  return {
    timezone: env.businessTimezone,
    today: businessDayOf(now),
    items: page.map(toHistoryItem),
    nextCursor: docs.length > size ? page[page.length - 1].logDate : null,
  };
};

/**
 * Coach reads: the client of one of the signed-in coach's own live
 * enrollments - their submitted days, and one day in full - exactly as the
 * member reads them. The client is only ever the enrollment's (checked
 * against this coach; any client id in the request is not one), and a day
 * must be named: a coach never gets "today" by default.
 */
export const getFoodLogHistoryForCoach = async (coachUserId, enrollmentId, query = {}) =>
  getFoodLogHistory(await clientOfCoachEnrollment(coachUserId, enrollmentId), query);

export const getFoodLogForDayForCoach = async (coachUserId, enrollmentId, { date, now } = {}) => {
  const clientId = await clientOfCoachEnrollment(coachUserId, enrollmentId);
  if (date === undefined) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'date is required');
  return getFoodLogForDay(clientId, { date, now });
};

export default {
  getFoodLogForDay,
  getFoodLogForDayForCoach,
  getFoodLogHistory,
  getFoodLogHistoryForCoach,
  submitFoodLog,
  uploadFoodLogMealImage,
};
