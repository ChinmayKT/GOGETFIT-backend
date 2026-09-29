import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import FreeDietPlan from '../../src/models/free-diet-plan.model.js';
import User from '../../src/models/user.model.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  login,
  startTestServer,
} from '../helpers/test-server.js';

let server;
let token;

/** A template as the migration produces one. */
const template = (overrides = {}) => ({
  dietType: 'Veg/NonVeg',
  range: { from: 2791, to: 2800 },
  status: 'active',
  meals: [
    {
      mealId: 1,
      foods: [
        {
          legacyPlanMealId: 1,
          foodName: 'Test Chicken',
          foodType: null,
          unit: 'g',
          quantity: 100,
          calories: 165,
          fat: 3.6,
          carbs: 0,
          protein: 31,
        },
      ],
    },
    {
      mealId: 3,
      foods: [
        {
          legacyPlanMealId: 2,
          foodName: 'Brown Rice',
          foodType: null,
          unit: 'grams',
          quantity: 80,
          calories: 280,
          fat: 2,
          carbs: 58,
          protein: 6,
        },
      ],
    },
  ],
  legacy: { source: 'gogetfit', planId: 730 },
  ...overrides,
});

const seedTemplate = (overrides = {}) => FreeDietPlan.create(template(overrides));

/** The fitness profile from the brief. bmr/tdee are the app's own figures. */
const fitnessProfile = (overrides = {}) => ({
  height: 174,
  weight: 65,
  bodyFatPercentage: 17.61,
  activityLevel: 'active',
  foodType: 'nonVegetarian',
  goal: 'maintainPhysique',
  bmr: 1617.5,
  tdee: 2790.1875,
  ...overrides,
});

/** Signs in and completes the identity half of the profile. */
const loginMember = async () => {
  const { token: issued } = await login(server.request, '9111111111');
  await server.request('PATCH', '/api/users/me/profile', {
    token: issued,
    body: { name: 'Prajwal', dateOfBirth: '2001-09-22', gender: 'male', city: 'Davangere' },
  });
  return issued;
};

const saveFitness = (fitness, authToken = token) =>
  server.request('PATCH', '/api/users/me/profile', {
    token: authToken,
    body: { fitnessProfile: fitness },
  });

const rawUser = () => User.collection.findOne({ 'phone.normalized': '919111111111' });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  token = await loginMember();
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// =================== CASE 1: a valid profile gets a pointer =================

test('1. saving a valid profile stores bmr, tdee and the matched plan id', async () => {
  const plan = await seedTemplate();

  const response = await saveFitness(fitnessProfile());

  assert.equal(response.status, 200);
  // The save reports what it matched, as a state rather than an error.
  assert.equal(response.body.data.freeDietPlan.status, 'matched');
  assert.equal(response.body.data.freeDietPlan.planId, String(plan._id));
  assert.equal(response.body.data.freeDietPlan.dietType, 'Veg/NonVeg');
  // Maintenance: tdee + 10.
  assert.equal(response.body.data.freeDietPlan.targetCalories, 2800.1875);

  const stored = await rawUser();
  assert.equal(stored.profile.fitnessProfile.bmr, 1617.5);
  assert.equal(stored.profile.fitnessProfile.tdee, 2790.1875);
  assert.equal(String(stored.profile.freeDietPlanId), String(plan._id));
  // Stored as an ObjectId reference, not a string and not a copy.
  assert.ok(stored.profile.freeDietPlanId instanceof mongoose.Types.ObjectId);
});

test('1b. GET /users/me exposes the pointer as a string', async () => {
  const plan = await seedTemplate();
  await saveFitness(fitnessProfile());

  const me = await server.request('GET', '/api/users/me', { token });

  assert.equal(me.body.data.user.profile.freeDietPlanId, String(plan._id));
});

test('1c. each food preference matches its own diet type', async () => {
  for (const [foodType, dietType, planId] of [
    ['vegetarian', 'Veg.', 11],
    ['nonVegetarian', 'Veg/NonVeg', 12],
    ['vegetarianPlusEgg', 'Veg/Egg', 13],
    // The brief's spelling of the same option.
    ['vegetarianEgg', 'Veg/Egg', 14],
  ]) {
    await clearTestDb();
    token = await loginMember();
    const plan = await seedTemplate({ dietType, legacy: { source: 'gogetfit', planId } });

    const response = await saveFitness(fitnessProfile({ foodType }));

    assert.equal(response.body.data.freeDietPlan.dietType, dietType, foodType);
    assert.equal(String((await rawUser()).profile.freeDietPlanId), String(plan._id));
  }
});

