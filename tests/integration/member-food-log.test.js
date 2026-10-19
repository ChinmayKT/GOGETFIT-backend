import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Coach from '../../src/models/coach.model.js';
import DietPlan from '../../src/models/diet-plan.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import Food from '../../src/models/food.model.js';
import FoodLog from '../../src/models/food-log.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { getFoodLogForDay, submitFoodLog } from '../../src/services/food-log.service.js';
import { addCalendarDays, businessDayOf, startOfBusinessDay } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Intake food log - GET/PUT /api/users/me/food-log. One document per member
 * per business day; a submission saves the whole day and updates that same
 * document; entries keep their id and nutrition snapshot; consumed and
 * targets are the server's; nothing on another day is touched.
 */
let server;
let member;
let other;
let coachUser;
let coach;
let enrollment;
let rice; // 113 kcal per 100 g
let whey; // 120 kcal per 1 scoop

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9166000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};
const today = () => businessDayOf(new Date());
const day = (d) => startOfBusinessDay(d);

const put = (body, user = member) => server.request('PUT', '/api/users/me/food-log', { token: tokenFor(user), body });
const get = (qs = '', user = member) => server.request('GET', `/api/users/me/food-log${qs}`, { token: tokenFor(user) });
const entry = (entryId, food, qty) => ({ entryId, foodId: String(food._id), qty });

const plan = (overrides = {}) =>
  DietPlan.create({
    planId: `app:${(seq += 1)}`,
    clientId: member._id,
    enrollmentId: enrollment._id,
    coachId: coach._id,
    name: 'Cut',
    fromDate: day(addCalendarDays(today(), -2)),
    toDate: day(addCalendarDays(today(), 5)),
    assignedAt: new Date('2025-01-01'),
    targets: { calories: 1450, fat: 32, carbs: 181, protein: 109 },
    meals: [],
    ...overrides,
  });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  const gp = await GogetfitPlan.create({ name: '12 WEEKS', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1, pricing: { basePrice: 1, reward: 0 } });
  member = await seedUser(['user', 'client'], 'Chethan');
  other = await seedUser(['user', 'client'], 'Bob');
  coachUser = await seedUser(['user', 'coach'], 'Prajwal');
  coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  enrollment = await EnrolledClient.create({ userId: member._id, planId: gp._id, coachId: coach._id, enrollDate: new Date('2025-01-01'), hasStarted: true, isDeleted: false });
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 113, fat: 3.5, carbs: 19, protein: 2 });
  whey = await Food.create({ name: 'Whey', foodType: 'Vegetarian', brand: 'MB', servingUnit: 'Scoop', servingQuantity: 1, calories: 120, fat: 2, carbs: 7, protein: 24 });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('a first submission creates today\'s log; the server computes what was eaten', async () => {
  const res = await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 200)] }, { meal: 4, foods: [entry('e2', whey, 1.5)] }] });

  assert.equal(res.status, 200);
  const log = res.body.data.foodLog;
  assert.equal(log.date, today());
  assert.equal(res.body.data.timezone, 'Asia/Kolkata');
  // 113 x 2 + 120 x 1.5; 3.5 x 2 + 2 x 1.5 ...
  assert.deepEqual(log.consumed, { calories: 406, fat: 10, carbs: 48.5, protein: 40 });
  assert.equal(log.targets, null, 'no plan, no goal sent');
  assert.equal(log.remaining, null);
  const [e1] = log.meals[0].foods;
  assert.deepEqual(
    { entryId: e1.entryId, qty: e1.qty, portion: e1.portion, servingUnit: e1.servingUnit, kcal: e1.nutrition.calories, name: e1.food.name },
    { entryId: 'e1', qty: 200, portion: 100, servingUnit: 'Grams', kcal: 226, name: 'Rice' },
  );
  assert.deepEqual(log.meals.map((m) => m.meal), [1, 4]);

  // Reading it back gives the same.
  const read = (await get()).body.data.foodLog;
  assert.deepEqual(read.consumed, log.consumed);
  assert.equal(await FoodLog.countDocuments(), 1);
});

