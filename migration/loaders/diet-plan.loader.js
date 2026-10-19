import { isDeepStrictEqual } from 'node:util';

import Coach from '../../src/models/coach.model.js';
import DietPlan from '../../src/models/diet-plan.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import Food from '../../src/models/food.model.js';
import User from '../../src/models/user.model.js';
import { startOfBusinessDay } from '../../src/utils/business-date.js';
import { buildCoachDirectory, normalizeEmail, resolveLegacyCoach } from '../mappings/legacy-coach.mapping.js';
import { addDays, dateRuns, transformDietPlan } from '../transformers/diet-plan.transformer.js';

/**
 * m_diet_plan + r_diet_plan_meal + r_diet_plan_dates -> dietplans.
 *
 * buildReferences resolves every legacy id to a Mongo reference by the verified
 * bridges only (users.legacy.userId, foods.legacy.foodId, Coach via two agreeing
 * paths). transformAll classifies every plan; replay compares the result with
 * the legacy runtime day by day; applyDietPlans creates documents and never
 * updates or deletes one.
 */

const IST_MS = 5.5 * 3_600_000;
/** The IST calendar day of a stored business-day Date. */
export const businessDayOf = (date) => (date ? new Date(date.getTime() + IST_MS).toISOString().slice(0, 10) : null);

const round1 = (n) => Number(n.toFixed(1));

/**
 * Resolves owners, creators, foods and enrollment windows.
 *
 * Coach: set only when (1) created_by -> users.legacy.userId -> Coach.userId and
 * (2) created_by's m_user.email_id -> exactly one m_coach -> the legacy-coach
 * mapping both name the same Coach. The m_coach id from (2) also decides
 * between overlapping enrollments (transformer, enrollmentForDay).
 */
export const buildReferences = async ({ plans, legacyUsers, legacyCoaches, foodIds, source }) => {
  const personIds = [...new Set(plans.flatMap((p) => [Number(p.user_id), Number(p.created_by)]))];
  const users = await User.find({ 'legacy.source': source, 'legacy.userId': { $in: personIds } }).select('_id legacy').lean();
  const userByLegacy = new Map(users.map((u) => [u.legacy.userId, u._id]));

  const coaches = await Coach.find({}).select('_id userId').lean();
  const coachByUser = new Map(coaches.map((c) => [String(c.userId), c._id]));
  const directory = await buildCoachDirectory();
  const legacyUserById = new Map(legacyUsers.map((u) => [Number(u.user_id), u]));
  const legacyCoachesByEmail = new Map();
  for (const c of legacyCoaches) {
    const email = normalizeEmail(c.email);
    if (!email) continue;
    if (!legacyCoachesByEmail.has(email)) legacyCoachesByEmail.set(email, []);
    legacyCoachesByEmail.get(email).push(c);
  }

  const creators = new Map();
  for (const createdBy of new Set(plans.map((p) => Number(p.created_by)))) {
    const legacyUser = legacyUserById.get(createdBy);
    const user = userByLegacy.get(createdBy);
    const viaUser = user ? coachByUser.get(String(user)) ?? null : null;
    const matches = legacyUser ? legacyCoachesByEmail.get(normalizeEmail(legacyUser.email_id)) ?? [] : [];
    const legacyCoach = matches.length === 1 ? matches[0] : null;
    const viaMapping = legacyCoach
      ? resolveLegacyCoach({ name: [legacyCoach.first_name, legacyCoach.last_name].filter(Boolean).join(' '), email: legacyCoach.email }, directory)
      : null;

    let coachId = null;
    let reason;
    if (!legacyUser) reason = `m_user ${createdBy} does not exist`;
    else if (!legacyCoach) reason = matches.length > 1 ? 'email matches several m_coach rows' : 'not a legacy coach (no m_coach with this email)';
    else if (!viaUser) reason = 'no Mongo Coach for this user';
    else if (viaMapping?.status !== 'matched') reason = `legacy-coach mapping: ${viaMapping?.status}`;
    else if (String(viaMapping.coach.coachId) !== String(viaUser)) reason = 'user path and legacy-coach mapping disagree';
    else coachId = viaUser;
    creators.set(createdBy, { coachId, legacyCoachId: legacyCoach ? Number(legacyCoach.coach_id) : null, reason: coachId ? 'verified' : reason });
  }

  const foodDocs = await Food.find({ 'legacy.source': source, 'legacy.foodId': { $in: foodIds } })
    .select('_id legacy servingUnit servingQuantity')
    .lean();
  const foods = new Map(foodDocs.map((f) => [f.legacy.foodId, { _id: f._id, servingUnit: f.servingUnit, servingQuantity: f.servingQuantity }]));

  const enrollments = await EnrolledClient.find({ userId: { $in: users.map((u) => u._id) }, isDeleted: { $ne: true }, startDate: { $ne: null }, endDate: { $ne: null } })
    .select('_id userId startDate endDate legacy.coachId')
    .lean();
  const enrollmentsByUser = new Map();
  for (const e of enrollments) {
    const key = String(e.userId);
    if (!enrollmentsByUser.has(key)) enrollmentsByUser.set(key, []);
    enrollmentsByUser.get(key).push({ id: e._id, from: businessDayOf(e.startDate), to: businessDayOf(e.endDate), legacyCoachId: e.legacy?.coachId ?? null });
  }

  return { userByLegacy, legacyUserById, creators, foods, enrollmentsByUser };
};

