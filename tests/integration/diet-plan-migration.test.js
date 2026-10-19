import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import DietPlan from '../../src/models/diet-plan.model.js';
import Food from '../../src/models/food.model.js';
import User from '../../src/models/user.model.js';
import { startOfBusinessDay } from '../../src/utils/business-date.js';
import {
  applyDietPlans,
  buildReferences,
  gateByClient,
  replay,
  selectForDay,
  transformAll,
  validateDocuments,
} from '../../migration/loaders/diet-plan.loader.js';
import { clearTestDb, connectTestDb, disconnectTestDb } from '../helpers/test-server.js';

const SOURCE = 'gogetfit';

// ─── legacy fixture (what the extractor returns) ─────────────────────────────

const legacyPlans = [
  // client 417, by coach user 332: sparse days with a gap on the 26th
  { diet_plan_id: 61, diet_plan_name: 'Vinayak plan ', user_id: 417, total_calories: 1601, fat: 36, carbs: 200, protein: 120, create_date: '2024-06-20 10:00:00', created_by: 332, last_update_date: '2024-06-20 10:00:00', bmr: 1543.15, tdee: 1851.78, goal: 'Fat/Weight Loss' },
  // client 417, newer, overlapping the 25th
  { diet_plan_id: 62, diet_plan_name: 'Override', user_id: 417, total_calories: 1500, fat: 30, carbs: 180, protein: 110, create_date: '2024-06-23 20:16:07', created_by: 332, last_update_date: '2024-06-23 20:16:07', bmr: null, tdee: null, goal: null },
  // client 417, dateless draft
  { diet_plan_id: 63, diet_plan_name: 'Draft', user_id: 417, total_calories: 0, fat: 0, carbs: 0, protein: 0, create_date: '2024-06-24 09:00:00', created_by: 332, last_update_date: null, bmr: null, tdee: null, goal: null },
  // client 999 is not a Mongo user
  { diet_plan_id: 70, diet_plan_name: 'Lost', user_id: 999, total_calories: 1, fat: 1, carbs: 1, protein: 1, create_date: '2024-01-01 00:00:00', created_by: 123, last_update_date: null, bmr: null, tdee: null, goal: null },
];
const dateRows = [
  ...['2024-06-24', '2024-06-25', '2024-06-25', '2024-06-27'].map((day) => ({ diet_plan_id: 61, day, time: '00:00:00' })),
  { diet_plan_id: 62, day: '2024-06-25', time: '00:00:00' },
  { diet_plan_id: 70, day: '2024-01-02', time: '00:00:00' },
];
const mealRows = [
  { diet_plan_id: 61, meal_id: 1, food_id: 14, quantity: 200, calories: 113, fats: 3.5, carbs: 19, proteins: 2, originalqty: 100, unit: 'Grams' },
  { diet_plan_id: 61, meal_id: 3, food_id: 27, quantity: 2, calories: 78, fats: 5.3, carbs: 0.6, proteins: 6.3, originalqty: 1, unit: 'piece' },
  { diet_plan_id: 62, meal_id: 2, food_id: 14, quantity: 50, calories: 113, fats: 3.5, carbs: 19, proteins: 2, originalqty: 100, unit: 'Grams' },
];
const legacyUsers = [
  { user_id: 417, first_name: 'Vinayak', email_id: 'v@example.com', user_type: 'U' },
  { user_id: 332, first_name: 'Karthik M', email_id: 'karthik@gogetfitonline.com', user_type: 'C' },
];
const legacyCoaches = [{ coach_id: 17, first_name: 'Karthik', last_name: 'M', email: 'karthik@gogetfitonline.com' }];

let client;
let coach;
let rice;
let egg;
let enrollment;

