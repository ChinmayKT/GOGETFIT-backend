import mongoose from 'mongoose';

// Registered here because the plans populate them (coach, enrollment, the enrollment's package).
import Coach from '../models/coach.model.js';
import EnrolledClient from '../models/enrolled-client.model.js';
import '../models/gogetfit-plan.model.js';
import DietPlan from '../models/diet-plan.model.js';
import Food from '../models/food.model.js';
import User from '../models/user.model.js';
import logger from '../config/logger.js';
import { addCalendarDays, businessDayOf, isCalendarDay, startOfBusinessDay } from '../utils/business-date.js';
import { ERROR_CODES, badRequest, forbidden, notFound } from '../utils/errors.js';
import { toFoodRow } from './food.service.js';
import { ACTOR_ADMIN, ACTOR_COACH, resolveEnrollmentForActor } from './diet-plan-create-data.service.js';
import { round2 } from '../utils/fitness-calculations.js';

/**
 * Coach-assigned diet plans, read-only. See docs/diet-plans-design.md.
 *
 * Every DietPlan document is one assignment: over one contiguous run of
 * business days, or - for an app-created plan with `selectedDates` - over
 * exactly those days. They are returned as they are - never merged, never
 * gap-filled.
 *
 * Nutrition: each food assignment carries a frozen snapshot that describes
 * `portion` of the food. What the member reads is that snapshot scaled to the
 * prescribed amount, `value / portion * qty`, rounded to one decimal - the
 * legacy app's rule (get_meal_plan_list_screen.dart). It is computed from the
 * snapshot only; the Food master supplies identity (name, brand, image), never
 * numbers, so a later Food edit cannot change a historical plan.
 */

const POPULATE = [
  { path: 'coachId', select: 'profile.level userId', populate: { path: 'userId', select: 'profile.name' } },
  { path: 'enrollmentId', select: 'planId enrollDate startDate endDate isDeleted', populate: { path: 'planId', select: 'name' } },
];

const NUTRIENTS = ['calories', 'protein', 'carbs', 'fat'];
const isObject = (value) => value !== null && typeof value === 'object' && !(value instanceof mongoose.Types.ObjectId);
const round1 = (n) => Math.round(n * 10) / 10;
const iso = (date) => (date ? new Date(date).toISOString() : null);

/** One food's unrounded contribution: the snapshot scaled to the prescribed amount. */
const rawContribution = (assignment) =>
  Object.fromEntries(NUTRIENTS.map((k) => [k, assignment.portion > 0 ? (assignment[k] / assignment.portion) * assignment.qty : null]));

const roundAll = (values) => Object.fromEntries(NUTRIENTS.map((k) => [k, values[k] === null ? null : round1(values[k])]));

/** What the member reads for one food, to one decimal. */
export const contributed = (assignment) => roundAll(rawContribution(assignment));

/** Totals add the UNROUNDED contributions and round once, as the legacy app did. */
const sumRaw = (items) => Object.fromEntries(NUTRIENTS.map((k) => [k, items.reduce((n, item) => n + (item[k] ?? 0), 0)]));

/** The Food fields a plan shows: identity only. Null when the reference is broken. */
const toFoodIdentity = (food) => {
  if (!food) return null;
  const row = toFoodRow(food);
  return { id: row.id, name: row.name, brand: row.brand, notes: row.notes, foodType: row.foodType, image: row.image, status: row.status };
};

/** The days a document applies on, as YYYY-MM-DD: its picked days, or every day of its run. */
const daysOfDoc = (doc) => (doc.selectedDates?.length ? doc.selectedDates.map((d) => businessDayOf(d)) : null);

/**
 * A plan's targets in the one shape every reader already uses: `calories` is
 * the daily target - stored as `calories` on migrated plans and as
 * `dailyCalorieTarget` on app-created ones.
 */
const targetsView = (targets) =>
  targets
    ? {
        calories: targets.calories ?? targets.dailyCalorieTarget ?? null,
        protein: targets.protein,
        carbs: targets.carbs,
        fat: targets.fat,
      }
    : null;

/** The coach's Set Calorie Intake, only when all four values are set; else null. */
export const coachTargetsView = (coach) => {
  if (!coach) return null;
  const values = { calories: coach.calories, protein: coach.protein, carbs: coach.carbs, fat: coach.fat };
  return Object.values(values).every((v) => typeof v === 'number' && Number.isFinite(v)) ? values : null;
};