test('submitting again updates the same day: no duplicates, removed entries go', async () => {
  await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 200), entry('e2', whey, 1)] }] });
  const res = await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }, { meal: 2, foods: [entry('e3', whey, 2)] }] });

  assert.equal(res.status, 200);
  assert.equal(await FoodLog.countDocuments({ clientId: member._id }), 1);
  const log = res.body.data.foodLog;
  assert.deepEqual(log.meals.map((m) => m.foods.map((e) => e.entryId)), [['e1'], ['e3']]);
  assert.equal(log.consumed.calories, 113 + 240);
});

test('an unchanged entry keeps its nutrition snapshot when the food is edited later', async () => {
  await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }] });
  await Food.updateOne({ _id: rice._id }, { $set: { calories: 200 } });

  const res = await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100), entry('e2', rice, 100)] }] });
  const [kept, fresh] = res.body.data.foodLog.meals[0].foods;
  assert.equal(kept.perPortion.calories, 113, 'priced when first logged');
  assert.equal(fresh.perPortion.calories, 200, 'a new entry takes today\'s value');
  assert.equal(res.body.data.foodLog.consumed.calories, 313);
});

test('an empty first submission is refused; emptying a saved day clears it', async () => {
  const empty = await put({ meals: [] });
  assert.equal(empty.status, 400);
  assert.equal(await FoodLog.countDocuments(), 0);

  await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }] });
  const cleared = await put({ meals: [{ meal: 1, foods: [] }] });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.data.foodLog.meals, []);
  assert.equal(cleared.body.data.foodLog.consumed.calories, 0);
  assert.equal(await FoodLog.countDocuments(), 1, 'still one document');
});

test('bad foods and quantities are a 400 and leave the saved log as it was', async () => {
  await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }] });
  const before = await FoodLog.findOne().lean();
  const archived = await Food.create({ name: 'Old', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 1, fat: 1, carbs: 1, protein: 1, status: 'archived' });

  for (const body of [
    { meals: [{ meal: 1, foods: [{ entryId: 'x', foodId: 'nope', qty: 1 }] }] },
    { meals: [{ meal: 1, foods: [{ entryId: 'x', foodId: '64b7f0f0f0f0f0f0f0f0f0f0', qty: 1 }] }] },
    { meals: [{ meal: 1, foods: [entry('x', archived, 1)] }] },
    { meals: [{ meal: 1, foods: [entry('x', rice, 0)] }] },
    { meals: [{ meal: 1, foods: [entry('x', rice, -5)] }] },
    { meals: [{ meal: 1, foods: [{ ...entry('x', rice, 1), qty: '1' }] }] },
    { meals: [{ meal: 1, foods: [entry('x', rice, 1), entry('x', whey, 1)] }] },
    { meals: [{ meal: 9, foods: [entry('x', rice, 1)] }] },
    { meals: [{ meal: 1, foods: [] }, { meal: 1, foods: [] }] },
    { meals: 'all' },
  ]) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
  const after = await FoodLog.findOne().lean();
  assert.deepEqual(after.meals, before.meals);
  assert.deepEqual(after.consumed, before.consumed);
});

test('totals, targets and ids sent by the app are ignored', async () => {
  const res = await put({
    meals: [{ meal: 1, foods: [{ ...entry('e1', rice, 100), calories: 1, portion: 1 }] }],
    consumed: { calories: 1, fat: 1, carbs: 1, protein: 1 },
    targets: { calories: 9999, fat: 1, carbs: 1, protein: 1 },
    clientId: String(other._id),
    coachId: String(coach._id),
    logDate: '2020-01-01',
  });
  const log = res.body.data.foodLog;
  assert.equal(log.consumed.calories, 113);
  assert.equal(log.targets, null);
  assert.equal(log.date, today());
  const doc = await FoodLog.findOne().lean();
  assert.equal(String(doc.clientId), String(member._id));
  assert.equal(doc.coachId, null);
});

