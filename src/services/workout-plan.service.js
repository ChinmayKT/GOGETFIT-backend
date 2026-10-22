import mongoose from 'mongoose';

import env from '../config/env.js';
// Registered here because the admin read populates it.
import Coach from '../models/coach.model.js';
import User from '../models/user.model.js';
import Workout from '../models/workout.model.js';
import WorkoutPlan, { WORKOUT_NOTE_MAX, WORKOUT_PLAN_MAX_BLOCKS } from '../models/workout-plan.model.js';
import {
  LIBRARY_MAX_PAGE_SIZE,
  LIBRARY_MAX_SEARCH,
  LIBRARY_PAGE_SIZE,
  clientOfCoachEnrollment,
  coachNames,
  coachOfUser,
  escapeRegex,
} from './diet-plan.service.js';
import { businessDayOf, isCalendarDay, startOfBusinessDay } from '../utils/business-date.js';
import { ERROR_CODES, badRequest, notFound } from '../utils/errors.js';
import { parseReps, parseSets } from '../utils/workout-prescription.js';

const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * The member's workout plan for a day: WorkoutPlan.findForDay - the one
 * active plan with that day selected, the newest where several share it.
 * The member is always the authenticated user, never an id from the request.
 */

const findUser = async (userId) => {
  if (!mongoose.isValidObjectId(userId)) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  const user = await User.findById(userId, { _id: 1, 'profile.name': 1 }).lean();
  if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  return user;
};

/**
 * A plan as the member reads it: blocks in order, each exercise with its
 * library details read live (archived exercises included - the plan still
 * shows them) and the prescription as written beside what was read from it.
 * No client, coach-internal or legacy ids.
 */