test('1d. the goal decides the target and therefore the band', async () => {
  // fatLoss: diff 1172.6875 >= 800 -> tdee - 400 = 2390.1875
  const loss = await seedTemplate({
    range: { from: 2381, to: 2400 },
    legacy: { source: 'gogetfit', planId: 601 },
  });
  // muscleGain: tdee + 150 = 2940.1875
  const gain = await seedTemplate({
    range: { from: 2931, to: 2950 },
    legacy: { source: 'gogetfit', planId: 602 },
  });
  // maintainPhysique: tdee + 10 = 2800.1875
  const maintain = await seedTemplate({
    range: { from: 2791, to: 2800 },
    legacy: { source: 'gogetfit', planId: 603 },
  });

  for (const [goal, expected, plan] of [
    ['fatLoss', 2390.1875, loss],
    ['muscleGain', 2940.1875, gain],
    ['maintainPhysique', 2800.1875, maintain],
  ]) {
    const response = await saveFitness(fitnessProfile({ goal }));

    assert.equal(response.body.data.freeDietPlan.targetCalories, expected, goal);
    assert.equal(response.body.data.freeDietPlan.planId, String(plan._id), goal);
  }
});

// =================== CASE 2: the pointer is replaced =======================

test('2. a new target replaces the previous pointer and keeps nothing else', async () => {
  const planA = await seedTemplate({
    range: { from: 2791, to: 2800 },
    legacy: { source: 'gogetfit', planId: 730 },
  });
  const planB = await seedTemplate({
    range: { from: 2381, to: 2400 },
    legacy: { source: 'gogetfit', planId: 640 },
  });

  await saveFitness(fitnessProfile());
  const before = await rawUser();
  assert.equal(String(before.profile.freeDietPlanId), String(planA._id));

  // Same body, different goal: the target moves into plan B's band.
  const response = await saveFitness(fitnessProfile({ goal: 'fatLoss' }));
  const after = await rawUser();

  assert.equal(response.body.data.freeDietPlan.planId, String(planB._id));
  assert.equal(response.body.data.freeDietPlan.previousPlanId, String(planA._id));
  assert.equal(String(after.profile.freeDietPlanId), String(planB._id));

  // Plan A is not referenced anywhere on the user any more.
  const serialised = JSON.stringify(after);
  assert.equal(serialised.includes(String(planA._id)), false, 'no trace of the old plan');
  assert.equal(Array.isArray(after.profile.freeDietPlanId), false, 'one pointer, not a list');
});

// =================== CASE 3: re-saving is stable ===========================

test('3. saving the same inputs again keeps the same plan id', async () => {
  const plan = await seedTemplate();

  await saveFitness(fitnessProfile());
  const first = await rawUser();
  const second = await saveFitness(fitnessProfile());
  const afterSecond = await rawUser();

  assert.equal(second.body.data.freeDietPlan.planId, String(plan._id));
  assert.equal(second.body.data.freeDietPlan.changed, false, 'nothing to rewrite');
  assert.equal(
    String(afterSecond.profile.freeDietPlanId),
    String(first.profile.freeDietPlanId),
  );
  // And no second document was created anywhere.
  const collections = await mongoose.connection.db.listCollections().toArray();
  assert.equal(
    collections.some((c) => c.name === 'generatedfreedietplans'),
    false,
    'the generated-plan collection does not exist',
  );
});

// =================== CASE 4: no match ======================================