/**
 * THE rule for which daily targets a client is measured against - the one
 * place it is decided: the coach's Set Calorie Intake when it is complete,
 * otherwise the plan's own targets. Never a mix of the two.
 */
export const effectiveTargetsOf = (doc) => {
  const coach = coachTargetsView(doc.coachGivenTargets);
  return coach ? { targets: coach, source: 'coach' } : { targets: targetsView(doc.targets), source: 'plan' };
};

/** Where the plan sits relative to [today] - derived from its dates, never stored. */
const periodOf = (from, to, today) => (to < today ? 'past' : from > today ? 'upcoming' : 'current');

export const toDietPlanView = (doc, foodsById, today) => {
  const coach = isObject(doc.coachId) ? doc.coachId : null;
  const enrollment = isObject(doc.enrollmentId) ? doc.enrollmentId : null;
  const fromDate = businessDayOf(doc.fromDate);
  const toDate = businessDayOf(doc.toDate);
  const selectedDates = daysOfDoc(doc);

  const meals = (doc.meals ?? []).map((m) => {
    const foods = m.foods.map((f) => {
      const food = foodsById.get(String(f.foodId)) ?? null;
      return {
        foodId: String(f.foodId),
        food: toFoodIdentity(food),
        missingFood: !food,
        qty: f.qty,
        portion: f.portion,
        servingUnit: f.servingUnit,
        /** The frozen snapshot: values for `portion` of the food. */
        perPortion: { calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat },
        /** What the member reads for this food. */
        nutrition: contributed(f),
        raw: rawContribution(f),
      };
    });
    const raw = sumRaw(foods.map((f) => f.raw));
    return { meal: m.meal, label: `Meal ${m.meal}`, foods: foods.map(({ raw: _raw, ...f }) => f), totals: roundAll(raw), raw };
  });

  return {
    id: String(doc._id),
    planId: doc.planId,
    name: doc.name,
    fromDate,
    toDate,
    /** Only when the plan applies on picked days with a gap: exactly those. */
    selectedDates,
    days: selectedDates ? selectedDates.length : Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000) + 1,
    period: periodOf(fromDate, toDate, today),
    status: doc.status,
    assignedAt: iso(doc.assignedAt),
    coach: coach ? { id: String(coach._id), name: isObject(coach.userId) ? coach.userId.profile?.name ?? null : null, level: coach.profile?.level ?? null } : null,
    /** Kept when no Coach is linked, so the author is never invisible. */
    legacyCreatedBy: doc.legacy?.createdBy ?? null,
    enrollment: enrollment
      ? {
          id: String(enrollment._id),
          planName: isObject(enrollment.planId) ? enrollment.planId.name ?? null : null,
          enrollDate: iso(enrollment.enrollDate),
          startDate: iso(enrollment.startDate),
          endDate: iso(enrollment.endDate),
          isDeleted: Boolean(enrollment.isDeleted),
        }
      : null,
    /** An enrollmentId that no longer resolves; null when there was none. */
    missingEnrollmentId: !enrollment && doc.enrollmentId ? String(doc.enrollmentId) : null,
    /** The client values the plan was calculated from; null on migrated plans. */
    gender: doc.gender ?? null,
    age: doc.age ?? null,
    height: doc.height ?? null,
    weight: doc.weight ?? null,
    activityLevel: doc.activityLevel ?? null,
    goal: doc.goal ?? null,
    bmr: doc.bmr ?? null,
    tdee: doc.tdee ?? null,
    /** The plan's own targets - kept under this key for existing readers. */
    targets: targetsView(doc.targets),
    /** The same, by the name Set Calorie Intake uses. */
    dietPlanTargets: targetsView(doc.targets),
    /** The coach's Set Calorie Intake; null until all four are set. */
    coachGivenTargets: coachTargetsView(doc.coachGivenTargets),
    coachTargetsSetAt: iso(doc.coachGivenTargets?.setAt),
    /** What the client is measured against today, and where it came from. */
    effectiveTargets: effectiveTargetsOf(doc).targets,
    targetsSource: effectiveTargetsOf(doc).source,
    totals: roundAll(sumRaw(meals.map((m) => m.raw))),
    meals: meals.map(({ raw: _raw, ...m }) => m),
    legacyPlanId: doc.legacy?.dietPlanId ?? null,
  };
};

