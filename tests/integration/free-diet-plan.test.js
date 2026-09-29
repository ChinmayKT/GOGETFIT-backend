import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import FreeDietPlan from '../../src/models/free-diet-plan.model.js';
import User from '../../src/models/user.model.js';
import { loadFreeDietPlans } from '../../migration/loaders/free-diet-plan.loader.js';
import { provisionAdmin } from '../../src/services/admin-provisioning.service.js';
import { resetRateLimits } from '../../src/middleware/rate-limit.middleware.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  startTestServer,
} from '../helpers/test-server.js';

let server;
let adminToken;

const ADMIN_PHONE = '918123260930';
const ADMIN_EMAIL = 'prajwal@gogetfitonline.com';
const ADMIN_PASSWORD = 'bootstrap-pass-123';

const seedUser = (overrides = {}) =>
  User.create({
    phone: {
      raw: overrides.phone ?? '919000000001',
      normalized: overrides.phone ?? '919000000001',
    },
    profile: { name: overrides.name ?? 'Test', email: overrides.email ?? null },
    roles: overrides.roles ?? ['user'],
    status: overrides.status ?? 'active',
  });

/** An authenticated administrator, provisioned exactly as the CLI does. */
const loginAsAdmin = async () => {
  await seedUser({ phone: ADMIN_PHONE, name: 'Prajwal', email: ADMIN_EMAIL });
  await provisionAdmin({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD, apply: true });
  const response = await server.request('POST', '/api/auth/admin/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  return response.body.data.token;
};

/** A valid token for an account that holds these roles but not "admin". */
const tokenForRoles = async (roles, phone) => {
  const user = await seedUser({ phone, roles });
  return jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
};

// --- legacy fixtures --------------------------------------------------------

const planRow = (overrides = {}) => ({
  plan_id: 5,
  diet_type: 'Veg.',
  range_from: '800',
  range_to: '840',
  create_date: '2022-01-12 18:50:19',
  created_by: '123',
  last_update_date: '2023-05-11 00:25:44',
  last_update_by: '123',
  ...overrides,
});

const mealRow = (overrides = {}) => ({
  food_id: 13350,
  plan_id: 5,
  meal_id: 1,
  food_name: 'Bread',
  food_type: '',
  unit: 'slice',
  qty: '1',
  calories: 69,
  fat: 1,
  carbs: 12.5,
  protein: 2.5,
  ...overrides,
});

const validPayload = (overrides = {}) => ({
  dietType: 'Veg.',
  range: { from: 1200, to: 1300 },
  meals: [
    {
      mealId: 1,
      foods: [
        {
          foodName: 'Bread',
          unit: 'slice',
          quantity: 1,
          calories: 69,
          fat: 1,
          carbs: 12.5,
          protein: 2.5,
        },
      ],
    },
  ],
  ...overrides,
});

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  resetRateLimits();
  adminToken = await loginAsAdmin();
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// =========================== MIGRATION =====================================

test('1. every legacy m_plan row is discovered and migrated', async () => {
  const plans = [planRow({ plan_id: 5 }), planRow({ plan_id: 6 }), planRow({ plan_id: 7 })];
  const summary = await loadFreeDietPlans(plans, [mealRow()], { dryRun: false });

  assert.equal(summary.plansInspected, 3);
  assert.equal(summary.created, 3);
  assert.equal(await FreeDietPlan.countDocuments({}), 3);
});

test('2. the legacy plan id is preserved as the migration identity', async () => {
  await loadFreeDietPlans([planRow({ plan_id: 42 })], [], { dryRun: false });

  const doc = await FreeDietPlan.findOne({ 'legacy.planId': 42 });
  assert.equal(doc.legacy.source, 'gogetfit');
  assert.equal(doc.legacy.planId, 42);
  assert.equal(doc.legacy.createdBy, '123', 'the legacy audit trail travels along');
});

test('3. re-running the migration creates no duplicate documents', async () => {
  const plans = [planRow({ plan_id: 5 }), planRow({ plan_id: 6 })];
  const rows = [mealRow(), mealRow({ food_id: 2, plan_id: 6 })];

  const first = await loadFreeDietPlans(plans, rows, { dryRun: false });
  const second = await loadFreeDietPlans(plans, rows, { dryRun: false });

  assert.equal(first.created, 2);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.plansUnchanged, 2, 'the second run is a genuine no-op');
  assert.equal(await FreeDietPlan.countDocuments({}), 2);
});