/** Every plan transformed and classified, in diet_plan_id order. */
export const transformAll = ({ plans, dateRows, mealRows, refs, source, runId = null, version = null, migratedAt = null }) => {
  const daysByPlan = new Map();
  for (const r of dateRows) {
    const id = Number(r.diet_plan_id);
    if (!daysByPlan.has(id)) daysByPlan.set(id, []);
    daysByPlan.get(id).push(r.day);
  }
  const rowsByPlan = new Map();
  for (const r of mealRows) {
    const id = Number(r.diet_plan_id);
    if (!rowsByPlan.has(id)) rowsByPlan.set(id, []);
    rowsByPlan.get(id).push(r);
  }

  return plans.map((plan) => {
    const clientId = refs.userByLegacy.get(Number(plan.user_id)) ?? null;
    const creator = refs.creators.get(Number(plan.created_by)) ?? { coachId: null, legacyCoachId: null, reason: 'unknown' };
    const result = transformDietPlan(plan, {
      source,
      runId,
      version,
      migratedAt,
      days: daysByPlan.get(Number(plan.diet_plan_id)) ?? [],
      mealRows: rowsByPlan.get(Number(plan.diet_plan_id)) ?? [],
      clientId,
      coachId: creator.coachId,
      creatorLegacyCoachId: creator.legacyCoachId,
      enrollments: clientId ? refs.enrollmentsByUser.get(String(clientId)) ?? [] : [],
      foods: refs.foods,
    });
    const ownerExists = refs.legacyUserById.has(Number(plan.user_id));
    return {
      ...result,
      legacyUserId: Number(plan.user_id),
      createdBy: Number(plan.created_by),
      coachReason: creator.reason,
      ownerExistsInLegacy: ownerExists,
    };
  });
};

export const BLOCKED_CLIENT_HAS_BLOCKED_PLAN = 'blocked_client_has_blocked_plan';

/**
 * A client is migrated whole or not at all. Leaving out one dated plan of a
 * client while migrating the others would let an older plan show on the days
 * the missing newer plan used to win - a wrong plan, not just a missing one.
 */