const seed = async () => {
  client = await User.create({ phone: { raw: '919000000417', normalized: '919000000417' }, profile: { name: 'Vinayak' }, legacy: { source: SOURCE, userId: 417 } });
  const coachUser = await User.create({ phone: { raw: '919000000332', normalized: '919000000332' }, profile: { name: 'Karthik M', email: 'karthik@gogetfitonline.com' }, legacy: { source: SOURCE, userId: 332 } });
  coach = (await mongoose.connection.db.collection('coaches').insertOne({ userId: coachUser._id, status: 'active' })).insertedId;
  const food = (legacyFoodId, name, servingUnit, servingQuantity) =>
    Food.create({ name, foodType: 'Vegetarian', servingUnit, servingQuantity, calories: 1, fat: 1, carbs: 1, protein: 1, legacy: { source: SOURCE, foodId: legacyFoodId } });
  rice = await food(14, 'Rice', 'Grams', 100);
  egg = await food(27, 'Egg', 'Piece', 1);
  // Covers 24-25 June only (IST days, stored as the business-day start).
  enrollment = (await mongoose.connection.db.collection('enrolledclients').insertOne({
    userId: client._id,
    startDate: startOfBusinessDay('2024-06-21'),
    endDate: startOfBusinessDay('2024-06-25'),
    isDeleted: false,
    legacy: { source: SOURCE, enrollmentId: 137, coachId: 17 },
  })).insertedId;
};

const transform = async () => {
  const refs = await buildReferences({ plans: legacyPlans, legacyUsers, legacyCoaches, foodIds: [14, 27], source: SOURCE });
  return { refs, results: gateByClient(transformAll({ plans: legacyPlans, dateRows, mealRows, refs, source: SOURCE, runId: 'test', version: 1 })) };
};
const docsOf = (results) => results.flatMap((r) => r.documents);

before(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seed();
});
after(disconnectTestDb);

test('references resolve only through the verified bridges', async () => {
  const { refs } = await transform();
  assert.equal(String(refs.userByLegacy.get(417)), String(client._id));
  assert.equal(refs.userByLegacy.has(999), false);
  assert.deepEqual(refs.creators.get(332), { coachId: coach, legacyCoachId: 17, reason: 'verified' });
  // m_user 123 does not exist: no coach is invented.
  assert.equal(refs.creators.get(123).coachId, null);
  assert.equal(String(refs.foods.get(14)._id), String(rice._id));
});

test('plans are classified: dateless excluded, missing user blocked, the rest migratable', async () => {
  const { results } = await transform();
  assert.deepEqual(results.map((r) => [r.planId, r.status]), [
    [61, 'migratable'],
    [62, 'migratable'],
    [63, 'not_migrated_no_dates'],
    [70, 'blocked_missing_user'],
  ]);
});

test('documents carry the mapped fields, split by date run and enrollment window', async () => {
  const { results } = await transform();
  const docs = docsOf(results);
  assert.deepEqual(await validateDocuments(docs), []);

  const p61 = docs.filter((d) => d.legacy.dietPlanId === 61);
  // 24-25 (inside the enrollment) and 27 (outside it, after a gap).
  assert.deepEqual(p61.map((d) => [d.fromDate.toISOString(), d.toDate.toISOString(), d.enrollmentId && String(d.enrollmentId)]), [
    ['2024-06-23T18:30:00.000Z', '2024-06-24T18:30:00.000Z', String(enrollment)],
    ['2024-06-26T18:30:00.000Z', '2024-06-26T18:30:00.000Z', null],
  ]);
  assert.ok(p61.every((d) => d.planId === 'gogetfit:61' && String(d.coachId) === String(coach) && String(d.clientId) === String(client._id)));
  assert.deepEqual(p61[0].meals, [
    { meal: 1, foods: [{ foodId: rice._id, qty: 200, portion: 100, servingUnit: 'Grams', calories: 113, fat: 3.5, carbs: 19, protein: 2 }] },
    { meal: 3, foods: [{ foodId: egg._id, qty: 2, portion: 1, servingUnit: 'Piece', calories: 78, fat: 5.3, carbs: 0.6, protein: 6.3 }] },
  ]);
});