export const toWorkoutPlanView = (doc, workoutsById) => ({
  id: String(doc._id),
  planId: doc.planId,
  name: doc.name,
  assignedAt: doc.assignedAt ? new Date(doc.assignedAt).toISOString() : null,
  fromDate: doc.fromDate ? businessDayOf(doc.fromDate) : null,
  toDate: doc.toDate ? businessDayOf(doc.toDate) : null,
  days: (doc.selectedDates ?? []).map((d) => businessDayOf(d)),
  blocks: [...(doc.blocks ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((b) => ({
      blockId: b.blockId,
      name: b.name,
      order: b.order,
      exercises: (b.exercises ?? []).map((e) => {
        const w = e.workoutId ? workoutsById.get(String(e.workoutId)) ?? null : null;
        return {
          workoutId: e.workoutId ? String(e.workoutId) : null,
          name: w?.name ?? e.name ?? null,
          /** The exercise is no longer in the library: shown by its saved name only. */
          missingWorkout: !w,
          /** Still referenced, but archived in the library: shown, and marked. */
          archived: w?.status === 'archived',
          type: w?.type ?? null,
          equipment: w?.equipment ?? null,
          primaryMuscle: w?.primaryMuscle ?? null,
          secondaryMuscle: w?.secondaryMuscle ?? null,
          level: w?.level ?? null,
          /** The library's description - what the workout video screen shows under the video. */
          description: w?.description ?? null,
          thumbnail: w?.thumbnail?.url ? { url: w.thumbnail.url } : null,
          video: w?.video?.url ? { url: w.video.url } : null,
          setsRaw: e.setsRaw ?? null,
          repsRaw: e.repsRaw ?? null,
          sets: e.sets ?? null,
          measure: e.measure ?? null,
          amount: e.amount ?? null,
          amountMax: e.amountMax ?? null,
          note: e.note ?? null,
        };
      }),
    })),
});

/** Member read: the plan on [date] (YYYY-MM-DD, default today in the business timezone), or null. */
export const getWorkoutPlanForDay = async (userId, { date, now = new Date() } = {}) => {
  const today = businessDayOf(now);
  const day = date ?? today;
  if (!isCalendarDay(day)) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'date must be a valid YYYY-MM-DD day');
  const user = await findUser(userId);
  const doc = await WorkoutPlan.findForDay(user._id, startOfBusinessDay(day)).lean();
  if (!doc) return { date: day, today, timezone: env.businessTimezone, workoutPlan: null };
  return { date: day, today, timezone: env.businessTimezone, workoutPlan: toWorkoutPlanView(doc, await workoutsFor([doc])) };
};

const workoutsFor = async (docs) => {
  const ids = [...new Set(docs.flatMap((d) => d.blocks.flatMap((b) => b.exercises.map((e) => e.workoutId).filter(Boolean).map(String))))];
  const workouts = ids.length
    ? await Workout.find({ _id: { $in: ids } }, { name: 1, type: 1, equipment: 1, primaryMuscle: 1, secondaryMuscle: 1, level: 1, description: 1, thumbnail: 1, video: 1, status: 1 }).lean()
    : [];
  return new Map(workouts.map((w) => [String(w._id), w]));
};

/**
 * Admin read: every workout plan of one member, in the member's precedence
 * order (WorkoutPlan.findForDay: newest assignedAt, then higher legacy id,
 * then newer document). Each plan adds, to the member view:
 *   status, coach (null when none is linked), legacy ids for support,
 *   counts, and shownDays - the selected days on which the member actually
 *   sees THIS plan; on a day a newer active plan shares, the newer one wins.
 *   period - upcoming (first day after today), past (last day before today),
 *            else current; null with no days.
 * Nothing is derived beyond that; selected days stay exactly as stored.
 */
export const listWorkoutPlansForAdmin = async (userId, { now = new Date() } = {}) => {
  const today = businessDayOf(now);
  const user = await findUser(userId);
  const docs = await WorkoutPlan.find({ clientId: user._id })
    .sort({ assignedAt: -1, 'legacy.workoutPlanId': -1, _id: -1 })
    .populate({ path: 'coachId', model: Coach, select: 'profile.level userId', populate: { path: 'userId', select: 'profile.name' } })
    .lean();
  const workoutsById = await workoutsFor(docs);

  const taken = new Set();
  const workoutPlans = docs.map((doc) => {
    const view = toWorkoutPlanView(doc, workoutsById);
    // Precedence order: the first active plan holding a day is the one shown.
    const shownDays = doc.status === 'active' ? view.days.filter((d) => !taken.has(d)) : [];
    for (const d of shownDays) taken.add(d);
    const coach = doc.coachId && typeof doc.coachId === 'object' && doc.coachId.userId !== undefined ? doc.coachId : null;
    return {
      ...view,
      status: doc.status,
      period: !view.days.length ? null : view.days[0] > today ? 'upcoming' : view.days[view.days.length - 1] < today ? 'past' : 'current',
      coach: coach ? { id: String(coach._id), name: coach.userId?.profile?.name ?? null, level: coach.profile?.level ?? null } : null,
      legacy: doc.legacy
        ? { workoutPlanId: doc.legacy.workoutPlanId, createdBy: doc.legacy.createdBy ?? null, coachSource: doc.legacy.coachSource ?? null }
        : null,
      counts: {
        blocks: view.blocks.length,
        exercises: view.blocks.reduce((n, b) => n + b.exercises.length, 0),
        days: view.days.length,
      },
      shownDays,
    };
  });

  return {
    client: { id: String(user._id), name: user.profile?.name ?? null },
    today,
    timezone: env.businessTimezone,
    workoutPlans,
  };
};

/**
 * Coach read: the workout plans of the client in one of the signed-in coach's
 * own enrollments - the same check every coach read uses (the enrollment is
 * this coach's and not deleted; anything else is "not found"), then the same
 * plans, order, shown days and raw prescriptions as the admin read.
 */
export const listWorkoutPlansForCoach = async (coachUserId, enrollmentId, options = {}) =>
  listWorkoutPlansForAdmin(await clientOfCoachEnrollment(coachUserId, enrollmentId), options);

/**
 * Member read: the signed-in member's own workout plans, for History - the
 * same plans and shown days as the admin read, active ones only (an archived
 * plan was withdrawn), latest assigned day first (undated last), then the
 * precedence order. No legacy ids. The member is always the authenticated
 * user, never an id from the request.
 */
export const listMyWorkoutPlans = async (userId, options = {}) => {
  const { client, today, timezone, workoutPlans } = await listWorkoutPlansForAdmin(userId, options);
  const lastDay = (p) => p.toDate ?? '';
  return {
    client,
    today,
    timezone,
    // Stable sort: equal last days keep the precedence order (newest assignment first).
    workoutPlans: workoutPlans
      .filter((p) => p.status === 'active')
      .sort((a, b) => lastDay(b).localeCompare(lastDay(a)))
      .map(({ legacy, ...p }) => p),
  };
};

// ─── Coach: create a workout plan for a client ─────────────────────────────

const PLAN_NAME_MAX = 100;
const PRESCRIPTION_MAX = 20;
const MAX_DAYS = 366;

/**
 * Reads and checks a Create Workout Plan request. Returns the clean input or
 * throws VALIDATION_ERROR with what is wrong. Shape:
 *   { name, blocks: [{ name, exercises: [{ workoutId, setsRaw, repsRaw, note? }] }],
 *     dates: ['YYYY-MM-DD', ...] }   - the exact days it applies on.
 * Sets and reps are text, as the coach wrote them ("3", "12-15", "30sec");
 * what can be read from them is read on save, the text itself is kept.
 */
export const validateCreateWorkoutPlan = (body) => {
  const fail = (message) => { throw badRequest(ERROR_CODES.VALIDATION_ERROR, message); };
  if (!body || typeof body !== 'object') fail('body must be an object');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > PLAN_NAME_MAX) fail(`name is required (at most ${PLAN_NAME_MAX} characters)`);

  if (!Array.isArray(body.blocks)) fail('blocks must be a list');
  const blocks = body.blocks
    .map((b, i) => {
      if (!b || typeof b !== 'object' || !Array.isArray(b.exercises)) fail(`blocks[${i}] needs an exercises list`);
      const exercises = b.exercises.map((e, j) => {
        const at = `blocks[${i}].exercises[${j}]`;
        if (!e || typeof e !== 'object') fail(`${at} must be an object`);
        if (!mongoose.isValidObjectId(e.workoutId)) fail(`${at}.workoutId is not a valid id`);
        const text = (v, label) => {
          const t = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
          if (!t || t.length > PRESCRIPTION_MAX) fail(`${at}.${label} is required (at most ${PRESCRIPTION_MAX} characters)`);
          return t;
        };
        const note = typeof e.note === 'string' && e.note.trim() !== '' ? e.note.trim() : null;
        if (note && note.length > WORKOUT_NOTE_MAX) fail(`${at}.note is at most ${WORKOUT_NOTE_MAX} characters`);
        return { workoutId: String(e.workoutId), setsRaw: text(e.setsRaw, 'setsRaw'), repsRaw: text(e.repsRaw, 'repsRaw'), note };
      });
      return { name: typeof b.name === 'string' ? b.name.trim() : '', exercises };
    })
    // An empty slot is not a block of the session.
    .filter((b) => b.exercises.length > 0);
  if (!blocks.length) fail('the plan needs at least one exercise');
  if (blocks.length > WORKOUT_PLAN_MAX_BLOCKS) fail(`a plan holds at most ${WORKOUT_PLAN_MAX_BLOCKS} blocks`);

  if (!Array.isArray(body.dates) || !body.dates.length) fail('dates must list at least one day');
  const days = [...new Set(body.dates)];
  if (days.some((d) => typeof d !== 'string' || !isCalendarDay(d))) fail('every date must be a valid YYYY-MM-DD day');
  if (days.length > MAX_DAYS) fail(`at most ${MAX_DAYS} days`);
  return { name, blocks, days: days.sort() };
};