test('4. meals are attached to the plan they belong to', async () => {
  await loadFreeDietPlans(
    [planRow({ plan_id: 5 }), planRow({ plan_id: 6 })],
    [
      mealRow({ food_id: 1, plan_id: 5, food_name: 'Bread' }),
      mealRow({ food_id: 2, plan_id: 6, meal_id: 2, food_name: 'Dal' }),
    ],
    { dryRun: false },
  );

  const five = await FreeDietPlan.findOne({ 'legacy.planId': 5 });
  const six = await FreeDietPlan.findOne({ 'legacy.planId': 6 });

  assert.equal(five.meals[0].foods[0].foodName, 'Bread');
  assert.equal(six.meals[0].mealId, 2);
  assert.equal(six.meals[0].foods[0].foodName, 'Dal');
});

test('5. food order inside a meal is preserved', async () => {
  await loadFreeDietPlans(
    [planRow()],
    [
      mealRow({ food_id: 10, food_name: 'Bread' }),
      mealRow({ food_id: 11, food_name: 'Cheese' }),
      mealRow({ food_id: 12, food_name: 'Butter' }),
    ],
    { dryRun: false },
  );

  const doc = await FreeDietPlan.findOne({ 'legacy.planId': 5 });
  assert.deepEqual(
    doc.meals[0].foods.map((food) => food.foodName),
    ['Bread', 'Cheese', 'Butter'],
  );
});

test('6. an empty legacy template is preserved, never deleted or filled', async () => {
  const summary = await loadFreeDietPlans([planRow({ plan_id: 271 })], [], { dryRun: false });

  const doc = await FreeDietPlan.findOne({ 'legacy.planId': 271 });
  assert.deepEqual(doc.meals, []);
  assert.deepEqual(summary.quality.emptyPlans, [271]);
});

test('7. a missing meal 5 stays missing and is reported', async () => {
  const summary = await loadFreeDietPlans(
    [planRow()],
    [mealRow({ meal_id: 1 }), mealRow({ food_id: 2, meal_id: 2 })],
    { dryRun: false },
  );

  const doc = await FreeDietPlan.findOne({ 'legacy.planId': 5 });
  assert.equal(
    doc.meals.some((meal) => meal.mealId === 5),
    false,
  );
  assert.equal(summary.quality.plansMissingMeal5, 1);
});

test('8. legacy diet types are preserved, including the "Select" placeholder', async () => {
  const summary = await loadFreeDietPlans(
    [planRow({ plan_id: 609, diet_type: 'Select' }), planRow({ plan_id: 610, diet_type: 'Veg/Egg' })],
    [],
    { dryRun: false },
  );

  assert.equal((await FreeDietPlan.findOne({ 'legacy.planId': 609 })).dietType, 'Select');
  assert.equal((await FreeDietPlan.findOne({ 'legacy.planId': 610 })).dietType, 'Veg/Egg');
  assert.deepEqual(summary.quality.unknownDietTypes, { Select: 1 });
});

test('9. legacy calorie ranges are preserved exactly', async () => {
  await loadFreeDietPlans([planRow({ range_from: '2601', range_to: '2610' })], [], { dryRun: false });

  const doc = await FreeDietPlan.findOne({ 'legacy.planId': 5 });
  assert.deepEqual({ from: doc.range.from, to: doc.range.to }, { from: 2601, to: 2610 });
});

test('10. data-quality defects are reported rather than repaired', async () => {
  const summary = await loadFreeDietPlans(
    [
      // Two templates declaring the identical band - preserved, not merged.
      planRow({ plan_id: 710, diet_type: 'Veg/NonVeg', range_from: '2601', range_to: '2610' }),
      planRow({ plan_id: 711, diet_type: 'Veg/NonVeg', range_from: '2601', range_to: '2610' }),
    ],
    [
      // Food totals far under the declared band, and a zero-calorie row.
      mealRow({ food_id: 1, plan_id: 710, calories: 0 }),
      mealRow({ food_id: 2, plan_id: 711, calories: 10 }),
    ],
    { dryRun: false },
  );

  assert.equal(summary.quality.duplicateBands.length, 1);
  assert.deepEqual(summary.quality.duplicateBands[0].planIds, [710, 711]);
  assert.equal(summary.quality.zeroCalorieFoods, 1);
  assert.equal(summary.quality.totalsOutsideBand.length, 2);
  // Both documents exist: nothing was merged away.
  assert.equal(await FreeDietPlan.countDocuments({}), 2);
});