export const gateByClient = (results) => {
  const blockedClients = new Set(
    results.filter((r) => r.status !== 'migratable' && r.status !== 'not_migrated_no_dates').map((r) => r.legacyUserId),
  );
  return results.map((r) =>
    r.status === 'migratable' && blockedClients.has(r.legacyUserId)
      ? { ...r, status: BLOCKED_CLIENT_HAS_BLOCKED_PLAN, reasons: [{ code: BLOCKED_CLIENT_HAS_BLOCKED_PLAN, reason: 'another dated plan of this client is blocked' }], documents: [] }
      : r,
  );
};

/** The new runtime rule over in-memory documents - identical to DietPlan.findForDay. */
export const selectForDay = (documents, clientId, day) => {
  const at = startOfBusinessDay(day).getTime();
  let best = null;
  for (const d of documents) {
    if (String(d.clientId) !== String(clientId) || d.status !== 'active') continue;
    if (d.fromDate.getTime() > at || d.toDate.getTime() < at) continue;
    if (!best || d.assignedAt > best.assignedAt || (d.assignedAt.getTime() === best.assignedAt.getTime() && d.planId > best.planId)) best = d;
  }
  return best;
};

/** What the member reads for one food: value / portion * qty, to one decimal. */
export const shown = (value, portion, qty) => (portion ? round1((value / portion) * qty) : null);

/**
 * Day-by-day comparison with the legacy runtime.
 *
 * @param legacySelect (userId, day) -> legacy selected row or null (the verbatim query)
 * @param legacyMeals  (dietPlanId) -> [{ mealId, foods: rows }] for meal 1..8 (verbatim query)
 * @param clients      [{ legacyUserId, clientId, days: [yyyy-mm-dd] }] - clients whose plans are ALL migratable
 * @param foodLegacyId Mongo Food _id -> legacy food_id
 */