/**
 * Coach: saves a NEW workout plan for the client of one of the coach's own
 * enrollments (the check every coach read uses), on exactly the days given.
 * Never updates an existing plan; on a day another plan shares, this one -
 * the newest - is what the client sees. Every exercise must be an active
 * library workout; its name is kept as a snapshot.
 */
export const createWorkoutPlanForCoach = async (coachUserId, enrollmentId, input, { now = new Date() } = {}) => {
  const clientId = await clientOfCoachEnrollment(coachUserId, enrollmentId);
  const coach = await coachOfUser(coachUserId);

  const ids = [...new Set(input.blocks.flatMap((b) => b.exercises.map((e) => e.workoutId)))];
  const workouts = await Workout.find({ _id: { $in: ids }, status: 'active' }, { name: 1 }).lean();
  const byId = new Map(workouts.map((w) => [String(w._id), w]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) throw badRequest(ERROR_CODES.VALIDATION_ERROR, `Unknown or inactive workout(s): ${unknown.join(', ')}`);

  const selectedDates = input.days.map((d) => startOfBusinessDay(d));
  const id = new mongoose.Types.ObjectId();
  const doc = await WorkoutPlan.create({
    _id: id,
    planId: `app:${id}`,
    clientId,
    coachId: coach._id,
    enrollmentId,
    name: input.name,
    blocks: input.blocks.map((b, order) => ({
      blockId: `block-${order + 1}`,
      name: b.name || `Block ${order + 1}`,
      order,
      exercises: b.exercises.map((e) => ({
        workoutId: e.workoutId,
        name: byId.get(e.workoutId).name,
        setsRaw: e.setsRaw,
        repsRaw: e.repsRaw,
        sets: parseSets(e.setsRaw),
        ...parseReps(e.repsRaw),
        note: e.note,
      })),
    })),
    selectedDates,
    fromDate: selectedDates[0],
    toDate: selectedDates[selectedDates.length - 1],
    assignedAt: now,
    status: 'active',
    createdBy: coachUserId,
    updatedBy: coachUserId,
  });
  const view = toWorkoutPlanView(doc.toObject(), await workoutsFor([doc.toObject()]));
  return { ...view, coach: { id: String(coach._id) } };
};

// ─── Coach library: ALL GOGETFIT WORKOUT PLANS (YOU / ALL) ─────────────────

/**
 * The workout-plan library, one tab a page at a time - the diet library's
 * rules exactly (listDietPlanLibraryForCoach): active plans only, newest
 * created first (planId breaks ties). YOU is the signed-in coach's own: their
 * coach on the plan, and written by them (or migrated, which records no
 * writer). ALL is every coach's. A non-empty [search] (trimmed, any case,
 * taken literally) narrows by plan name before paging. Only what the list
 * shows: name, date, author, size - no client, no days, no exercises.
 */
export const listWorkoutPlanLibraryForCoach = async (coachUserId, { scope, page, pageSize, search } = {}) => {
  if (scope !== 'you' && scope !== 'all') throw badRequest(ERROR_CODES.VALIDATION_ERROR, "scope must be 'you' or 'all'");
  const parse = (value, fallback, label) => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw badRequest(ERROR_CODES.VALIDATION_ERROR, `${label} must be a positive integer`);
    return n;
  };
  const term = typeof search === 'string' ? search.trim() : '';
  if (term.length > LIBRARY_MAX_SEARCH) throw badRequest(ERROR_CODES.VALIDATION_ERROR, `search must be at most ${LIBRARY_MAX_SEARCH} characters`);
  const pageNo = parse(page, 1, 'page');
  const size = Math.min(parse(pageSize, LIBRARY_PAGE_SIZE, 'pageSize'), LIBRARY_MAX_PAGE_SIZE);
  const coach = await coachOfUser(coachUserId);

  const match = { status: 'active' };
  if (scope === 'you') {
    match.coachId = coach._id;
    match.createdBy = { $in: [new mongoose.Types.ObjectId(String(coachUserId)), null] };
  }
  if (term !== '') match.name = { $regex: escapeRegex(term), $options: 'i' };
  const [result] = await WorkoutPlan.aggregate([
    { $match: match },
    {
      $project: {
        planId: 1,
        name: 1,
        coachId: 1,
        createdOn: { $ifNull: ['$legacy.createDate', '$createdAt'] },
        blocks: { $size: { $ifNull: ['$blocks', []] } },
        exercises: { $sum: { $map: { input: { $ifNull: ['$blocks', []] }, as: 'b', in: { $size: { $ifNull: ['$$b.exercises', []] } } } } },
      },
    },
    { $sort: { createdOn: -1, planId: -1 } },
    { $facet: { items: [{ $skip: (pageNo - 1) * size }, { $limit: size }], total: [{ $count: 'n' }] } },
  ]);
  const names = await coachNames(result.items.map((i) => i.coachId));
  const total = result.total[0]?.n ?? 0;
  return {
    scope,
    items: result.items.map((i) => ({
      planId: i.planId,
      name: i.name,
      createdOn: iso(i.createdOn),
      coach: i.coachId ? { id: String(i.coachId), name: names.get(String(i.coachId)) ?? null } : null,
      counts: { blocks: i.blocks, exercises: i.exercises },
    })),
    pagination: { page: pageNo, pageSize: size, total, hasMore: pageNo * size < total },
  };
};

