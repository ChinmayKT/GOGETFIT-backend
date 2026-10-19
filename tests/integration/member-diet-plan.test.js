import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import DietPlan from '../../src/models/diet-plan.model.js';
import Food from '../../src/models/food.model.js';
import User from '../../src/models/user.model.js';
import { listDietPlansForAdmin } from '../../src/services/diet-plan.service.js';
import { addCalendarDays, businessDayOf, startOfBusinessDay } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let alice;
let bob;
let aliceToken;
let bobToken;
let coach;
let rice;
let egg;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9185000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};

const day = (d) => startOfBusinessDay(d);
const today = () => businessDayOf(new Date());

const plan = (overrides = {}) => ({
  planId: 'gogetfit:1',
  clientId: alice._id,
  coachId: coach._id,
  name: 'Alice plan',
  fromDate: day('2024-06-01'),
  toDate: day('2024-06-10'),
  assignedAt: new Date('2024-05-30T10:00:00Z'),
  bmr: 1543.15,
  tdee: 1851.78,
  goal: 'Fat/Weight Loss',
  targets: { calories: 1601, fat: 36, carbs: 200, protein: 120 },
  meals: [
    { meal: 1, foods: [{ foodId: rice._id, qty: 200, portion: 100, servingUnit: 'Grams', calories: 113, fat: 3.5, carbs: 19, protein: 2 }] },
    { meal: 3, foods: [{ foodId: egg._id, qty: 2, portion: 1, servingUnit: 'Piece', calories: 78, fat: 5.3, carbs: 0.6, protein: 6.3 }] },
  ],
  ...overrides,
});