test('4. no matching template clears the pointer and says so', async () => {
  // The real gap: Veg/Egg has nothing between 2601 and 2700.
  await seedTemplate({
    dietType: 'Veg/Egg',
    range: { from: 2501, to: 2600 },
    legacy: { source: 'gogetfit', planId: 457 },
  });
  await seedTemplate({
    dietType: 'Veg/Egg',
    range: { from: 2701, to: 2710 },
    legacy: { source: 'gogetfit', planId: 458 },
  });

  // tdee 2640 + 10 = 2650, inside the gap.
  const response = await saveFitness(
    fitnessProfile({ foodType: 'vegetarianPlusEgg', tdee: 2640, bmr: 1617.5 }),
  );

  assert.equal(response.status, 200, 'the profile save itself still succeeded');
  assert.equal(response.body.data.freeDietPlan.status, 'not_found');
  assert.equal(response.body.data.freeDietPlan.dietType, 'Veg/Egg');
  assert.equal(response.body.data.freeDietPlan.targetCalories, 2650);
  assert.equal(response.body.data.freeDietPlan.planId, null);

  const stored = await rawUser();
  assert.equal(stored.profile.freeDietPlanId, null, 'no nearest-range fallback');
});

test('4b. a near-miss band is never substituted', async () => {
  // 10 kcal outside the band on either side.
  await seedTemplate({ range: { from: 2801, to: 2900 } });

  const response = await saveFitness(fitnessProfile());

  assert.equal(response.body.data.freeDietPlan.status, 'not_found');
  assert.equal((await rawUser()).profile.freeDietPlanId, null);
});

test('4c. another diet type is never substituted', async () => {
  await seedTemplate({ dietType: 'Veg.', range: { from: 2791, to: 2800 } });

  const response = await saveFitness(fitnessProfile({ foodType: 'nonVegetarian' }));

  assert.equal(response.body.data.freeDietPlan.status, 'not_found');
});

test('4d. an archived template is never matched', async () => {
  await seedTemplate({ status: 'archived' });

  const response = await saveFitness(fitnessProfile());

  assert.equal(response.body.data.freeDietPlan.status, 'not_found');
});

test('4e. a match that stops matching clears the pointer', async () => {
  const plan = await seedTemplate();
  await saveFitness(fitnessProfile());
  assert.equal(String((await rawUser()).profile.freeDietPlanId), String(plan._id));

  // The member changes their preference to one with no template at all.
  const response = await saveFitness(fitnessProfile({ foodType: 'vegetarian' }));

  assert.equal(response.body.data.freeDietPlan.status, 'not_found');
  assert.equal((await rawUser()).profile.freeDietPlanId, null, 'the stale pointer is dropped');
});

test('4f. an incomplete fitness profile leaves no pointer and no fake target', async () => {
  const plan = await seedTemplate();
  await saveFitness(fitnessProfile());

  const response = await saveFitness({ tdee: null });

  assert.equal(response.body.data.freeDietPlan.status, 'incomplete');
  assert.ok(
    response.body.data.freeDietPlan.missing.some((entry) => entry.includes('tdee')),
    'says what is missing',
  );
  assert.equal((await rawUser()).profile.freeDietPlanId, null);
  assert.ok(plan, 'the template itself is untouched');
});

test('4g. an unrecognised goal or preference is reported, not defaulted', async () => {
  await seedTemplate();

  for (const patch of [{ goal: 'getShredded' }, { foodType: 'pescatarian' }]) {
    const response = await saveFitness(fitnessProfile(patch));

    assert.equal(response.body.data.freeDietPlan.status, 'incomplete', JSON.stringify(patch));
    assert.equal((await rawUser()).profile.freeDietPlanId, null);
  }
});

// =================== CASE 5: document shape ================================

test('5. the user document holds a pointer and nothing resembling a plan', async () => {
  await seedTemplate();
  await saveFitness(fitnessProfile());

  const stored = await rawUser();

  assert.ok(Object.prototype.hasOwnProperty.call(stored.profile, 'freeDietPlanId'));
  // The retired architecture leaves no trace.
  for (const field of ['generatedFreeDietPlanId', 'generatedFreeDietPlan', 'freeDietPlan']) {
    assert.equal(Object.prototype.hasOwnProperty.call(stored.profile, field), false, field);
    assert.equal(Object.prototype.hasOwnProperty.call(stored, field), false, `root ${field}`);
  }
  // No embedded template: no meals, foods, dietType or range on the user.
  for (const field of ['meals', 'foods', 'dietType', 'range']) {
    assert.equal(Object.prototype.hasOwnProperty.call(stored.profile, field), false, field);
    assert.equal(
      Object.prototype.hasOwnProperty.call(stored.profile.fitnessProfile, field),
      false,
      `fitnessProfile ${field}`,
    );
  }
  assert.equal(JSON.stringify(stored).includes('Test Chicken'), false, 'no copied food rows');
});

