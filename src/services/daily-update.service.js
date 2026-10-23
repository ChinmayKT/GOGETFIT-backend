import env from '../config/env.js';
import DailyUpdate, { DAILY_UPDATE_DAILY_SUBMISSIONS } from '../models/daily-update.model.js';
import EnrolledClient from '../models/enrolled-client.model.js';
import FoodLog from '../models/food-log.model.js';
import Questionnaire from '../models/questionnaire.model.js';
import User from '../models/user.model.js';
import { calculateAge } from '../utils/age.js';
import { businessDayOf, isCalendarDay } from '../utils/business-date.js';
import { ERROR_CODES, badRequest, conflict, notFound, tooManyRequests } from '../utils/errors.js';
import { clientOfCoachEnrollment } from './diet-plan.service.js';
import { listMemberEnrollments } from './member-enrollment.service.js';
import { rewardDailyUpdateSafely } from './rewards.service.js';
import { CALORIE_OUT_PARTS } from '../validators/daily-update.validator.js';

/**
 * Daily Update (Journey Module 6): one record per member per business day,
 * overwritten by each later submission that day. The member is always the
 * token's; a coach reads a client only through one of their own enrollments.
 */

const DUPLICATE_KEY = 11000;
const HISTORY_DEFAULT_LIMIT = 30;
const HISTORY_MAX_LIMIT = 90;

/** A day's submissions so far, out of the daily limit (0 used with none saved). */
const submissionsOf = (doc) => {
  const used = Math.min(doc?.submissionCount ?? 0, DAILY_UPDATE_DAILY_SUBMISSIONS);
  return { used, limit: DAILY_UPDATE_DAILY_SUBMISSIONS, remaining: DAILY_UPDATE_DAILY_SUBMISSIONS - used };
};

const limitReached = () =>
  tooManyRequests(
    ERROR_CODES.DAILY_UPDATE_DAILY_LIMIT_REACHED,
    "You've reached your daily Daily Update submission limit. You can submit again tomorrow.",
  );

const findUser = async (userId) => {
  const user = await User.findById(userId).lean();
  if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  return user;
};

const assertDay = (day, label = 'date') => {
  if (!isCalendarDay(day)) throw badRequest(ERROR_CODES.VALIDATION_ERROR, `${label} must be a valid YYYY-MM-DD day`);
};

const nutrients = (n) =>
  n ? { calories: n.calories ?? 0, protein: n.protein ?? 0, carbs: n.carbs ?? 0, fat: n.fat ?? 0 } : null;

/** −/0/+ : the app's rule - zero is neutral, nothing else is. */
export const energyBalanceStatusOf = (kcal) => (kcal < 0 ? 'negative' : kcal > 0 ? 'positive' : 'neutral');

/**
 * Calorie Out total and the energy balance, from the parts and Calorie In:
 * only with every part, and the balance only with a Calorie In as well -
 * never a partial sum, never a missing value read as 0. Whole kcal, as shown.
 */
export const totalsOf = (calorieOut, calorieIn) => {
  const parts = CALORIE_OUT_PARTS.map((p) => calorieOut[p]);
  const total = parts.every((v) => v !== null && v !== undefined) ? parts.reduce((a, b) => a + b, 0) : null;
  const eaten = calorieIn ? Math.round(calorieIn.consumed.calories) : null;
  const kcal = total === null || eaten === null || eaten <= 0 ? null : eaten - total;
  return { total, energyBalance: { kcal, status: kcal === null ? null : energyBalanceStatusOf(kcal) } };
};

/**
 * Who the figures were worked out for: the questionnaire on the member's
 * enrollment (as the app shows it - height asked in feet, kept in whole cm),
 * else their profile. A snapshot only; nothing is written back.
 */