/**
 * Which document the member sees on each day, as contiguous ranges. Same rule
 * as DietPlan.findForDay: among active documents covering the day, the newest
 * assignedAt wins, planId breaking a tie. Days no plan covers are absent.
 */
export const buildSchedule = (views) => {
  const active = views.filter((v) => v.status === 'active');
  const byDay = new Map();
  for (const v of active) {
    const days = [];
    if (v.selectedDates) days.push(...v.selectedDates);
    else for (let day = v.fromDate; day <= v.toDate; day = addCalendarDays(day, 1)) days.push(day);
    for (const day of days) {
      const best = byDay.get(day);
      if (!best || v.assignedAt > best.assignedAt || (v.assignedAt === best.assignedAt && v.planId > best.planId)) byDay.set(day, v);
    }
  }
  const ranges = [];
  for (const day of [...byDay.keys()].sort()) {
    const id = byDay.get(day).id;
    const last = ranges[ranges.length - 1];
    if (last && last.dietPlanId === id && addCalendarDays(last.to, 1) === day) last.to = day;
    else ranges.push({ from: day, to: day, dietPlanId: id });
  }
  return ranges;
};

/**
 * Plan documents -> views, with every food they reference loaded in ONE query.
 * Shared by every reader so the admin and the member see the same numbers.
 */
const toViews = async (docs, today, ownerId) => {
  const foodIds = [...new Set(docs.flatMap((d) => (d.meals ?? []).flatMap((m) => m.foods.map((f) => String(f.foodId)))))];
  const foods = foodIds.length ? await Food.find({ _id: { $in: foodIds } }).lean() : [];
  const foodsById = new Map(foods.map((f) => [String(f._id), f]));
  const missing = foodIds.filter((id) => !foodsById.has(id));
  if (missing.length) logger.warn(`Diet plans of user ${ownerId} reference ${missing.length} missing food(s): ${missing.join(', ')}`);
  return { views: docs.map((d) => toDietPlanView(d, foodsById, today)), missing };
};

const findUser = async (userId) => {
  if (!mongoose.isValidObjectId(userId)) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  const user = await User.findById(userId).select('profile.name').lean();
  if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  return user;
};

/**
 * Admin read: every diet plan of one member, newest assignment first, with the
 * day-by-day schedule the member sees.
 */
export const listDietPlansForAdmin = async (userId, { today = businessDayOf(new Date()) } = {}) => {
  const user = await findUser(userId);
  const docs = await DietPlan.find({ clientId: user._id })
    .sort({ assignedAt: -1, planId: -1, fromDate: 1 })
    .populate(POPULATE)
    .lean();
  const { views, missing } = await toViews(docs, today, userId);

  return {
    client: { id: String(user._id), name: user.profile?.name ?? null },
    today,
    dietPlans: views,
    schedule: buildSchedule(views),
    missingFoodIds: missing,
  };
};

/**
 * Member read: the ONE plan the member sees on [date] (default: today, as a
 * business day), or null. The member is always the authenticated user - never
 * an id from the request. The day rule is DietPlan.findForDay, the same rule
 * the admin schedule is built from.
 */
export const getDietPlanForDay = async (userId, { date, today = businessDayOf(new Date()) } = {}) => {
  const day = date ?? today;
  if (!isCalendarDay(day)) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'date must be a valid YYYY-MM-DD day');
  const user = await findUser(userId);

  const doc = await DietPlan.findForDay(user._id, startOfBusinessDay(day)).populate(POPULATE).lean();
  const { views, missing } = await toViews(doc ? [doc] : [], today, userId);
  return { date: day, today, dietPlan: views[0] ?? null, missingFoodIds: missing };
};

/** Consecutive date runs, as inclusive YYYY-MM-DD spans with their day counts. */
const span = (fromDate, toDate) => ({ fromDate, toDate, days: Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000) + 1 });

/** Merges spans only where one ends the day before the next starts - a real gap is never closed. */
const mergeContiguous = (spans) => {
  const out = [];
  for (const s of [...spans].sort((a, b) => a.fromDate.localeCompare(b.fromDate))) {
    const last = out[out.length - 1];
    if (last && addCalendarDays(last.toDate, 1) >= s.fromDate) {
      if (s.toDate > last.toDate) Object.assign(last, span(last.fromDate, s.toDate));
    } else out.push({ ...s });
  }
  return out;
};