test('the real MongoDB day lookup reproduces newest-wins and leaves gaps empty', async () => {
  const { results } = await transform();
  const docs = docsOf(results);
  await applyDietPlans(docs);

  const expected = { '2024-06-23': null, '2024-06-24': 61, '2024-06-25': 62, '2024-06-26': null, '2024-06-27': 61, '2024-06-28': null };
  for (const [day, planId] of Object.entries(expected)) {
    const found = await DietPlan.findForDay(client._id, startOfBusinessDay(day)).lean();
    assert.equal(found?.legacy.dietPlanId ?? null, planId, `Mongo ${day}`);
    assert.equal(selectForDay(docs, client._id, day)?.legacy.dietPlanId ?? null, planId, `in-memory ${day}`);
  }
});

test('apply is idempotent: a second run creates nothing and changes nothing', async () => {
  const docs = docsOf((await transform()).results);
  const first = await applyDietPlans(docs);
  assert.equal(first.created, 3);
  const snapshot = await DietPlan.find({}).sort({ _id: 1 }).lean();

  const second = await applyDietPlans(docsOf((await transform()).results));
  assert.deepEqual([second.created, second.unchanged, second.conflicts.length], [0, 3, 0]);
  assert.deepEqual(await DietPlan.find({}).sort({ _id: 1 }).lean(), snapshot);
});

test('a changed source is reported, never overwritten', async () => {
  const docs = docsOf((await transform()).results);
  await applyDietPlans(docs);
  const changed = docs.map((d) => (d.legacy.dietPlanId === 62 ? { ...d, name: 'Edited in legacy' } : d));

  const result = await applyDietPlans(changed);
  assert.equal(result.written, false);
  assert.deepEqual(result.conflicts, [{ dietPlanId: 62, segment: 0 }]);
  assert.equal((await DietPlan.findOne({ 'legacy.dietPlanId': 62 }).lean()).name, 'Override');
});

test('the legacy identity is unique per plan segment', async () => {
  const [doc] = docsOf((await transform()).results);
  await DietPlan.create(doc);
  await assert.rejects(DietPlan.create(doc), /duplicate key/);
});

test('replay passes when legacy and new agree, and names the day when they do not', async () => {
  const docs = docsOf((await transform()).results);
  const legacyContent = {
    61: [{ mealId: 1, foods: [{ food_id: 14, quantity: 200, originalqty: 100, unit: 'grams', calories: 113, fats: 3.5, carbs: 19, proteins: 2 }] },
      { mealId: 3, foods: [{ food_id: 27, quantity: 2, originalqty: 1, unit: 'Piece', calories: 78, fats: 5.3, carbs: 0.6, proteins: 6.3 }] }],
    62: [{ mealId: 2, foods: [{ food_id: 14, quantity: 50, originalqty: 100, unit: 'Grams', calories: 113, fats: 3.5, carbs: 19, proteins: 2 }] }],
  };
  const header = { 61: legacyPlans[0], 62: legacyPlans[1] };
  const legacyByDay = { '2024-06-24': 61, '2024-06-25': 62, '2024-06-27': 61 };
  const run = (select) =>
    replay({
      documents: docs,
      clients: [{ legacyUserId: 417, clientId: client._id, days: Object.keys(legacyByDay) }],
      legacySelect: async (_u, day) => select(day),
      legacyMeals: async (id) => legacyContent[id],
      foodLegacyId: new Map([[String(rice._id), 14], [String(egg._id), 27]]),
    });

  const ok = await run((day) => (legacyByDay[day] ? header[legacyByDay[day]] : null));
  assert.deepEqual([ok.days, ok.assignedDays, ok.mismatches.length], [6, 3, 0]);

  // Legacy would show plan 61 on the 26th: the new data shows nothing there.
  const bad = await run((day) => (day === '2024-06-26' ? header[61] : legacyByDay[day] ? header[legacyByDay[day]] : null));
  assert.deepEqual(bad.mismatches, [{ legacyUserId: 417, day: '2024-06-26', field: 'selectedPlan', legacy: 61, mongo: null }]);
});