export const replay = async ({ documents, clients, legacySelect, legacyMeals, foodLegacyId, concurrency = 6 }) => {
  const jobs = [];
  for (const c of clients) {
    const sorted = [...new Set(c.days)].sort();
    for (let day = addDays(sorted[0], -1); day <= addDays(sorted[sorted.length - 1], 1); day = addDays(day, 1)) jobs.push({ c, day });
  }

  const contentCache = new Map();
  const contentOf = async (dietPlanId) => {
    if (!contentCache.has(dietPlanId)) contentCache.set(dietPlanId, legacyMeals(dietPlanId));
    return contentCache.get(dietPlanId);
  };

  const result = { days: 0, assignedDays: 0, emptyDays: 0, foodsCompared: 0, mismatches: [] };
  const fail = (job, field, legacy, mongo) => result.mismatches.push({ legacyUserId: job.c.legacyUserId, day: job.day, field, legacy, mongo });

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const legacyRow = await legacySelect(job.c.legacyUserId, job.day);
      const doc = selectForDay(documents, job.c.clientId, job.day);
      result.days += 1;
      if (!legacyRow) result.emptyDays += 1;
      else result.assignedDays += 1;

      const legacyId = legacyRow ? Number(legacyRow.diet_plan_id) : null;
      const mongoId = doc ? doc.legacy.dietPlanId : null;
      if (legacyId !== mongoId) { fail(job, 'selectedPlan', legacyId, mongoId); continue; }
      if (!doc) continue;

      if (legacyRow.diet_plan_name !== doc.name) fail(job, 'name', legacyRow.diet_plan_name, doc.name);
      for (const [l, m] of [['total_calories', 'calories'], ['fat', 'fat'], ['carbs', 'carbs'], ['protein', 'protein']]) {
        if (Number(legacyRow[l]) !== doc.targets[m]) fail(job, `targets.${m}`, Number(legacyRow[l]), doc.targets[m]);
      }

      const legacyContent = await contentOf(legacyId);
      const legacyMealsWithFood = legacyContent.filter((m) => m.foods.length > 0);
      if (!isDeepStrictEqual(legacyMealsWithFood.map((m) => m.mealId), doc.meals.map((m) => m.meal))) {
        fail(job, 'meals', legacyMealsWithFood.map((m) => m.mealId), doc.meals.map((m) => m.meal));
        continue;
      }
      for (const [i, legacyMeal] of legacyMealsWithFood.entries()) {
        const mongoFoods = doc.meals[i].foods;
        const legacyFoods = legacyMeal.foods;
        if (legacyFoods.length !== mongoFoods.length) { fail(job, `meal ${legacyMeal.mealId} food count`, legacyFoods.length, mongoFoods.length); continue; }
        // Legacy orders by food_id only; rows of the same food in one meal have no defined
        // order there, so they are compared as a group, everything else position by position.
        const key = (f) => JSON.stringify(f);
        const lRows = legacyFoods.map((f) => ({ foodId: Number(f.food_id), qty: Number(f.quantity), portion: Number(f.originalqty), unit: String(f.unit).toLowerCase(), calories: Number(f.calories), fat: Number(f.fats), carbs: Number(f.carbs), protein: Number(f.proteins) }));
        const mRows = mongoFoods.map((f) => ({ foodId: foodLegacyId.get(String(f.foodId)), qty: f.qty, portion: f.portion, unit: f.servingUnit.toLowerCase(), calories: f.calories, fat: f.fat, carbs: f.carbs, protein: f.protein }));
        const lIds = lRows.map((r) => r.foodId);
        const mIds = mRows.map((r) => r.foodId);
        if (!isDeepStrictEqual(lIds, mIds)) { fail(job, `meal ${legacyMeal.mealId} food order`, lIds, mIds); continue; }
        const groups = new Map();
        lRows.forEach((r, j) => {
          if (!groups.has(r.foodId)) groups.set(r.foodId, { l: [], m: [] });
          groups.get(r.foodId).l.push(key(r));
          groups.get(r.foodId).m.push(key(mRows[j]));
        });
        for (const [foodId, g] of groups) {
          if (!isDeepStrictEqual([...g.l].sort(), [...g.m].sort())) fail(job, `meal ${legacyMeal.mealId} food ${foodId}`, g.l, g.m);
        }
        for (const [j, r] of lRows.entries()) {
          const m = mRows[j];
          for (const v of ['calories', 'fat', 'carbs', 'protein']) {
            if (r.foodId === m.foodId && lRows.filter((x) => x.foodId === r.foodId).length === 1 && shown(r[v], r.portion, r.qty) !== shown(m[v], m.portion, m.qty)) {
              fail(job, `meal ${legacyMeal.mealId} food ${r.foodId} shown ${v}`, shown(r[v], r.portion, r.qty), shown(m[v], m.portion, m.qty));
            }
          }
        }
        result.foodsCompared += lRows.length;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, worker));
  result.mismatches.sort((a, b) => a.legacyUserId - b.legacyUserId || a.day.localeCompare(b.day));
  return result;
};

/**
 * Every plan-level field the design keeps, checked on every document against
 * its m_diet_plan row - independently of the replay, which only sees what the
 * member screens select. Values must be identical (strings verbatim, numbers
 * exactly, NULL stays null).
 */
export const PLAN_FIELD_MAP = [
  ['diet_plan_name', (d) => d.name, (v) => v],
  ['total_calories', (d) => d.targets.calories, (v) => Number(v)],
  ['fat', (d) => d.targets.fat, (v) => Number(v)],
  ['carbs', (d) => d.targets.carbs, (v) => Number(v)],
  ['protein', (d) => d.targets.protein, (v) => Number(v)],
  ['bmr', (d) => d.bmr, (v) => (v == null ? null : Number(v))],
  ['tdee', (d) => d.tdee, (v) => (v == null ? null : Number(v))],
  ['goal', (d) => d.goal, (v) => v ?? null],
  ['created_by', (d) => d.legacy.createdBy, (v) => (v == null ? null : Number(v))],
];