const profileSnapshot = async (user, enrollmentId) => {
  const q = enrollmentId ? await Questionnaire.findOne({ userId: user._id, enrollmentId }).lean() : null;
  const answers = q?.answers ?? {};
  const answer = (k) => (answers instanceof Map ? answers.get(k) : answers[k]);
  const number = (v) => {
    const n = typeof v === 'number' ? v : Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const gender = String(answer('gender') ?? user.profile?.gender ?? '').toLowerCase();
  const feet = number(answer('height'));
  return {
    name: user.profile?.name ?? null,
    gender: gender === 'male' || gender === 'female' ? gender : null,
    age: number(answer('age')) ?? calculateAge(user.profile?.dateOfBirth) ?? user.profile?.age ?? null,
    heightCm: feet !== null ? Math.round(feet * 30.48) : (user.profile?.fitnessProfile?.height ?? null),
  };
};

/** The member's active enrollment with its coach and plan ids, or nulls. */
const currentEnrollmentIds = async (userId, now) => {
  const { current } = await listMemberEnrollments(userId, now);
  if (!current) return { enrollmentId: null, coachId: null, planId: null };
  const doc = await EnrolledClient.findById(current.id, { coachId: 1, planId: 1 }).lean();
  return { enrollmentId: doc?._id ?? null, coachId: doc?.coachId ?? null, planId: doc?.planId ?? null };
};

const toView = (doc) =>
  doc && {
    date: doc.date,
    timezone: doc.timezone,
    enrollmentId: doc.enrollmentId ? String(doc.enrollmentId) : null,
    coachId: doc.coachId ? String(doc.coachId) : null,
    planId: doc.planId ? String(doc.planId) : null,
    profile: doc.profile ?? null,
    activity: doc.activity,
    calorieIn: doc.calorieIn ?? null,
    calorieOut: doc.calorieOut,
    energyBalance: doc.energyBalance,
    submittedAt: doc.submittedAt ? new Date(doc.submittedAt).toISOString() : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };

/** Member read: [date]'s saved Daily Update (default today), or null. */
export const getDailyUpdateForDay = async (userId, { date, now = new Date() } = {}) => {
  const today = businessDayOf(now);
  const day = date ?? today;
  assertDay(day);
  const user = await findUser(userId);
  const doc = await DailyUpdate.findOne({ clientId: user._id, date: day }).lean();
  return { date: day, today, timezone: env.businessTimezone, dailyUpdate: toView(doc), submissions: submissionsOf(doc) };
};

/**
 * Member write: today's Daily Update ([input] is
 * validateDailyUpdateSubmission's output). Creates it or overwrites it in
 * place - one record per member per day, never another day's: a past day is
 * read-only (409), as it is in the app.
 *
 * Calorie In is read from the day's food log here, never taken from the app;
 * the Calorie Out total and the energy balance are summed here from the parts.
 */
export const submitDailyUpdate = async (userId, date, input, { now = new Date() } = {}) => {
  assertDay(date);
  const user = await findUser(userId);
  const today = businessDayOf(now);
  if (date !== today) {
    throw conflict(ERROR_CODES.DAILY_UPDATE_DAY_CLOSED, 'Only today\'s Daily Update can be submitted');
  }

  const existing = await DailyUpdate.findOne({ clientId: user._id, date }).lean();
  // Every successful answer - a retry's too - carries the Streak and Coins
  // as they now stand; a day is rewarded once, whichever request gets there.
  const result = async (doc) => ({
    date,
    today,
    timezone: env.businessTimezone,
    dailyUpdate: toView(doc),
    submissions: submissionsOf(doc),
    rewards: await rewardDailyUpdateSafely({ userId: user._id, dailyUpdateId: doc._id, date, now }),
  });
  const id = input.submissionId ?? null;
  // A retry of the submission already saved (its response was lost): the
  // saved record, not counted again.
  if (id && existing?.lastSubmissionId === id) return result(existing);
  // At most DAILY_UPDATE_DAILY_SUBMISSIONS a day: refused here before any
  // work, and again - atomically - by the save below.
  if ((existing?.submissionCount ?? 0) >= DAILY_UPDATE_DAILY_SUBMISSIONS) throw limitReached();

  const log = await FoodLog.findOne({ clientId: user._id, logDate: date }, { consumed: 1, targets: 1 }).lean();
  const calorieIn = log ? { consumed: nutrients(log.consumed), targets: nutrients(log.targets) } : null;
  const { total, energyBalance } = totalsOf(input.calorieOut, calorieIn);
  const ids = await currentEnrollmentIds(user._id, now);

  const set = {
    timezone: env.businessTimezone,
    ...ids,
    profile: await profileSnapshot(user, ids.enrollmentId),
    activity: { weightKg: input.weightKg, workoutMinutes: input.workoutMinutes, steps: input.steps },
    calorieIn,
    calorieOut: { ...input.calorieOut, total },
    energyBalance,
    submittedAt: now,
    lastSubmissionId: id,
  };
  // Counted in the same atomic write: it only matches a record still under
  // the limit (and not already holding this submission), so concurrent
  // requests can never take a fourth. With no match the upsert tries to
  // insert, which the unique { clientId, date } index refuses - read below.
  const save = () =>
    DailyUpdate.findOneAndUpdate(
      {
        clientId: user._id,
        date,
        submissionCount: { $not: { $gte: DAILY_UPDATE_DAILY_SUBMISSIONS } },
        ...(id ? { lastSubmissionId: { $ne: id } } : {}),
      },
      { $set: set, $inc: { submissionCount: 1 }, $setOnInsert: { clientId: user._id, date } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await result(await save());
    } catch (error) {
      if (error?.code !== DUPLICATE_KEY) throw error;
      // The day's record exists but did not match: this submission already
      // counted (a concurrent retry), the limit is reached - or two first
      // submissions raced and the other inserted it, so try again as an update.
      const current = await DailyUpdate.findOne({ clientId: user._id, date }).lean();
      if (id && current?.lastSubmissionId === id) return result(current);
      if ((current?.submissionCount ?? 0) >= DAILY_UPDATE_DAILY_SUBMISSIONS) throw limitReached();
      if (attempt >= 2) throw error;
    }
  }
};

/** One saved day in History: the summary only. */
const toHistoryItem = (doc) => ({
  date: doc.date,
  weightKg: doc.activity?.weightKg ?? null,
  workoutMinutes: doc.activity?.workoutMinutes ?? null,
  steps: doc.activity?.steps ?? null,
  calorieIn: doc.calorieIn ? Math.round(doc.calorieIn.consumed.calories) : null,
  calorieOut: doc.calorieOut?.total ?? null,
  energyBalance: doc.energyBalance?.kcal ?? null,
  status: doc.energyBalance?.status ?? null,
  updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
});

/**
 * Member read: the days with a saved Daily Update, newest first; [cursor]
 * (the nextCursor of the previous page, a date) continues it.
 */
export const getDailyUpdateHistory = async (userId, { limit, cursor, now = new Date() } = {}) => {
  if (cursor !== undefined) assertDay(cursor, 'cursor');
  let size = HISTORY_DEFAULT_LIMIT;
  if (limit !== undefined) {
    size = Number.parseInt(limit, 10);
    if (!Number.isInteger(size) || size < 1) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'limit must be a positive integer');
    size = Math.min(size, HISTORY_MAX_LIMIT);
  }
  const user = await findUser(userId);
  const docs = await DailyUpdate.find(
    { clientId: user._id, ...(cursor ? { date: { $lt: cursor } } : {}) },
    { date: 1, activity: 1, 'calorieIn.consumed.calories': 1, 'calorieOut.total': 1, energyBalance: 1, updatedAt: 1 },
  )
    .sort({ date: -1 })
    .limit(size + 1)
    .lean();
  const page = docs.slice(0, size);
  return {
    timezone: env.businessTimezone,
    today: businessDayOf(now),
    items: page.map(toHistoryItem),
    nextCursor: docs.length > size ? page[page.length - 1].date : null,
  };
};

/**
 * Coach reads: the client of one of the signed-in coach's own enrollments -
 * their saved days, and one day in full - exactly as the member reads them.
 * The client is only ever the enrollment's; a day must be named.
 */
export const getDailyUpdateHistoryForCoach = async (coachUserId, enrollmentId, query = {}) =>
  getDailyUpdateHistory(await clientOfCoachEnrollment(coachUserId, enrollmentId), query);

export const getDailyUpdateForDayForCoach = async (coachUserId, enrollmentId, { date, now } = {}) => {
  const clientId = await clientOfCoachEnrollment(coachUserId, enrollmentId);
  if (date === undefined) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'date is required');
  return getDailyUpdateForDay(clientId, { date, now });
};

export default {
  getDailyUpdateForDay,
  getDailyUpdateForDayForCoach,
  getDailyUpdateHistory,
  getDailyUpdateHistoryForCoach,
  submitDailyUpdate,
};