test('10b. a dry run writes nothing', async () => {
  const summary = await loadFreeDietPlans([planRow()], [mealRow()], { dryRun: true });

  assert.equal(summary.plansToCreate, 1);
  assert.equal(await FreeDietPlan.countDocuments({}), 0);
});

test('10c. a re-run does not un-archive a plan an admin deleted', async () => {
  await loadFreeDietPlans([planRow()], [mealRow()], { dryRun: false });
  await FreeDietPlan.updateOne({ 'legacy.planId': 5 }, { $set: { status: 'archived' } });

  await loadFreeDietPlans([planRow()], [mealRow()], { dryRun: false });

  assert.equal((await FreeDietPlan.findOne({ 'legacy.planId': 5 })).status, 'archived');
});

// =============================== API =======================================

const migrateFixture = () =>
  loadFreeDietPlans(
    [
      planRow({ plan_id: 5, diet_type: 'Veg.', range_from: '800', range_to: '840' }),
      planRow({ plan_id: 6, diet_type: 'Veg/Egg', range_from: '841', range_to: '850' }),
      planRow({ plan_id: 7, diet_type: 'Veg/NonVeg', range_from: '851', range_to: '900' }),
    ],
    [mealRow({ food_id: 1, plan_id: 5 }), mealRow({ food_id: 2, plan_id: 5, meal_id: 2 })],
    { dryRun: false },
  );

test('11. an admin can list plans', async () => {
  await migrateFixture();

  const response = await server.request('GET', '/api/admin/free-diet-plans', { token: adminToken });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.plans.length, 3);
  assert.equal(response.body.data.pagination.total, 3);

  const five = response.body.data.plans.find((plan) => plan.legacyPlanId === 5);
  assert.equal(five.dietType, 'Veg.');
  assert.deepEqual(five.range, { from: 800, to: 840 });
  assert.equal(five.mealCount, 2);
  assert.equal(five.foodCount, 2);
});

test('12. an admin can view one plan with its meals and foods', async () => {
  await migrateFixture();
  const list = await server.request('GET', '/api/admin/free-diet-plans', { token: adminToken });
  const id = list.body.data.plans.find((plan) => plan.legacyPlanId === 5).id;

  const response = await server.request('GET', `/api/admin/free-diet-plans/${id}`, {
    token: adminToken,
  });

  assert.equal(response.status, 200);
  const { plan } = response.body.data;
  assert.equal(plan.meals.length, 2);
  assert.equal(plan.meals[0].foods[0].foodName, 'Bread');
  assert.equal(plan.legacy.planId, 5);
  assert.equal(plan.totals.calories, 138, 'totals are derived, not stored');
});

test('13. an admin can create a plan', async () => {
  const response = await server.request('POST', '/api/admin/free-diet-plans', {
    token: adminToken,
    body: validPayload(),
  });

  assert.equal(response.status, 201);
  const { plan } = response.body.data;
  assert.equal(plan.dietType, 'Veg.');
  assert.equal(plan.meals[0].foods[0].foodName, 'Bread');
  // Backend-owned: no legacy id is invented for a new template.
  assert.equal(plan.legacy, null);
  assert.equal(plan.status, 'active');

  const stored = await FreeDietPlan.findById(plan.id);
  assert.ok(stored.createdBy, 'createdBy is the authenticated admin');
  assert.equal(String(stored.createdBy), String(stored.updatedBy));
});