test('targets: the coach\'s intake, else the plan\'s, else the member\'s own goal', async () => {
  const goal = { calories: 2000, fat: 60, carbs: 220, protein: 150 };
  const meals = [{ meal: 1, foods: [entry('e1', rice, 100)] }];

  // No plan: the member's own goal.
  let log = (await put({ meals, memberGoal: goal })).body.data.foodLog;
  assert.deepEqual(log.targets, goal);
  assert.equal(log.targetsSource, 'member');
  assert.deepEqual(log.remaining, { calories: 1887, fat: 56.5, carbs: 201, protein: 148 });

  // A plan today (a fresh day's first submission): its targets.
  await FoodLog.deleteMany({});
  const p = await plan();
  log = (await put({ meals, memberGoal: goal })).body.data.foodLog;
  assert.deepEqual(log.targets, { calories: 1450, fat: 32, carbs: 181, protein: 109 });
  assert.equal(log.targetsSource, 'plan');
  const doc = await FoodLog.findOne().lean();
  assert.equal(String(doc.dietPlanId), String(p._id));
  assert.equal(doc.planId, p.planId);
  assert.equal(String(doc.coachId), String(coach._id));
  assert.equal(String(doc.enrollmentId), String(enrollment._id));

  // The coach's Set Calorie Intake wins over the plan's.
  await FoodLog.deleteMany({});
  await DietPlan.updateOne({ _id: p._id }, { $set: { coachGivenTargets: { calories: 1600, protein: 120, carbs: 180, fat: 45, setAt: new Date(), setBy: coachUser._id } } });
  log = (await put({ meals })).body.data.foodLog;
  assert.deepEqual(log.targets, { calories: 1600, fat: 45, carbs: 180, protein: 120 });
  assert.equal(log.targetsSource, 'coach');
  assert.equal(log.remaining.calories, 1487);
});

test('the day keeps the targets it started with; only what was eaten is recalculated', async () => {
  const p = await plan();
  await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }] });
  // The coach changes the intake later the same day.
  await DietPlan.updateOne({ _id: p._id }, { $set: { coachGivenTargets: { calories: 1600, protein: 120, carbs: 180, fat: 45, setAt: new Date(), setBy: coachUser._id } } });
  const log = (await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100), entry('e2', rice, 100)] }] })).body.data.foodLog;
  assert.deepEqual(log.targets, { calories: 1450, fat: 32, carbs: 181, protein: 109 }, 'the day\'s snapshot');
  assert.equal(log.targetsSource, 'plan');
  assert.equal(log.remaining.calories, 1450 - 226);
  const plain = await DietPlan.findById(p._id).lean();
  assert.deepEqual(plain.targets, { calories: 1450, fat: 32, carbs: 181, protein: 109 }, 'the plan is never touched');
});

test('2 eggs replaced by 3 eggs: only the new entry, totals for 3', async () => {
  const egg = await Food.create({ name: 'Egg', foodType: 'Non-Vegetarian', servingUnit: 'Piece', servingQuantity: 1, calories: 70, fat: 5, carbs: 0.5, protein: 6 });
  await put({ meals: [{ meal: 2, foods: [entry('two-eggs', egg, 2)] }] });
  // The card is removed and a new one added - a new entry, same food.
  const res = await put({ meals: [{ meal: 2, foods: [entry('three-eggs', egg, 3)] }] });
  const log = res.body.data.foodLog;
  assert.deepEqual(log.meals[0].foods.map((e) => [e.entryId, e.qty]), [['three-eggs', 3]]);
  assert.equal(log.consumed.calories, 210);
  assert.equal(await FoodLog.countDocuments({ clientId: member._id }), 1);
});

test('removing one of two identical entries keeps the other', async () => {
  await put({ meals: [{ meal: 1, foods: [entry('a', rice, 100), entry('b', rice, 100)] }] });
  const log = (await put({ meals: [{ meal: 1, foods: [entry('b', rice, 100)] }] })).body.data.foodLog;
  assert.deepEqual(log.meals[0].foods.map((e) => e.entryId), ['b']);
  assert.equal(log.consumed.calories, 113);
});

test('meals loaded for another day are never written into today\'s log', async () => {
  await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }] });
  const before = await FoodLog.findOne().lean();
  const stale = await put({ day: addCalendarDays(today(), -1), meals: [{ meal: 1, foods: [entry('old', whey, 1)] }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'FOOD_LOG_DAY_CHANGED');
  assert.deepEqual((await FoodLog.findOne().lean()).meals, before.meals);
  // The day the app loaded, when it is today, is fine.
  assert.equal((await put({ day: today(), meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }] })).status, 200);
  assert.equal((await put({ day: '17-10-2026', meals: [] })).status, 400);
});

