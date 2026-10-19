/**
 * READ-ONLY design analysis for the coach-assigned diet plans
 * (m_diet_plan + r_diet_plan_meal + r_diet_plan_dates). Writes nothing to
 * MariaDB (read-only pool) or MongoDB (reads only); the full result goes to
 * migration/reports/runs/diet-plan-analysis-<ts>.json.
 *
 *   node migration/scripts/analyze-diet-plans.js
 *
 * It reconstructs what the legacy member app showed for every client/date and
 * checks the reconstruction against the legacy SQL itself:
 *
 *   1. day selection - api/ggf.Data/WorkoutDAL.cs GetDietPlanDetails, run
 *      verbatim (userId branch) for every (client, assigned date) and for the
 *      gap days inside each client's span, with the date in the exact
 *      "d-M-yyyy" form the Flutter app sends (view_plans.dart);
 *   2. day content - api/ggf.Data/DietDAL.cs GetDietPlanMeals, run verbatim
 *      for meal_id 1..8 of every plan (DietService loops i = 1..8);
 *   3. displayed nutrition - get_meal_plan_list_screen.dart shows
 *      value / originalqty * quantity, originalqty = CAST(m_food.qty AS INT).
 *
 * It then checks two candidate fromDate/toDate representations against that
 * replay, day by day, and classifies every plan.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import mongoose from 'mongoose';

import { closePool, query } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';

const DAY = 86_400_000;
const dayKey = (value) => (value == null ? null : String(value).slice(0, 10));
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const appDate = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return `${d}-${m}-${y}`; // exactly what view_plans.dart builds: day-month-year, no padding, no time
};
/** IST calendar day of a Mongo Date (legacy datetimes were IST wall-clock values). */
const istDay = (date) => (date ? new Date(date.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10) : null);
const runs = (sortedKeys) => {
  const out = [];
  for (const key of sortedKeys) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === key) last.to = key;
    else out.push({ from: key, to: key });
  }
  return out;
};
const group = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    const k = key(row);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
};
const round1 = (n) => Number(n.toFixed(1));

/** A read retried on a dropped connection: every statement here is a SELECT, so a retry cannot change anything. */
const read = async (sql, attempts = 4) => {
  for (let i = 1; ; i += 1) {
    try {
      return await query(sql);
    } catch (error) {
      if (i >= attempts || !/ETIMEDOUT|ECONNRESET|PROTOCOL_CONNECTION_LOST|closed/i.test(`${error.code} ${error.message}`)) throw error;
    }
  }
};

/** Runs fn over items with a small fixed concurrency; results keep the input order. */
const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
};

/** api/ggf.Data/WorkoutDAL.cs:162 GetDietPlanDetails, userId branch, verbatim. */
const legacySelectSql = (userId, date) => `select
    a.diet_plan_id
    , a.diet_plan_name
    , b.diet_date
    , a.total_calories
    , a.fat
    , a.carbs
    , a.protein


from
    m_diet_plan a inner join r_diet_plan_dates b
        on a.diet_plan_id = b.diet_plan_id
where
    a.diet_plan_id in (
        select
            c.diet_plan_id
        from
            m_diet_plan c
        where  c.user_id = '${userId}' order by c.create_date desc )  and b.diet_date = STR_TO_DATE('${date}', '%d-%m-%Y %H:%i:%s') order by a.create_date desc limit 1`;

/** api/ggf.Data/DietDAL.cs:376 GetDietPlanMeals, verbatim. */
const legacyMealsSql = (planId, mealId) => `select

     a.food_id
    , c.food_name
    , c.brand_name
    , a.quantity
    , CAST(c.qty as INT) as originalqty
    , c.unit
    , c.image_file_name
    , a.calories
    , a.fats
    , a.carbs
    , a.proteins
from
    r_diet_plan_meal a
    inner join m_meal b
        on a.meal_id = b.meal_id

    inner join m_food c
        on a.food_id = c.food_id
        where diet_plan_id = '${planId}' and a.meal_id ='${mealId}' order by a.meal_id, a.food_id`;

