import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import FreeDietPlan from '../../src/models/free-diet-plan.model.js';
import User from '../../src/models/user.model.js';
import { getUserFreeDietPlanForAdmin } from '../../src/services/free-diet-plan.service.js';
import { targetCaloriesFor } from '../../src/services/free-diet-plan-match.service.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let adminToken;
let memberToken;
let plan;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, profile = {}) => {
  seq += 1;
  const phone = `9187000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `User ${seq}`, ...profile }, roles, status: 'active' });
};

const fitness = (overrides = {}) => ({
  height: 175,
  weight: 78,
  bodyFatPercentage: 18,
  activityLevel: 'moderatelyActive',
  foodType: 'nonVegetarian',
  goal: 'maintainPhysique',
  bmr: 1648,
  tdee: 1977.6,
  ...overrides,
});

const get = (id, token = adminToken) => server.request('GET', `/api/admin/users/${id}/free-diet-plan`, { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  adminToken = tokenFor(await seedUser(['user', 'admin']));
  memberToken = tokenFor(await seedUser(['user', 'client']));
  plan = await FreeDietPlan.create({
    dietType: 'Veg/NonVeg',
    range: { from: 1981, to: 1990 },
    meals: [
      { mealId: 1, foods: [{ foodName: 'Oats', unit: 'grams', quantity: 40, calories: 150, fat: 3, carbs: 27, protein: 5 }] },
      {
        mealId: 2,
        foods: [
          { foodName: 'Chicken breast', unit: 'grams', quantity: 150, calories: 248, fat: 5.4, carbs: 0, protein: 46.5 },
          { foodName: 'Rice', unit: 'bowl', quantity: 1, calories: 200, fat: 0.4, carbs: 44, protein: 4.2 },
        ],
      },
    ],
  });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('admin only: no token is 401, a member is 403 - even for their own record', async () => {
  const member = await seedUser(['user', 'client'], { fitnessProfile: fitness(), freeDietPlanId: plan._id });
  assert.equal((await server.request('GET', `/api/admin/users/${member._id}/free-diet-plan`, {})).status, 401);
  const res = await get(member._id, tokenFor(member));
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');
  assert.equal((await get(member._id, memberToken)).status, 403);
});

test('an unknown or malformed user id is USER_NOT_FOUND', async () => {
  assert.equal((await get(new mongoose.Types.ObjectId())).body.error.code, 'USER_NOT_FOUND');
  assert.equal((await get('nope')).status, 404);
});

test('assigned: the stored figures, the match target and the template the member received', async () => {
  const user = await seedUser(['user'], { name: 'Prajwal', fitnessProfile: fitness(), freeDietPlanId: plan._id });
  const res = await get(user._id);
  assert.equal(res.status, 200);
  const d = res.body.data;

  assert.equal(d.status, 'assigned');
  assert.deepEqual(d.user, { id: String(user._id), name: 'Prajwal' });
  // Stored values, not recalculated.
  assert.equal(d.fitness.bmr, 1648);
  assert.equal(d.fitness.tdee, 1977.6);
  assert.deepEqual(d.fitness, fitness());
  assert.deepEqual(d.missing, []);
  // The match service's own target, and its rounded lookup figure.
  assert.equal(d.match.dietType, 'Veg/NonVeg');
  assert.equal(d.match.targetCalories, targetCaloriesFor({ bmr: 1648, tdee: 1977.6, goal: 'maintainPhysique' }));
  assert.equal(d.match.lookupCalories, 1988);
  // The range is the template's band.
  assert.equal(d.freeDietPlanId, String(plan._id));
  assert.deepEqual(d.freeDietPlan.range, { from: 1981, to: 1990 });
  assert.equal(d.freeDietPlan.dietType, 'Veg/NonVeg');
  assert.equal(d.planMatchesProfile, true);
  assert.deepEqual(d.freeDietPlan.meals.map((m) => [m.mealId, m.foods.map((f) => f.foodName)]), [[1, ['Oats']], [2, ['Chicken breast', 'Rice']]]);
  assert.deepEqual(d.freeDietPlan.totals, { calories: 598, fat: 8.8, carbs: 71, protein: 55.7 });
});

test('a profile changed after assignment is flagged, not re-matched', async () => {
  const user = await seedUser(['user'], { fitnessProfile: fitness({ goal: 'fatLoss' }), freeDietPlanId: plan._id });
  const d = (await get(user._id)).body.data;
  assert.equal(d.status, 'assigned');
  assert.equal(d.planMatchesProfile, false);
  // Read-only: the pointer is untouched.
  assert.equal(String((await User.findById(user._id).lean()).profile.freeDietPlanId), String(plan._id));
});

test('incomplete: no plan, and exactly what the match is missing', async () => {
  const user = await seedUser(['user'], { fitnessProfile: fitness({ goal: null, foodType: null }) });
  const d = (await get(user._id)).body.data;
  assert.equal(d.status, 'incomplete');
  assert.deepEqual(d.missing.map((m) => m.label), ['Food type', 'Goal']);
  assert.equal(d.freeDietPlan, null);
  assert.equal(d.match.targetCalories, null);
  assert.equal(d.fitness.bmr, 1648);
});

test('an unrecognised goal is reported as such', async () => {
  const user = await seedUser(['user'], { fitnessProfile: fitness({ goal: 'getHuge' }) });
  const d = (await get(user._id)).body.data;
  assert.equal(d.status, 'incomplete');
  assert.deepEqual(d.missing.map((m) => m.label), ['Goal (unrecognised value)']);
});

test('not assigned: complete profile, no pointer - a state, not an error', async () => {
  const user = await seedUser(['user'], { fitnessProfile: fitness() });
  const res = await get(user._id);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'not_assigned');
  assert.equal(res.body.data.match.lookupCalories, 1988);
  assert.equal(res.body.data.freeDietPlan, null);
});

test('no fitness data at all', async () => {
  const user = await seedUser(['user']);
  const d = (await get(user._id)).body.data;
  assert.equal(d.status, 'no_fitness');
  assert.equal(d.freeDietPlan, null);
});

test('a pointer to a template that no longer exists is reported', async () => {
  const user = await seedUser(['user'], { fitnessProfile: fitness(), freeDietPlanId: new mongoose.Types.ObjectId() });
  const d = (await get(user._id)).body.data;
  assert.equal(d.status, 'plan_missing');
  assert.equal(d.freeDietPlan, null);
});

test('reads only the user and the one template - no diet plans, foods or enrollments - and writes nothing', async () => {
  const user = await seedUser(['user'], { fitnessProfile: fitness({ goal: 'fatLoss' }), freeDietPlanId: plan._id });
  const before = await User.findById(user._id).lean();
  const calls = [];
  mongoose.set('debug', (collection, method) => calls.push(`${collection}.${method}`));
  try {
    await getUserFreeDietPlanForAdmin(String(user._id));
  } finally {
    mongoose.set('debug', false);
  }
  assert.deepEqual(calls, ['users.findOne', 'freedietplans.findOne']);
  assert.deepEqual(await User.findById(user._id).lean(), before);
});