test('remaining goes negative past a target', async () => {
  await plan({ targets: { calories: 100, fat: 1, carbs: 1, protein: 1 } });
  const log = (await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }] })).body.data.foodLog;
  assert.equal(log.remaining.calories, -13);
});

test('a migrated plan with no enrollment still applies', async () => {
  await plan({ enrollmentId: null, coachId: null, targets: { dailyCalorieTarget: 1800, fat: 50, carbs: 200, protein: 120 } });
  const res = await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.foodLog.targets.calories, 1800);
  const doc = await FoodLog.findOne().lean();
  assert.equal(doc.enrollmentId, null);
  assert.equal(doc.coachId, null);
});

test('only the signed-in member\'s own log, and only with a token', async () => {
  await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }] });
  assert.equal((await server.request('GET', '/api/users/me/food-log')).status, 401);
  assert.equal((await server.request('PUT', '/api/users/me/food-log', { body: { meals: [] } })).status, 401);
  // Another member sees their own (empty) day, never this one.
  assert.equal((await get('', other)).body.data.foodLog, null);
  // A query cannot point the read at someone else.
  assert.equal((await get(`?clientId=${member._id}`, other)).body.data.foodLog, null);
  assert.equal((await get('?date=not-a-day')).status, 400);
});

test('two first submissions at once still make one daily document', async () => {
  const [a, b] = await Promise.all([
    put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }] }),
    put({ meals: [{ meal: 2, foods: [entry('e2', whey, 1)] }] }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(await FoodLog.countDocuments({ clientId: member._id }), 1);
});

test('the day is the business day (Asia/Kolkata); yesterday\'s log is kept as it was', async () => {
  // 23:59:59 IST on the 17th, then 00:00:00 IST on the 18th.
  const lateOn17 = new Date('2026-10-17T18:29:59.000Z');
  const earlyOn18 = new Date('2026-10-17T18:30:00.000Z');
  const meals = (id, food) => ({ meals: [{ meal: 1, foods: [{ entryId: id, foodId: String(food._id), qty: 100 }] }], memberGoal: null });

  const y = await submitFoodLog(member._id, meals('y1', rice), { now: lateOn17 });
  const t = await submitFoodLog(member._id, meals('t1', whey), { now: earlyOn18 });
  assert.equal(y.date, '2026-10-17');
  assert.equal(t.date, '2026-10-18');
  assert.equal(await FoodLog.countDocuments({ clientId: member._id }), 2);

  // The new day starts empty of yesterday's foods; yesterday is untouched.
  const yesterday = await getFoodLogForDay(member._id, { date: '2026-10-17' });
  assert.deepEqual(yesterday.foodLog.meals[0].foods.map((e) => e.entryId), ['y1']);
  const todayLog = await getFoodLogForDay(member._id, { date: '2026-10-18' });
  assert.deepEqual(todayLog.foodLog.meals[0].foods.map((e) => e.entryId), ['t1']);
  // A day with nothing submitted reads as null, not as another day's log.
  assert.equal((await getFoodLogForDay(member._id, { date: '2026-10-19' })).foodLog, null);
});