// =================== the member-facing template endpoint ===================

test('6. a member fetches the template their pointer names', async () => {
  const plan = await seedTemplate();
  await saveFitness(fitnessProfile());

  const me = await server.request('GET', '/api/users/me', { token });
  const id = me.body.data.user.profile.freeDietPlanId;
  const response = await server.request('GET', `/api/free-diet-plans/${id}`, { token });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.plan.id, String(plan._id));
  assert.equal(response.body.data.plan.dietType, 'Veg/NonVeg');
  assert.deepEqual(response.body.data.plan.range, { from: 2791, to: 2800 });
  assert.deepEqual(
    response.body.data.plan.meals.map((meal) => meal.mealId),
    [1, 3],
  );
  assert.deepEqual(response.body.data.plan.meals[0].foods[0], {
    foodName: 'Test Chicken',
    unit: 'g',
    quantity: 100,
    calories: 165,
    fat: 3.6,
    carbs: 0,
    protein: 31,
  });
});

test('6b. the member projection hides the administrative fields', async () => {
  const plan = await seedTemplate();

  const response = await server.request('GET', `/api/free-diet-plans/${plan._id}`, { token });

  for (const field of ['status', 'legacy', 'migration', 'createdBy', 'updatedBy', 'legacyPlanId']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(response.body.data.plan, field),
      false,
      field,
    );
  }
  assert.equal(
    Object.prototype.hasOwnProperty.call(response.body.data.plan.meals[0].foods[0], 'legacyPlanMealId'),
    false,
  );
});

test('6c. the endpoint needs a token but not the admin role', async () => {
  const plan = await seedTemplate();

  const anonymous = await server.request('GET', `/api/free-diet-plans/${plan._id}`, {});
  const member = await server.request('GET', `/api/free-diet-plans/${plan._id}`, { token });

  assert.equal(anonymous.status, 401);
  assert.equal(member.status, 200, 'an ordinary member may read a template');
});

test('6d. an unknown, malformed or archived id returns 404', async () => {
  const archived = await seedTemplate({ status: 'archived' });

  for (const id of ['507f1f77bcf86cd799439011', 'not-an-object-id', String(archived._id)]) {
    const response = await server.request('GET', `/api/free-diet-plans/${id}`, { token });
    assert.equal(response.status, 404, id);
  }
});

test('6e. the admin CRUD still refuses an ordinary member', async () => {
  const plan = await seedTemplate();

  const list = await server.request('GET', '/api/admin/free-diet-plans', { token });
  const detail = await server.request('GET', `/api/admin/free-diet-plans/${plan._id}`, { token });

  assert.equal(list.status, 403);
  assert.equal(detail.status, 403);
});

// =================== end to end ============================================

test('7. end to end: save the profile, read the pointer, fetch that plan', async () => {
  const plan = await seedTemplate();

  // 1-4. Save Changes on the fitness profile.
  const saved = await saveFitness(fitnessProfile());
  assert.equal(saved.status, 200);

  // 5-6. What MongoDB holds.
  const stored = await rawUser();
  assert.equal(stored.profile.fitnessProfile.bmr, 1617.5);
  assert.equal(stored.profile.fitnessProfile.tdee, 2790.1875);
  assert.equal(String(stored.profile.freeDietPlanId), String(plan._id));

  // 7-8. GET /users/me, and the id it carries.
  const me = await server.request('GET', '/api/users/me', { token });
  const pointer = me.body.data.user.profile.freeDietPlanId;
  assert.equal(pointer, String(stored.profile.freeDietPlanId));

  // 9-10. Fetch that exact template.
  const fetched = await server.request('GET', `/api/free-diet-plans/${pointer}`, { token });
  assert.equal(fetched.body.data.plan.id, pointer);

  // 13. The rows the screen will show are the template's own.
  assert.deepEqual(
    fetched.body.data.plan.meals.flatMap((meal) => meal.foods.map((food) => food.foodName)),
    ['Test Chicken', 'Brown Rice'],
  );
  const template = await FreeDietPlan.findById(pointer).lean();
  assert.equal(
    fetched.body.data.plan.meals[0].foods[0].calories,
    template.meals[0].foods[0].calories,
  );
});