/**
 * Member read: the plans the member HAD - one item per logical plan (planId),
 * its date runs grouped, newest first. A plan is history once its last covered
 * day is before today (business day); current and upcoming plans are not.
 *
 * Per plan:
 *   ranges   - the date-run documents exactly as stored (the migration's truth)
 *   coverage - those runs joined only where they touch; gaps stay gaps
 *   shown    - the days the member actually saw this plan: where a newer plan
 *              covered the same day, the newer one was shown (DietPlan.findForDay)
 *   openDate - the last shown day: open it with GET /users/me/diet-plan?date=
 *
 * Lightweight: no meals and no foods are read. The member is always the
 * authenticated user.
 */
export const getDietPlanHistoryForUser = async (userId, { today = businessDayOf(new Date()), includeCurrent = false } = {}) => {
  const user = await findUser(userId);
  const docs = await DietPlan.find({ clientId: user._id, status: 'active' })
    .select('-meals')
    .populate(POPULATE[0])
    .lean();

  // One run per contiguous stretch: a plan with picked days is one run per
  // stretch of them, so its gaps stay gaps here exactly as in the day lookup.
  const runs = docs.flatMap((d) => {
    const base = { id: String(d._id), planId: d.planId, status: d.status, assignedAt: iso(d.assignedAt), doc: d };
    const picked = daysOfDoc(d);
    if (!picked) return [{ ...base, fromDate: businessDayOf(d.fromDate), toDate: businessDayOf(d.toDate) }];
    const stretches = [];
    for (const day of picked) {
      const last = stretches[stretches.length - 1];
      if (last && addCalendarDays(last.toDate, 1) === day) last.toDate = day;
      else stretches.push({ ...base, fromDate: day, toDate: day });
    }
    return stretches;
  });
  // What the member saw on each day, by the same rule as the day lookup.
  const schedule = buildSchedule(runs);

  const groups = new Map();
  for (const r of runs) groups.set(r.planId, [...(groups.get(r.planId) ?? []), r]);

  const plans = [];
  for (const [planId, group] of groups) {
    group.sort((a, b) => a.fromDate.localeCompare(b.fromDate));
    const latestDate = group.reduce((max, r) => (r.toDate > max ? r.toDate : max), group[0].toDate);
    // Members' History lists finished plans only; a coach also sees the current
    // and upcoming ones (includeCurrent).
    if (latestDate >= today && !includeCurrent) continue;
    const earliestDate = group[0].fromDate;
    const period = latestDate < today ? 'past' : earliestDate > today ? 'upcoming' : 'current';

    const ids = new Set(group.map((r) => r.id));
    const shown = mergeContiguous(schedule.filter((s) => ids.has(s.dietPlanId)).map((s) => span(s.from, s.to)));
    const latest = group.reduce((a, b) => (b.toDate > a.toDate ? b : a)).doc;
    const coach = isObject(latest.coachId) ? latest.coachId : null;
    const coverage = mergeContiguous(group.map((r) => span(r.fromDate, r.toDate)));

    plans.push({
      planId,
      name: latest.name,
      goal: latest.goal ?? null,
      coach: coach ? { id: String(coach._id), name: isObject(coach.userId) ? coach.userId.profile?.name ?? null : null, level: coach.profile?.level ?? null } : null,
      targets: targetsView(latest.targets),
      assignedAt: iso(latest.assignedAt),
      ranges: group.map((r) => ({ dietPlanId: r.id, ...span(r.fromDate, r.toDate) })),
      coverage,
      coveredDays: coverage.reduce((n, c) => n + c.days, 0),
      shown,
      shownDays: shown.reduce((n, c) => n + c.days, 0),
      // A current plan opens on today when the member sees it today.
      openDate:
        period === 'current' && shown.some((s) => s.fromDate <= today && today <= s.toDate)
          ? today
          : shown.length
            ? shown[shown.length - 1].toDate
            : null,
      latestDate,
      /** past | current | upcoming - from the dates against today; never stored. */
      period,
    });
  }

  plans.sort((a, b) => b.latestDate.localeCompare(a.latestDate) || (b.assignedAt ?? '').localeCompare(a.assignedAt ?? '') || b.planId.localeCompare(a.planId));
  return { client: { id: String(user._id), name: user.profile?.name ?? null }, today, plans };
};