export const verifyPlanFields = (documents, plans, { legacyInstant }) => {
  const planById = new Map(plans.map((p) => [Number(p.diet_plan_id), p]));
  const mismatches = [];
  const checked = {};
  for (const d of documents) {
    const plan = planById.get(d.legacy.dietPlanId);
    if (!plan) { mismatches.push({ dietPlanId: d.legacy.dietPlanId, field: 'm_diet_plan row', legacy: null, mongo: 'present' }); continue; }
    const pairs = [
      ...PLAN_FIELD_MAP.map(([column, get, norm]) => [column, norm(plan[column]), get(d)]),
      ['create_date -> assignedAt', legacyInstant(plan.create_date)?.toISOString() ?? null, d.assignedAt?.toISOString() ?? null],
      ['create_date -> legacy.createDate', legacyInstant(plan.create_date)?.toISOString() ?? null, d.legacy.createDate?.toISOString() ?? null],
      ['last_update_date -> legacy.lastUpdateDate', legacyInstant(plan.last_update_date)?.toISOString() ?? null, d.legacy.lastUpdateDate?.toISOString() ?? null],
      ['diet_plan_id -> planId', `${d.legacy.source}:${plan.diet_plan_id}`, d.planId],
    ];
    for (const [field, legacy, mongo] of pairs) {
      checked[field] = (checked[field] ?? 0) + 1;
      if (!Object.is(legacy, mongo)) mismatches.push({ dietPlanId: d.legacy.dietPlanId, segment: d.legacy.segment.index, field, legacy, mongo });
    }
  }
  return { documents: documents.length, checked, mismatches };
};

/** Runs every document through the Mongoose schema without saving. */
export const validateDocuments = async (documents) => {
  const errors = [];
  for (const d of documents) {
    try {
      await new DietPlan(d).validate();
    } catch (error) {
      errors.push({ dietPlanId: d.legacy?.dietPlanId, segment: d.legacy?.segment?.index, error: error.message });
    }
  }
  return errors;
};

const comparable = (d) => {
  const { _id, createdAt, updatedAt, migration, ...rest } = d;
  return JSON.parse(JSON.stringify(rest));
};

/**
 * Creates documents that do not exist yet. An existing document (same legacy
 * plan and segment) that is identical is skipped; one that differs is reported
 * and nothing in the run is written - never overwritten.
 */
export const applyDietPlans = async (documents, { session = null } = {}) => {
  const existing = await DietPlan.find({ 'legacy.dietPlanId': { $in: [...new Set(documents.map((d) => d.legacy.dietPlanId))] } })
    .session(session)
    .lean();
  const byKey = new Map(existing.map((d) => [`${d.legacy.source}|${d.legacy.dietPlanId}|${d.legacy.segment.index}`, d]));

  const toCreate = [];
  const unchanged = [];
  const conflicts = [];
  for (const d of documents) {
    const found = byKey.get(`${d.legacy.source}|${d.legacy.dietPlanId}|${d.legacy.segment.index}`);
    if (!found) toCreate.push(d);
    else if (isDeepStrictEqual(comparable(found), comparable(new DietPlan(d).toObject()))) unchanged.push(d);
    else conflicts.push({ dietPlanId: d.legacy.dietPlanId, segment: d.legacy.segment.index });
  }
  const plansInDb = new Set(existing.map((d) => d.legacy.dietPlanId));
  const segmentCountChanged = [...plansInDb].filter(
    (id) => existing.filter((d) => d.legacy.dietPlanId === id).length !== documents.filter((d) => d.legacy.dietPlanId === id).length,
  );

  if (conflicts.length > 0 || segmentCountChanged.length > 0) {
    return { created: 0, unchanged: unchanged.length, conflicts, segmentCountChanged, written: false };
  }
  if (toCreate.length > 0) await DietPlan.insertMany(toCreate, { session, ordered: true });
  return { created: toCreate.length, unchanged: unchanged.length, conflicts, segmentCountChanged, written: toCreate.length > 0 };
};