export const analyzeDietPlans = async () => {
  const db = mongoose.connection.db;

  // ── legacy extraction ──────────────────────────────────────────────────────
  const plans = await query('SELECT * FROM m_diet_plan ORDER BY diet_plan_id');
  const mealRows = await query('SELECT * FROM r_diet_plan_meal ORDER BY diet_plan_id, meal_id, food_id, create_date');
  const dateRows = await query('SELECT * FROM r_diet_plan_dates ORDER BY diet_plan_id, diet_date');
  const meals = await query('SELECT * FROM m_meal ORDER BY meal_id');
  const foodIds = [...new Set(mealRows.map((r) => r.food_id))];
  const legacyFoods = foodIds.length
    ? await query(
        `SELECT food_id, food_name, unit, qty, CAST(qty AS INT) AS originalqty, delete_flg FROM m_food WHERE food_id IN (${foodIds.join(',')})`,
      )
    : [];
  const userCols = (await query('SHOW COLUMNS FROM m_user')).map((c) => c.Field);
  const personIds = [...new Set(plans.flatMap((p) => [p.user_id, p.created_by]))];
  const legacyUsers = await query(
    `SELECT user_id, ${['first_name', 'last_name', 'email_id', 'user_type', 'role_id', 'delete_flg'].filter((c) => userCols.includes(c)).join(', ')} FROM m_user WHERE user_id IN (${personIds.join(',')})`,
  );
  const coachRows = await query('SELECT coach_id, first_name, last_name, email FROM m_coach');
  const dateTimes = await query(
    "SELECT COUNT(*) n, SUM(TIME(diet_date) <> '00:00:00') nonMidnight, SUM(diet_date IS NULL) nulls FROM r_diet_plan_dates",
  );

  const planById = new Map(plans.map((p) => [p.diet_plan_id, p]));
  const legacyFoodById = new Map(legacyFoods.map((f) => [f.food_id, f]));
  const legacyUserById = new Map(legacyUsers.map((u) => [u.user_id, u]));
  const mealIds = new Set(meals.map((m) => m.meal_id));

  // ── MongoDB reference data (read only) ─────────────────────────────────────
  const source = migrationEnv.source;
  const users = await db
    .collection('users')
    .find({ 'legacy.source': source, 'legacy.userId': { $in: personIds } }, { projection: { legacy: 1, roles: 1, 'profile.name': 1, 'profile.email': 1 } })
    .toArray();
  const userByLegacy = new Map(users.map((u) => [u.legacy.userId, u]));
  const coaches = await db.collection('coaches').find({}, { projection: { userId: 1, status: 1 } }).toArray();
  const coachByUserId = new Map(coaches.map((c) => [String(c.userId), c]));
  const mongoFoods = await db
    .collection('foods')
    .find({ 'legacy.source': source, 'legacy.foodId': { $in: foodIds } }, { projection: { legacy: 1, servingUnit: 1, servingQuantity: 1, status: 1 } })
    .toArray();
  const mongoFoodByLegacy = new Map(mongoFoods.map((f) => [f.legacy.foodId, f]));
  const enrollments = await db
    .collection('enrolledclients')
    .find({}, { projection: { userId: 1, coachId: 1, startDate: 1, endDate: 1, legacy: 1, isDeleted: 1 } })
    .toArray();
  const enrollmentsByUser = group(enrollments, (e) => String(e.userId));

  // ── data profile ───────────────────────────────────────────────────────────
  const mealsByPlan = group(mealRows, (r) => r.diet_plan_id);
  const datesByPlan = group(dateRows, (r) => r.diet_plan_id);
  const orphanMealPlanIds = [...mealsByPlan.keys()].filter((id) => !planById.has(id));
  const orphanDatePlanIds = [...datesByPlan.keys()].filter((id) => !planById.has(id));

  const planDates = new Map(); // planId -> sorted distinct day keys
  const duplicateDateRows = [];
  for (const plan of plans) {
    const keys = (datesByPlan.get(plan.diet_plan_id) ?? []).map((r) => dayKey(r.diet_date)).filter(Boolean);
    const distinct = [...new Set(keys)].sort();
    if (distinct.length !== keys.length) duplicateDateRows.push({ planId: plan.diet_plan_id, rows: keys.length, distinct: distinct.length });
    planDates.set(plan.diet_plan_id, distinct);
  }

  // ── day content: the verbatim legacy meal query for every plan ─────────────
  const content = new Map(); // planId -> [{ mealId, foods: [...] }]
  const mealJobs = plans.flatMap((plan) => [1, 2, 3, 4, 5, 6, 7, 8].map((mealId) => ({ planId: plan.diet_plan_id, mealId })));
  const mealResults = await mapLimit(mealJobs, 6, (job) => read(legacyMealsSql(job.planId, job.mealId)));
  mealJobs.forEach((job, i) => {
    if (!content.has(job.planId)) content.set(job.planId, []);
    content.get(job.planId).push({ mealId: job.mealId, foods: mealResults[i] });
  });

  const hiddenRows = []; // meal rows the legacy query never shows
  for (const row of mealRows) {
    if (!planById.has(row.diet_plan_id)) continue;
    const reasons = [];
    if (!mealIds.has(row.meal_id)) reasons.push(`meal_id ${row.meal_id} not in m_meal`);
    if (row.meal_id < 1 || row.meal_id > 8) reasons.push(`meal_id ${row.meal_id} outside the 1..8 loop`);
    if (!legacyFoodById.has(row.food_id)) reasons.push(`food_id ${row.food_id} not in m_food`);
    if (reasons.length) hiddenRows.push({ planId: row.diet_plan_id, mealId: row.meal_id, foodId: row.food_id, reasons });
  }

  const foodProblems = [];
  const ambiguousOrder = [];
  const originalQtyIssues = [];
  for (const [planId, planMeals] of content) {
    for (const { mealId, foods } of planMeals) {
      const byFood = group(foods, (f) => f.food_id);
      for (const [foodId, same] of byFood) {
        const variants = new Set(same.map((f) => JSON.stringify([f.quantity, f.calories, f.fats, f.carbs, f.proteins])));
        if (variants.size > 1) ambiguousOrder.push({ planId, mealId, foodId, rows: same.length, variants: variants.size });
      }
      for (const f of foods) {
        const mongo = mongoFoodByLegacy.get(f.food_id);
        const legacy = legacyFoodById.get(f.food_id);
        if (!mongo) {
          foodProblems.push({
            planId,
            mealId,
            foodId: f.food_id,
            reason: legacy?.delete_flg === '1' || legacy?.delete_flg === 1 ? 'food deleted in legacy (not migrated)' : 'food not in Mongo foods',
          });
        }
        if (!f.originalqty) originalQtyIssues.push({ planId, mealId, foodId: f.food_id, qty: legacy?.qty ?? null, originalqty: f.originalqty, issue: 'originalqty is 0: the app divides by zero' });
        else if (mongo && mongo.servingQuantity !== Number(f.originalqty)) {
          originalQtyIssues.push({ planId, mealId, foodId: f.food_id, qty: legacy?.qty ?? null, originalqty: f.originalqty, mongoServingQuantity: mongo.servingQuantity, issue: 'Mongo servingQuantity differs from the legacy CAST(qty AS INT) divisor' });
        }
      }
    }
  }

  // ── day selection: reconstruction, then verbatim legacy SQL for every day ──
  const plansByUser = group(plans, (p) => p.user_id);
  const expected = new Map(); // `${user}|${day}` -> planId | null
  const ties = [];
  const userSpans = [];
  for (const [userId, userPlans] of plansByUser) {
    const dayCandidates = new Map();
    for (const plan of userPlans) for (const key of planDates.get(plan.diet_plan_id)) {
      if (!dayCandidates.has(key)) dayCandidates.set(key, []);
      dayCandidates.get(key).push(plan);
    }
    const days = [...dayCandidates.keys()].sort();
    if (days.length === 0) continue;
    userSpans.push({ userId, from: days[0], to: days[days.length - 1] });
    for (let key = addDays(days[0], -1); key <= addDays(days[days.length - 1], 1); key = addDays(key, 1)) {
      const candidates = dayCandidates.get(key) ?? [];
      if (candidates.length === 0) { expected.set(`${userId}|${key}`, null); continue; }
      const newest = candidates.reduce((a, b) => (String(b.create_date) > String(a.create_date) ? b : a));
      const tied = candidates.filter((p) => String(p.create_date) === String(newest.create_date));
      if (tied.length > 1) ties.push({ userId, day: key, planIds: tied.map((p) => p.diet_plan_id) });
      expected.set(`${userId}|${key}`, newest.diet_plan_id);
    }
  }

  const selection = { checked: 0, assignedDays: 0, gapDays: 0, mismatches: [] };
  const selectionJobs = [...expected];
  const selectionResults = await mapLimit(selectionJobs, 6, ([k]) => {
    const [userId, key] = k.split('|');
    return read(legacySelectSql(userId, appDate(key)));
  });
  for (const [i, [k, planId]] of selectionJobs.entries()) {
    const [userId, key] = k.split('|');
    const rows = selectionResults[i];
    const legacyPlanId = rows[0]?.diet_plan_id ?? null;
    selection.checked += 1;
    if (planId === null) selection.gapDays += 1;
    else selection.assignedDays += 1;
    if (legacyPlanId !== planId) selection.mismatches.push({ userId: Number(userId), day: key, legacy: legacyPlanId, reconstructed: planId });
  }

  // ── candidate representations, checked day by day against the replay ──────
  // A: one document per contiguous run of a plan's OWN dates; overlaps resolved
  //    at read time by the legacy rule (newest legacy create_date wins).
  // B: precedence resolved once, at migration; one document per contiguous run
  //    of the days a plan actually WON. Documents never overlap.
  // Z: one document per plan, fromDate = first date, toDate = last date (the
  //    naive target), for comparison only.
  const segA = [];
  const segB = [];
  const segZ = [];
  for (const plan of plans) {
    const own = planDates.get(plan.diet_plan_id);
    for (const r of runs(own)) segA.push({ planId: plan.diet_plan_id, userId: plan.user_id, createDate: String(plan.create_date), ...r });
    if (own.length) segZ.push({ planId: plan.diet_plan_id, userId: plan.user_id, createDate: String(plan.create_date), from: own[0], to: own[own.length - 1] });
    const won = own.filter((key) => expected.get(`${plan.user_id}|${key}`) === plan.diet_plan_id);
    for (const r of runs(won)) segB.push({ planId: plan.diet_plan_id, userId: plan.user_id, createDate: String(plan.create_date), ...r });
  }
  const resolve = (segments, userId, key, byNewest) => {
    const hits = segments.filter((s) => s.userId === userId && s.from <= key && key <= s.to);
    if (hits.length === 0) return null;
    if (!byNewest && hits.length > 1) return 'OVERLAP';
    return hits.reduce((a, b) => (b.createDate > a.createDate || (b.createDate === a.createDate && b.planId > a.planId) ? b : a)).planId;
  };
  const segAByUser = group(segA, (s) => s.userId);
  const segBByUser = group(segB, (s) => s.userId);
  const segZByUser = group(segZ, (s) => s.userId);
  const parity = { A: [], B: [], Z: [] };
  for (const [k, planId] of expected) {
    const [u, key] = k.split('|');
    const userId = Number(u);
    const a = resolve(segAByUser.get(userId) ?? [], userId, key, true);
    const b = resolve(segBByUser.get(userId) ?? [], userId, key, false);
    const z = resolve(segZByUser.get(userId) ?? [], userId, key, true);
    if (a !== planId) parity.A.push({ userId, day: key, expected: planId, got: a });
    if (b !== planId) parity.B.push({ userId, day: key, expected: planId, got: b });
    if (z !== planId) parity.Z.push({ userId, day: key, expected: planId, got: z });
  }

  // ── ownership: client, coach, enrollment ───────────────────────────────────
  const coachEmailIndex = new Map(coachRows.filter((c) => c.email).map((c) => [String(c.email).trim().toLowerCase(), c.coach_id]));
  const enrollmentForDay = (userObjectId, key) =>
    (enrollmentsByUser.get(String(userObjectId)) ?? []).filter(
      (e) => !e.isDeleted && e.startDate && e.endDate && istDay(e.startDate) <= key && key <= istDay(e.endDate),
    );

  const perPlan = [];
  for (const plan of plans) {
    const id = plan.diet_plan_id;
    const client = userByLegacy.get(plan.user_id) ?? null;
    const creator = userByLegacy.get(plan.created_by) ?? null;
    const creatorCoach = creator ? coachByUserId.get(String(creator._id)) ?? null : null;
    const creatorLegacy = legacyUserById.get(plan.created_by);
    const creatorEmail = creatorLegacy?.email_id ? String(creatorLegacy.email_id).trim().toLowerCase() : null;
    const own = planDates.get(id);
    const won = own.filter((key) => expected.get(`${plan.user_id}|${key}`) === id);
    const visibleFoods = content.get(id).reduce((n, m) => n + m.foods.length, 0);

    const enrollmentDays = { single: 0, none: 0, multiple: 0 };
    const enrollmentIds = new Set();
    for (const key of won) {
      if (!client) break;
      const hits = enrollmentForDay(client._id, key);
      if (hits.length === 1) { enrollmentDays.single += 1; enrollmentIds.add(String(hits[0]._id)); }
      else if (hits.length === 0) enrollmentDays.none += 1;
      else enrollmentDays.multiple += 1;
    }

    const problems = [];
    const notes = [];
    if (!client) problems.push(`client legacy user ${plan.user_id} not migrated`);
    if (foodProblems.some((f) => f.planId === id)) problems.push('references a food with no Mongo Food');
    if (originalQtyIssues.some((f) => f.planId === id && f.issue.startsWith('originalqty is 0'))) notes.push('a food divisor is 0 in legacy');
    if (originalQtyIssues.some((f) => f.planId === id && f.issue.startsWith('Mongo'))) notes.push('Mongo servingQuantity differs from legacy divisor');
    if (own.length === 0) notes.push('no dates: never selectable');
    if (own.length && won.length === 0) notes.push('fully shadowed by newer plans: never visible');
    if (own.length && runs(own).length > 1) notes.push(`sparse: ${runs(own).length} runs`);
    if (visibleFoods === 0) notes.push('no visible foods: shows an empty day');
    if (ties.some((t) => t.planIds.includes(id))) problems.push('create_date tie on a shared day: legacy result undefined');
    if (ambiguousOrder.some((a) => a.planId === id)) notes.push('same food twice in a meal with different values: legacy order undefined');
    if (!creatorCoach) notes.push(`created_by ${plan.created_by} has no Coach in Mongo`);
    if (enrollmentDays.multiple) problems.push(`${enrollmentDays.multiple} visible day(s) inside more than one enrollment`);
    if (enrollmentDays.none) notes.push(`${enrollmentDays.none} visible day(s) outside every enrollment`);
    if (hiddenRows.some((h) => h.planId === id)) notes.push('has meal rows the legacy query never shows');

    let classification;
    if (problems.some((p) => p.includes('not migrated') || p.includes('no Mongo Food'))) classification = 'D_UNMIGRATABLE';
    else if (problems.length) classification = 'C_AMBIGUOUS';
    else if (notes.length) classification = 'B_MIGRATABLE_WITH_METADATA';
    else classification = 'A_MIGRATABLE';

    perPlan.push({
      planId: id,
      name: plan.diet_plan_name,
      legacyUserId: plan.user_id,
      createdBy: plan.created_by,
      createDate: String(plan.create_date),
      clientUserId: client ? String(client._id) : null,
      creatorUserId: creator ? String(creator._id) : null,
      creatorCoachId: creatorCoach ? String(creatorCoach._id) : null,
      creatorIsClient: plan.created_by === plan.user_id,
      creatorEmailIsLegacyCoach: creatorEmail ? coachEmailIndex.get(creatorEmail) ?? null : null,
      dates: own.length,
      runs: runs(own).length,
      wonDays: won.length,
      wonRuns: runs(won).length,
      visibleFoods,
      enrollmentDays,
      enrollmentIds: [...enrollmentIds],
      classification,
      problems,
      notes,
    });
  }

  // Display values for the selected content, for the replay contract.
  const displayed = [];
  for (const [planId, planMeals] of content) for (const { mealId, foods } of planMeals) foods.forEach((f, i) => {
    displayed.push({ planId, mealId, position: i, foodId: f.food_id, quantity: f.quantity, originalqty: f.originalqty, calories: f.calories, fats: f.fats, carbs: f.carbs, proteins: f.proteins,
      shown: f.originalqty ? { calories: round1((f.calories / f.originalqty) * f.quantity), fat: round1((f.fats / f.originalqty) * f.quantity), carbs: round1((f.carbs / f.originalqty) * f.quantity), protein: round1((f.proteins / f.originalqty) * f.quantity) } : null });
  });

  const count = (pred) => perPlan.filter(pred).length;
  const summary = {
    target: describeMysqlTarget(),
    counts: { plans: plans.length, mealRows: mealRows.length, dateRows: dateRows.length, mMeal: meals.length },
    dateRowTimes: dateTimes[0],
    orphanMealRows: mealRows.filter((r) => !planById.has(r.diet_plan_id)).length,
    orphanMealPlanIds,
    orphanDateRows: dateRows.filter((r) => !planById.has(r.diet_plan_id)).length,
    orphanDatePlanIds,
    plansWithoutMealRows: count((p) => !mealsByPlan.has(p.planId)),
    plansWithoutVisibleFoods: count((p) => p.visibleFoods === 0),
    plansWithoutDates: count((p) => p.dates === 0),
    duplicateDateRows: duplicateDateRows.reduce((n, d) => n + d.rows - d.distinct, 0),
    contiguousPlans: count((p) => p.runs === 1),
    sparsePlans: count((p) => p.runs > 1),
    clients: plansByUser.size,
    clientsMigrated: [...plansByUser.keys()].filter((u) => userByLegacy.has(u)).length,
    hiddenMealRows: hiddenRows.length,
    visibleFoodRows: displayed.length,
    distinctFoods: foodIds.length,
    foodProblems: foodProblems.length,
    ambiguousOrder: ambiguousOrder.length,
    originalQtyIssues: originalQtyIssues.length,
    selection: { ...selection, mismatches: selection.mismatches.length },
    createDateTies: ties.length,
    overlapDays: [...expected.keys()].filter((k) => {
      const [u, key] = k.split('|');
      return (plansByUser.get(Number(u)) ?? []).filter((p) => planDates.get(p.diet_plan_id).includes(key)).length > 1;
    }).length,
    parity: { A: parity.A.length, B: parity.B.length, Z: parity.Z.length },
    documents: { A: segA.length, B: segB.length, Z: segZ.length },
    classification: Object.fromEntries(['A_MIGRATABLE', 'B_MIGRATABLE_WITH_METADATA', 'C_AMBIGUOUS', 'D_UNMIGRATABLE'].map((c) => [c, count((p) => p.classification === c)])),
    creators: [...group(plans, (p) => p.created_by)].map(([createdBy, ps]) => ({
      createdBy,
      plans: ps.length,
      name: [legacyUserById.get(createdBy)?.first_name, legacyUserById.get(createdBy)?.last_name].filter(Boolean).join(' ') || null,
      mongoUser: Boolean(userByLegacy.get(createdBy)),
      mongoCoach: Boolean(userByLegacy.get(createdBy) && coachByUserId.get(String(userByLegacy.get(createdBy)._id))),
      legacyCoachByEmail: (() => { const e = legacyUserById.get(createdBy)?.email_id; return e ? coachEmailIndex.get(String(e).trim().toLowerCase()) ?? null : null; })(),
    })),
    enrollmentDays: perPlan.reduce((acc, p) => ({ single: acc.single + p.enrollmentDays.single, none: acc.none + p.enrollmentDays.none, multiple: acc.multiple + p.enrollmentDays.multiple }), { single: 0, none: 0, multiple: 0 }),
    plansSpanningSeveralEnrollments: count((p) => p.enrollmentIds.length > 1),
    mongoReference: { users: users.length, coaches: coaches.length, enrollments: enrollments.length, foodsResolved: mongoFoods.length },
  };

  return { summary, perPlan, hiddenRows, foodProblems, ambiguousOrder, originalQtyIssues, ties, duplicateDateRows, selectionMismatches: selection.mismatches, parity, segments: { A: segA, B: segB }, userSpans, displayed };
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('analyze-diet-plans.js');
if (isEntryPoint) {
  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(analyzeDietPlans)
    .then(async (result) => {
      const dir = path.join(process.cwd(), 'migration', 'reports', 'runs');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `diet-plan-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await fs.writeFile(file, JSON.stringify(result, null, 2), 'utf8');
      console.log(JSON.stringify(result.summary, null, 2));
      console.log(`report: ${file}`);
    })
    .catch((error) => {
      console.error(`diet plan analysis failed: ${error.stack}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default analyzeDietPlans;