test('13b. the legacy duplicate-band refusal is reproduced on create', async () => {
  await server.request('POST', '/api/admin/free-diet-plans', {
    token: adminToken,
    body: validPayload(),
  });
  const response = await server.request('POST', '/api/admin/free-diet-plans', {
    token: adminToken,
    body: validPayload(),
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'PLAN_ALREADY_EXISTS');
});

test('13c. a client cannot choose the id or fake the audit trail', async () => {
  for (const extra of [
    { _id: '507f1f77bcf86cd799439011' },
    { legacy: { source: 'gogetfit', planId: 999 } },
    { createdBy: '507f1f77bcf86cd799439011' },
    { createdAt: '2000-01-01T00:00:00.000Z' },
  ]) {
    const response = await server.request('POST', '/api/admin/free-diet-plans', {
      token: adminToken,
      body: { ...validPayload(), ...extra },
    });
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
});

test('14. an admin can edit a plan without losing its legacy metadata', async () => {
  await migrateFixture();
  const list = await server.request('GET', '/api/admin/free-diet-plans', { token: adminToken });
  const id = list.body.data.plans.find((plan) => plan.legacyPlanId === 5).id;

  const response = await server.request('PATCH', `/api/admin/free-diet-plans/${id}`, {
    token: adminToken,
    body: {
      dietType: 'Veg/Egg',
      range: { from: 900, to: 950 },
      meals: [{ mealId: 3, foods: [{ foodName: 'Dal', unit: 'grams', quantity: 35, calories: 121, fat: 0.3, carbs: 20.7, protein: 8.9 }] }],
    },
  });

  assert.equal(response.status, 200);
  const { plan } = response.body.data;
  assert.equal(plan.dietType, 'Veg/Egg');
  assert.deepEqual(plan.range, { from: 900, to: 950 });
  assert.deepEqual(
    plan.meals.map((meal) => meal.mealId),
    [3],
    'the meal set is replaced, as the legacy edit did',
  );
  // Migration identity survives the edit untouched.
  assert.equal(plan.legacy.planId, 5);
  assert.equal(plan.legacy.createdBy, '123');

  const stored = await FreeDietPlan.findById(id);
  assert.ok(stored.updatedBy, 'updatedBy records the editing admin');
});

test('14b. an empty patch is rejected', async () => {
  const created = await server.request('POST', '/api/admin/free-diet-plans', {
    token: adminToken,
    body: validPayload(),
  });
  const response = await server.request(
    'PATCH',
    `/api/admin/free-diet-plans/${created.body.data.plan.id}`,
    { token: adminToken, body: {} },
  );

  assert.equal(response.status, 400);
});

test('15. deleting a plan archives it and removes it from the list', async () => {
  const created = await server.request('POST', '/api/admin/free-diet-plans', {
    token: adminToken,
    body: validPayload(),
  });
  const { id } = created.body.data.plan;

  const response = await server.request('DELETE', `/api/admin/free-diet-plans/${id}`, {
    token: adminToken,
  });
  const list = await server.request('GET', '/api/admin/free-diet-plans', { token: adminToken });

  assert.equal(response.status, 200);
  assert.equal(list.body.data.plans.length, 0, 'archived plans are not listed');

  // Soft delete: the document and its history survive.
  const stored = await FreeDietPlan.findById(id);
  assert.equal(stored.status, 'archived');
  assert.ok(stored.deletedAt instanceof Date);
  assert.ok(stored.deletedBy);
});

test('15b. an archived plan can still be fetched and restored', async () => {
  const created = await server.request('POST', '/api/admin/free-diet-plans', {
    token: adminToken,
    body: validPayload(),
  });
  const { id } = created.body.data.plan;
  await server.request('DELETE', `/api/admin/free-diet-plans/${id}`, { token: adminToken });

  const restored = await server.request('PATCH', `/api/admin/free-diet-plans/${id}`, {
    token: adminToken,
    body: { status: 'active' },
  });

  assert.equal(restored.body.data.plan.status, 'active');
  const stored = await FreeDietPlan.findById(id);
  assert.equal(stored.deletedAt, null);
});

// ========================= AUTHORIZATION ===================================

test('16. a non-admin receives 403 on every plan route', async () => {
  const created = await server.request('POST', '/api/admin/free-diet-plans', {
    token: adminToken,
    body: validPayload(),
  });
  const { id } = created.body.data.plan;

  const cases = [
    ['user', '919000000061'],
    ['client', '919000000062'],
    ['coach', '919000000063'],
  ];

  for (const [role, phone] of cases) {
    const token = await tokenForRoles(role === 'user' ? ['user'] : ['user', role], phone);

    for (const [method, path, body] of [
      ['GET', '/api/admin/free-diet-plans', undefined],
      ['GET', `/api/admin/free-diet-plans/${id}`, undefined],
      ['POST', '/api/admin/free-diet-plans', validPayload({ range: { from: 2000, to: 2100 } })],
      ['PATCH', `/api/admin/free-diet-plans/${id}`, { dietType: 'Veg/Egg' }],
      ['DELETE', `/api/admin/free-diet-plans/${id}`, undefined],
    ]) {
      const response = await server.request(method, path, { token, body });
      assert.equal(response.status, 403, `${role} ${method} ${path}`);
      assert.equal(response.body.error.code, 'FORBIDDEN');
    }
  }
});

test('17. an unauthenticated caller receives 401', async () => {
  for (const [method, path] of [
    ['GET', '/api/admin/free-diet-plans'],
    ['GET', '/api/admin/free-diet-plans/507f1f77bcf86cd799439011'],
    ['POST', '/api/admin/free-diet-plans'],
    ['PATCH', '/api/admin/free-diet-plans/507f1f77bcf86cd799439011'],
    ['DELETE', '/api/admin/free-diet-plans/507f1f77bcf86cd799439011'],
  ]) {
    const response = await server.request(method, path, {});
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

// ========================== VALIDATION =====================================

test('18. an invalid payload returns 400', async () => {
  const cases = [
    {},
    { dietType: 'Veg.' },
    { dietType: 'Select', range: { from: 1200, to: 1300 } },
    { dietType: 'Vegan', range: { from: 1200, to: 1300 } },
    { dietType: 'Veg.', range: { from: 1300, to: 1200 } },
    { dietType: 'Veg.', range: { from: 0, to: 100 } },
    { dietType: 'Veg.', range: { from: 1200.5, to: 1300 } },
    validPayload({ meals: [{ mealId: 6, foods: [] }] }),
    validPayload({ meals: [{ mealId: 1, foods: [] }, { mealId: 1, foods: [] }] }),
    validPayload({ meals: [{ mealId: 1, foods: [{ foodName: '' }] }] }),
    validPayload({ meals: [{ mealId: 1, foods: [{ foodName: 'x'.repeat(46) }] }] }),
    validPayload({ meals: [{ mealId: 1, foods: [{ foodName: 'Bread', unit: 'bucket' }] }] }),
    validPayload({ meals: [{ mealId: 1, foods: [{ foodName: 'Bread', quantity: 0 }] }] }),
    validPayload({ meals: [{ mealId: 1, foods: [{ foodName: 'Bread', calories: -1 }] }] }),
    validPayload({ status: 'deleted' }),
  ];

  for (const body of cases) {
    const response = await server.request('POST', '/api/admin/free-diet-plans', {
      token: adminToken,
      body,
    });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  }
});

test('18b. a zero-calorie food row is accepted, as the migrated data contains them', async () => {
  const response = await server.request('POST', '/api/admin/free-diet-plans', {
    token: adminToken,
    body: validPayload({
      meals: [{ mealId: 1, foods: [{ foodName: 'Water', unit: 'ml', quantity: 250, calories: 0, fat: 0, carbs: 0, protein: 0 }] }],
    }),
  });

  assert.equal(response.status, 201);
});

test('18c. a migrated 12-row meal can be saved back unchanged', async () => {
  // The legacy UI capped a meal at 8 rows, but plan 459 holds 12: the edit form
  // must not be unable to re-save what the migration produced.
  const foods = Array.from({ length: 12 }, (_, i) => ({
    foodName: `Food ${i + 1}`,
    unit: 'grams',
    quantity: 10,
    calories: 10,
    fat: 1,
    carbs: 1,
    protein: 1,
  }));

  const response = await server.request('POST', '/api/admin/free-diet-plans', {
    token: adminToken,
    body: validPayload({ meals: [{ mealId: 2, foods }] }),
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.plan.meals[0].foods.length, 12);
});

test('19. an unknown or malformed plan id returns 404', async () => {
  for (const id of ['507f1f77bcf86cd799439011', 'not-an-object-id']) {
    const get = await server.request('GET', `/api/admin/free-diet-plans/${id}`, {
      token: adminToken,
    });
    const patch = await server.request('PATCH', `/api/admin/free-diet-plans/${id}`, {
      token: adminToken,
      body: { dietType: 'Veg.' },
    });
    const del = await server.request('DELETE', `/api/admin/free-diet-plans/${id}`, {
      token: adminToken,
    });

    assert.equal(get.status, 404, id);
    assert.equal(patch.status, 404, id);
    assert.equal(del.status, 404, id);
    assert.equal(get.body.error.code, 'PLAN_NOT_FOUND');
  }
});

// ===================== LIST BEHAVIOUR ======================================

test('20. the list paginates and caps the page size', async () => {
  const plans = Array.from({ length: 12 }, (_, i) =>
    planRow({ plan_id: 100 + i, range_from: String(1000 + i * 10), range_to: String(1009 + i * 10) }),
  );
  await loadFreeDietPlans(plans, [], { dryRun: false });

  const first = await server.request('GET', '/api/admin/free-diet-plans?page=1&pageSize=5', {
    token: adminToken,
  });
  const third = await server.request('GET', '/api/admin/free-diet-plans?page=3&pageSize=5', {
    token: adminToken,
  });
  const capped = await server.request('GET', '/api/admin/free-diet-plans?pageSize=5000', {
    token: adminToken,
  });

  assert.equal(first.body.data.plans.length, 5);
  assert.equal(first.body.data.pagination.totalPages, 3);
  assert.equal(third.body.data.plans.length, 2);
  assert.equal(capped.body.data.pagination.pageSize, 100, 'pageSize is clamped, never unbounded');
});

test('21. the list filters by diet type and searches by range or diet type', async () => {
  await migrateFixture();

  const byType = await server.request('GET', '/api/admin/free-diet-plans?dietType=Veg%2FEgg', {
    token: adminToken,
  });
  const byRange = await server.request('GET', '/api/admin/free-diet-plans?search=845', {
    token: adminToken,
  });
  const byText = await server.request('GET', '/api/admin/free-diet-plans?search=NonVeg', {
    token: adminToken,
  });

  assert.equal(byType.body.data.plans.length, 1);
  assert.equal(byType.body.data.plans[0].legacyPlanId, 6);
  assert.equal(byRange.body.data.plans.length, 1, '845 falls inside the 841-850 band');
  assert.equal(byRange.body.data.plans[0].legacyPlanId, 6);
  assert.equal(byText.body.data.plans[0].dietType, 'Veg/NonVeg');
});

test('22. the list sorts on an allow-listed key and rejects anything else', async () => {
  await migrateFixture();

  const asc = await server.request(
    'GET',
    '/api/admin/free-diet-plans?sortKey=rangeFrom&sortDir=asc',
    { token: adminToken },
  );
  const desc = await server.request(
    'GET',
    '/api/admin/free-diet-plans?sortKey=rangeFrom&sortDir=desc',
    { token: adminToken },
  );
  const rejected = await server.request('GET', '/api/admin/free-diet-plans?sortKey=meals.foods', {
    token: adminToken,
  });

  assert.deepEqual(
    asc.body.data.plans.map((plan) => plan.range.from),
    [800, 841, 851],
  );
  assert.deepEqual(
    desc.body.data.plans.map((plan) => plan.range.from),
    [851, 841, 800],
  );
  assert.equal(rejected.status, 400, 'an arbitrary sort field never reaches Mongo');
});

test('23. internal fields are not exposed', async () => {
  await migrateFixture();

  const list = await server.request('GET', '/api/admin/free-diet-plans', { token: adminToken });
  const row = list.body.data.plans[0];
  const detail = await server.request('GET', `/api/admin/free-diet-plans/${row.id}`, {
    token: adminToken,
  });

  for (const field of ['_id', '__v', 'deletedAt', 'deletedBy', 'createdBy', 'updatedBy']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, field), false, `list ${field}`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(detail.body.data.plan, field),
      false,
      `detail ${field}`,
    );
  }
  assert.equal(typeof row.id, 'string');
});