/**
 * One library plan in full, for its preview and Copy This Plan: its blocks
 * and exercises exactly as written - and nothing about whose plan it was (no
 * client, no days). Any coach may read any library plan, as ALL lists them
 * all. Read-only.
 */
export const getWorkoutPlanLibraryItemForCoach = async (coachUserId, planId) => {
  await coachOfUser(coachUserId);
  const missing = () => notFound(ERROR_CODES.WORKOUT_PLAN_NOT_FOUND, 'Workout plan not found');
  if (typeof planId !== 'string' || planId.trim() === '' || planId.length > 100) throw missing();
  const doc = await WorkoutPlan.findOne({ planId, status: 'active' }).sort({ assignedAt: -1 }).lean();
  if (!doc) throw missing();
  const view = toWorkoutPlanView(doc, await workoutsFor([doc]));
  const names = await coachNames([doc.coachId]);
  return {
    workoutPlan: {
      planId,
      name: doc.name,
      createdOn: iso(doc.legacy?.createDate ?? doc.createdAt),
      coach: doc.coachId ? { id: String(doc.coachId), name: names.get(String(doc.coachId)) ?? null } : null,
      blocks: view.blocks,
    },
  };
};

export default {
  getWorkoutPlanForDay,
  getWorkoutPlanLibraryItemForCoach,
  listMyWorkoutPlans,
  listWorkoutPlanLibraryForCoach,
  listWorkoutPlansForAdmin,
  listWorkoutPlansForCoach,
  toWorkoutPlanView,
};