test('Egg submitted, then replaced by Bread in Meal 1: Bread alone, Meal 2 untouched', async () => {
  const egg = await Food.create({ name: 'Egg', foodType: 'Non-Vegetarian', servingUnit: 'Piece', servingQuantity: 1, calories: 70, fat: 5, carbs: 0.5, protein: 6 });
  const bread = await Food.create({ name: 'Bread', foodType: 'Vegetarian', servingUnit: 'Slice', servingQuantity: 1, calories: 80, fat: 1, carbs: 15, protein: 3 });
  const meal2 = [entry('rice-1', rice, 150), entry('whey-1', whey, 1)];

  await put({ meals: [{ meal: 1, foods: [entry('egg-1', egg, 2)] }, { meal: 2, foods: meal2 }] });
  const first = await FoodLog.findOne().lean();

  // Egg removed, Bread added: Meal 1 is now just Bread; Meal 2 as it was.
  const res = await put({ meals: [{ meal: 1, foods: [entry('bread-1', bread, 2)] }, { meal: 2, foods: meal2 }] });
  assert.equal(res.status, 200);

  const doc = await FoodLog.findOne().lean();
  assert.equal(String(doc._id), String(first._id), 'the same daily document');
  assert.equal(await FoodLog.countDocuments(), 1);
  const [m1, m2] = doc.meals;
  assert.deepEqual(
    m1.foods.map((e) => ({ entryId: e.entryId, foodId: String(e.foodId), qty: e.qty, portion: e.portion, servingUnit: e.servingUnit })),
    [{ entryId: 'bread-1', foodId: String(bread._id), qty: 2, portion: 1, servingUnit: 'Slice' }],
  );
  assert.ok(!doc.meals.some((m) => m.foods.some((e) => String(e.foodId) === String(egg._id))), 'no Egg anywhere');
  assert.deepEqual(m2.foods, first.meals[1].foods, 'Meal 2 unchanged, snapshots and all');
  // Bread (2 slices) + rice (150 g) + whey (1 scoop) - no Egg in the totals:
  // kcal 160 + 169.5 + 120, fat 2 + 5.25 + 2, carbs 30 + 28.5 + 7, protein 6 + 3 + 24.
  assert.deepEqual(doc.consumed, { calories: 449.5, fat: 9.3, carbs: 65.5, protein: 33 });
});

test('the same food twice, with different amounts, stays two entries', async () => {
  await put({ meals: [{ meal: 1, foods: [entry('a', rice, 100), entry('b', rice, 250)] }] });
  const log = (await put({ meals: [{ meal: 1, foods: [entry('a', rice, 100), entry('b', rice, 250)] }] })).body.data.foodLog;
  assert.deepEqual(log.meals[0].foods.map((e) => [e.entryId, e.qty]), [['a', 100], ['b', 250]]);
  assert.equal(log.consumed.calories, 395.5);
});

test('an entry moved to another meal leaves no copy behind', async () => {
  await put({ meals: [{ meal: 1, foods: [entry('a', rice, 100)] }] });
  const log = (await put({ meals: [{ meal: 1, foods: [] }, { meal: 3, foods: [entry('a', rice, 100)] }] })).body.data.foodLog;
  assert.deepEqual(log.meals.map((m) => [m.meal, m.foods.map((e) => e.entryId)]), [[3, ['a']]]);
  assert.equal(log.consumed.calories, 113);
});

test('the same entries submitted twice at once are stored once', async () => {
  await put({ meals: [{ meal: 1, foods: [entry('a', rice, 100)] }] });
  const body = { meals: [{ meal: 1, foods: [entry('a', rice, 100), entry('b', whey, 1)] }] };
  const [x, y] = await Promise.all([put(body), put(body)]);
  assert.equal(x.status, 200);
  assert.equal(y.status, 200);
  const doc = await FoodLog.findOne().lean();
  assert.deepEqual(doc.meals[0].foods.map((e) => e.entryId), ['a', 'b']);
  assert.equal(await FoodLog.countDocuments(), 1);
});

test('each entry keeps the food\'s name as logged - readable in the database', async () => {
  await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100), entry('e2', whey, 1)] }] });
  let doc = await FoodLog.findOne().lean();
  assert.deepEqual(doc.meals[0].foods.map((e) => e.foodName), ['Rice', 'Whey']);

  // A later rename does not rewrite a logged entry; a new entry takes the new name.
  await Food.updateOne({ _id: rice._id }, { $set: { name: 'Basmati Rice' } });
  const res = await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100), entry('e3', rice, 50)] }] });
  doc = await FoodLog.findOne().lean();
  assert.deepEqual(doc.meals[0].foods.map((e) => [e.entryId, e.foodName]), [['e1', 'Rice'], ['e3', 'Basmati Rice']]);
  assert.equal(res.body.data.foodLog.meals[0].foods[0].foodName, 'Rice');

  // An entry saved before names were kept gets one on its next submission.
  await FoodLog.collection.updateOne({ _id: doc._id }, { $unset: { 'meals.0.foods.0.foodName': '' } });
  await put({ meals: [{ meal: 1, foods: [entry('e1', rice, 100)] }] });
  doc = await FoodLog.findOne().lean();
  assert.equal(doc.meals[0].foods[0].foodName, 'Basmati Rice');
});