/**
 * The client behind one of the signed-in coach's own coaching cycles - the same
 * check every coach read uses (body metrics, questionnaires): the coach is the
 * token's, and the enrollment must be theirs and not deleted. A client id is
 * never accepted from the request.
 */
export const clientOfCoachEnrollment = async (coachUserId, enrollmentId) => {
  const coach = await Coach.findOne({ userId: coachUserId }, { _id: 1 }).lean();
  if (!coach) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'You do not have a coach profile');
  if (!mongoose.isValidObjectId(enrollmentId)) throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrollment not found');
  const enrollment = await EnrolledClient.findOne(
    { _id: enrollmentId, coachId: coach._id, isDeleted: { $ne: true } },
    { userId: 1 },
  ).lean();
  if (!enrollment) throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrollment not found');
  return String(enrollment.userId);
};

/**
 * Coach read: the client's diet plans - exactly the member's History items
 * (same grouping, runs, coverage, shown days, newest-wins), plus the current
 * and upcoming plans a coach also needs.
 */
export const getDietPlanHistoryForCoach = async (coachUserId, enrollmentId, options = {}) =>
  getDietPlanHistoryForUser(await clientOfCoachEnrollment(coachUserId, enrollmentId), { ...options, includeCurrent: true });

/** Coach read: the plan the client sees on a day - the member's own day lookup. */
export const getDietPlanForDayForCoach = async (coachUserId, enrollmentId, options = {}) =>
  getDietPlanForDay(await clientOfCoachEnrollment(coachUserId, enrollmentId), options);

/**
 * Set Calorie Intake: the signed-in coach sets the daily targets the client of
 * one of their own enrollments is measured against, on one diet plan.
 *
 * Ownership comes from the token and the enrollment, never the body: the
 * enrollment must be this coach's and live (clientOfCoachEnrollment), the plan
 * must be that client's and active, and a plan tied to an enrollment must be
 * tied to this one - a plan another coaching cycle owns is refused. A plan
 * with no enrollment (migrated ones) is reached through its client.
 *
 * One targeted $set of `coachGivenTargets` (plus updatedBy): the plan's own
 * `targets`, meals, dates and everything else are untouched, and no document
 * is created. Returns the values as stored.
 */
export const setCoachTargetsForCoach = async (coachUserId, enrollmentId, dietPlanId, input, { now = new Date() } = {}) => {
  const clientId = await clientOfCoachEnrollment(coachUserId, enrollmentId);
  const missing = () => notFound(ERROR_CODES.DIET_PLAN_NOT_FOUND, 'Diet plan not found');
  if (!mongoose.isValidObjectId(dietPlanId)) throw missing();

  const doc = await DietPlan.findOne(
    { _id: dietPlanId, clientId, status: 'active' },
    { enrollmentId: 1 },
  ).lean();
  if (!doc) throw missing();
  if (doc.enrollmentId && String(doc.enrollmentId) !== String(enrollmentId)) {
    throw forbidden(ERROR_CODES.FORBIDDEN, 'This plan belongs to another coaching cycle');
  }

  const updated = await DietPlan.findOneAndUpdate(
    { _id: dietPlanId, clientId, status: 'active' },
    { $set: { coachGivenTargets: { ...input, setAt: now, setBy: coachUserId }, updatedBy: coachUserId } },
    { new: true, runValidators: true, projection: { targets: 1, coachGivenTargets: 1 } },
  ).lean();
  if (!updated) throw missing();
  const effective = effectiveTargetsOf(updated);
  return {
    dietPlanId: String(updated._id),
    dietPlanTargets: targetsView(updated.targets),
    coachGivenTargets: coachTargetsView(updated.coachGivenTargets),
    coachTargetsSetAt: iso(updated.coachGivenTargets?.setAt),
    effectiveTargets: effective.targets,
    targetsSource: effective.source,
  };
};