const get = (token, query = '') => server.request('GET', `/api/users/me/diet-plan${query}`, { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  coach = await Coach.create({ userId: (await seedUser(['user', 'coach'], 'Prajwal'))._id, profile: { level: 'LEVEL 1' } });
  alice = await seedUser(['user', 'client'], 'Alice');
  bob = await seedUser(['user', 'client'], 'Bob');
  aliceToken = tokenFor(alice);
  bobToken = tokenFor(bob);
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', brand: 'Daawat', servingUnit: 'Grams', servingQuantity: 100, calories: 999, fat: 999, carbs: 999, protein: 999, image: { url: '/uploads/foods/rice.jpg', storageKey: 'foods/rice.jpg' } });
  egg = await Food.create({ name: 'Egg', foodType: 'Non-Vegetarian', servingUnit: 'Piece', servingQuantity: 1, calories: 999, fat: 999, carbs: 999, protein: 999 });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('requires a signed-in user', async () => {
  const res = await server.request('GET', '/api/users/me/diet-plan', {});
  assert.equal(res.status, 401);
});

test('a member sees only their own plan; another member\'s plan is never returned', async () => {
  await DietPlan.create(plan());
  await DietPlan.create(plan({ planId: 'gogetfit:2', clientId: bob._id, name: 'Bob plan' }));

  assert.equal((await get(aliceToken, '?date=2024-06-05')).body.data.dietPlan.name, 'Alice plan');
  assert.equal((await get(bobToken, '?date=2024-06-05')).body.data.dietPlan.name, 'Bob plan');
});

test('no client id from the request is honoured', async () => {
  await DietPlan.create(plan({ planId: 'gogetfit:2', clientId: bob._id, name: 'Bob plan' }));
  for (const query of [`?date=2024-06-05&clientId=${bob._id}`, `?date=2024-06-05&userId=${bob._id}`]) {
    const res = await get(aliceToken, query);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.dietPlan, null, query);
  }
});

test('a member with no plan gets a clean empty answer', async () => {
  await DietPlan.create(plan({ clientId: bob._id }));
  const res = await get(aliceToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.dietPlan, null);
  assert.equal(res.body.data.date, today());
});

test('without a date it answers for today; a plan covering today is returned', async () => {
  await DietPlan.create(plan({ fromDate: day(addCalendarDays(today(), -1)), toDate: day(addCalendarDays(today(), 1)) }));
  const res = await get(aliceToken);
  assert.equal(res.body.data.date, today());
  assert.equal(res.body.data.dietPlan.name, 'Alice plan');
  assert.equal(res.body.data.dietPlan.period, 'current');
});

test('a historical day, a gap day and newest-assignment-wins match the admin schedule', async () => {
  await DietPlan.create(plan({ fromDate: day('2024-06-01'), toDate: day('2024-06-03') }));
  await DietPlan.create(plan({ fromDate: day('2024-06-06'), toDate: day('2024-06-10') }));
  await DietPlan.create(plan({ planId: 'gogetfit:9', name: 'Newer', fromDate: day('2024-06-08'), toDate: day('2024-06-09'), assignedAt: new Date('2024-06-07') }));

  const { schedule, dietPlans } = await listDietPlansForAdmin(String(alice._id));
  for (let d = 0; d <= 11; d += 1) {
    const key = addCalendarDays('2024-05-31', d);
    const res = await get(aliceToken, `?date=${key}`);
    const fromAdmin = schedule.find((s) => s.from <= key && key <= s.to)?.dietPlanId ?? null;
    assert.equal(res.body.data.dietPlan?.id ?? null, fromAdmin, key);
  }
  assert.equal((await get(aliceToken, '?date=2024-06-04')).body.data.dietPlan, null); // gap
  assert.equal((await get(aliceToken, '?date=2024-06-08')).body.data.dietPlan.name, 'Newer');
  assert.equal(dietPlans.length, 3);
});

test('the day\'s plan carries the frozen snapshot, scaled values and Food identity', async () => {
  await DietPlan.create(plan());
  const p = (await get(aliceToken, '?date=2024-06-02')).body.data.dietPlan;

  assert.deepEqual([p.name, p.fromDate, p.toDate, p.goal, p.bmr, p.tdee], ['Alice plan', '2024-06-01', '2024-06-10', 'Fat/Weight Loss', 1543.15, 1851.78]);
  assert.deepEqual(p.targets, { calories: 1601, protein: 120, carbs: 200, fat: 36 });
  assert.equal(p.coach.name, 'Prajwal');
  assert.deepEqual(p.meals.map((m) => m.meal), [1, 3]);
  const [r] = p.meals[0].foods;
  assert.deepEqual([r.qty, r.portion, r.servingUnit], [200, 100, 'Grams']);
  assert.deepEqual(r.perPortion, { calories: 113, protein: 2, carbs: 19, fat: 3.5 });
  assert.deepEqual(r.nutrition, { calories: 226, protein: 4, carbs: 38, fat: 7 });
  assert.equal(r.food.name, 'Rice');
  assert.equal(r.food.brand, 'Daawat');
  assert.equal(r.food.image.url, '/uploads/foods/rice.jpg');
  assert.equal(p.meals[1].foods[0].food.foodType, 'Non-Vegetarian');
  assert.deepEqual(p.totals, { calories: 382, protein: 16.6, carbs: 39.2, fat: 17.6 });
});

test('a missing Food reference is returned flagged, not fatal', async () => {
  const ghost = new mongoose.Types.ObjectId();
  await DietPlan.create(plan({ meals: [{ meal: 2, foods: [{ foodId: ghost, qty: 1, portion: 1, servingUnit: 'Bowl', calories: 50, fat: 1, carbs: 2, protein: 3 }] }] }));
  const res = await get(aliceToken, '?date=2024-06-02');
  assert.equal(res.status, 200);
  const [f] = res.body.data.dietPlan.meals[0].foods;
  assert.equal(f.food, null);
  assert.equal(f.missingFood, true);
  assert.deepEqual(res.body.data.missingFoodIds, [String(ghost)]);
});

test('an invalid date is a 400', async () => {
  for (const q of ['?date=2024-13-01', '?date=yesterday', '?date=2024-02-30']) {
    const res = await get(aliceToken, q);
    assert.equal(res.status, 400, q);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
});

test('reading never changes a diet plan', async () => {
  const doc = await DietPlan.create(plan());
  const beforeRead = await DietPlan.findById(doc._id).lean();
  await get(aliceToken, '?date=2024-06-02');
  await get(aliceToken);
  assert.deepEqual(await DietPlan.findById(doc._id).lean(), beforeRead);
});