/**
 * THE diet plan write - shared by the coach's app and the Admin Portal: a NEW
 * diet plan for one enrollment. Every call creates a document - nothing is
 * ever matched by name, client, enrollment or dates, so no existing plan
 * (migrated or not) is touched.
 *
 * Ownership comes from the enrollment, never the request: [actor] is
 * { userId, role } from the token (a coach may only use their own
 * enrollments - 403 otherwise; an admin any live one), client = the
 * enrollment's member, coach = the enrollment's coach (null stays null - an
 * admin never becomes the coach), createdBy/updatedBy = the actor.
 *
 * [input] is validateCreateDietPlan's output. Every number stored is the
 * server's: each food must be an active Food in its own serving unit, and its
 * nutrition is that Food's per-serving values x qty / servingQuantity (portion
 * = qty, the actual amount). bmr, tdee and targets are the coach's figures as
 * the app sent them (validated). Everything is checked before the one insert, so
 * a refused plan writes nothing.
 */
export const createDietPlan = async ({ actor, enrollmentId, input, now = new Date() }) => {
  const enrollment = await resolveEnrollmentForActor(actor, enrollmentId);

  // Every referenced food must exist, be in use and be given in its own unit.
  const foodIds = [...new Set(input.meals.flatMap((m) => m.foods.map((f) => f.foodId)))];
  const active = await Food.find(
    { _id: { $in: foodIds }, status: 'active' },
    { servingUnit: 1, servingQuantity: 1, calories: 1, fat: 1, carbs: 1, protein: 1 },
  ).lean();
  const foods = new Map(active.map((f) => [String(f._id), f]));
  const unusable = foodIds.filter((id) => !foods.has(id));
  if (unusable.length) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `Unknown or archived food(s): ${unusable.join(', ')}`);
  }
  const meals = input.meals.map(({ meal, foods: assigned }) => ({
    meal,
    foods: assigned.map(({ foodId, qty, servingUnit }) => {
      const food = foods.get(foodId);
      if (servingUnit !== food.servingUnit) {
        throw badRequest(ERROR_CODES.VALIDATION_ERROR, `Food ${foodId} is measured in ${food.servingUnit}, not ${servingUnit}`);
      }
      if (!(food.servingQuantity > 0)) {
        throw badRequest(ERROR_CODES.VALIDATION_ERROR, `Food ${foodId} has no serving quantity to scale from`);
      }
      const factor = qty / food.servingQuantity;
      return {
        foodId,
        qty,
        portion: qty,
        servingUnit: food.servingUnit,
        calories: round2(food.calories * factor),
        fat: round2(food.fat * factor),
        carbs: round2(food.carbs * factor),
        protein: round2(food.protein * factor),
      };
    }),
  }));

  // The coach's figures, exactly as the app showed and sent them.
  const { bmr, tdee, targets } = input;

  // A new identity: planId is the document's own id - never a name, a date or
  // a "gogetfit:" legacy id.
  const _id = new mongoose.Types.ObjectId();
  await DietPlan.create({
    _id,
    planId: String(_id),
    clientId: enrollment.userId,
    enrollmentId: enrollment._id,
    coachId: enrollment.coachId,
    name: input.name,
    gender: input.gender,
    age: input.age,
    height: input.height,
    weight: input.weight,
    activityLevel: input.activityLevel,
    goal: input.goal,
    bmr,
    tdee,
    targets,
    meals,
    fromDate: startOfBusinessDay(input.fromDate),
    toDate: startOfBusinessDay(input.toDate),
    ...(input.selectedDates ? { selectedDates: input.selectedDates.map((d) => startOfBusinessDay(d)) } : {}),
    status: 'active',
    assignedAt: now,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });

  const saved = await DietPlan.findById(_id).populate(POPULATE).lean();
  const { views } = await toViews([saved], businessDayOf(now), String(enrollment.userId));
  return views[0];
};

/** Coach write: createDietPlan for the signed-in coach (their own enrollments only). */
export const createDietPlanForCoach = (coachUserId, enrollmentId, input, { now } = {}) =>
  createDietPlan({ actor: { userId: coachUserId, role: ACTOR_COACH }, enrollmentId, input, now });

/** Admin write: createDietPlan for any live enrollment; the coach stays the enrollment's. */
export const createDietPlanForAdmin = (adminUserId, enrollmentId, input, { now } = {}) =>
  createDietPlan({ actor: { userId: adminUserId, role: ACTOR_ADMIN }, enrollmentId, input, now });

export default { createDietPlan, createDietPlanForAdmin, createDietPlanForCoach, listDietPlansForAdmin, getDietPlanForDay, getDietPlanHistoryForUser, getDietPlanHistoryForCoach, getDietPlanForDayForCoach, toDietPlanView, buildSchedule, contributed };
