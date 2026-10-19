import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Coach from '../../src/models/coach.model.js';
import DietPlan from '../../src/models/diet-plan.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import Food from '../../src/models/food.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { businessDayOf, startOfBusinessDay } from '../../src/utils/business-date.js';
import { normaliseDietPlanDates } from '../../src/validators/diet-plan.validator.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * POST /api/coach/enrollments/:enrollmentId/diet-plans - the coach's Copy Diet
 * Plan. Always a NEW document, for the coach's own enrollment, with the client
 * taken from that enrollment; dates in the most compact form (selectedDates only
 * when the picked days have a gap); migrated plans untouched.
 */
let server;
let prajwalUser;
let prajwal;
let siriUser;
let chethan;
let enrollment;
let siriEnrollment;
let rice;
let milk;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9187000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};

const body = (overrides = {}) => ({
  name: 'Fat Loss October Plan',
  gender: 'male',
  age: 32,
  height: 180,
  weight: 86,
  activityLevel: 'moderate',
  goal: 'Fat/Weight Loss',
  bmr: 1648,
  tdee: 1977.6,
  targets: { dailyCalorieTarget: 1988, fat: 67.9, carbs: 382.1, protein: 229.3 },
  meals: [
    { meal: 2, foods: [{ foodId: String(milk._id), qty: 250, portion: 250, servingUnit: 'ML', calories: 150, fat: 7.5, carbs: 12.5, protein: 7.5 }] },
    { meal: 1, foods: [{ foodId: String(rice._id), qty: 200, portion: 200, servingUnit: 'Grams', calories: 200, fat: 5, carbs: 20, protein: 10 }] },
    { meal: 3, foods: [] },
  ],
  fromDate: '2026-10-08',
  toDate: '2026-10-12',
  ...overrides,
});

const create = (payload = body(), { token = tokenFor(prajwalUser), enrollmentId = enrollment._id } = {}) =>
  server.request('POST', `/api/coach/enrollments/${enrollmentId}/diet-plans`, { token, body: payload });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  const gp = await GogetfitPlan.create({ name: '12 WEEKS GOGETFIT PLAN', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1, pricing: { basePrice: 4999, reward: 0 } });
  prajwalUser = await seedUser(['user', 'coach'], 'Prajwal');
  siriUser = await seedUser(['user', 'coach'], 'Siri');
  prajwal = await Coach.create({ userId: prajwalUser._id, profile: { level: 'LEVEL 1' } });
  const siri = await Coach.create({ userId: siriUser._id, profile: { level: 'LEVEL 1' } });
  chethan = await seedUser(['user', 'client'], 'Chethan Kumar');
  const bob = await seedUser(['user', 'client'], 'Bob');
  enrollment = await EnrolledClient.create({ userId: chethan._id, planId: gp._id, coachId: prajwal._id, enrollDate: new Date('2026-09-01'), hasStarted: true, isDeleted: false });
  siriEnrollment = await EnrolledClient.create({ userId: bob._id, planId: gp._id, coachId: siri._id, enrollDate: new Date('2026-09-01'), hasStarted: true, isDeleted: false });
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 100, fat: 2.5, carbs: 10, protein: 5 });
  milk = await Food.create({ name: 'Milk', foodType: 'Vegetarian', servingUnit: 'ML', servingQuantity: 100, calories: 60, fat: 3, carbs: 5, protein: 3 });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('creates a NEW plan for the coach\'s own enrollment: client, coach and enrollment from the server', async () => {
  const res = await create(body({ clientId: String(siriUser._id), coachId: 'nonsense' }));

  assert.equal(res.status, 201);
  const doc = await DietPlan.findById(res.body.data.dietPlan.id).lean();
  assert.equal(String(doc.clientId), String(chethan._id), 'from the enrollment, not the body');
  assert.equal(String(doc.coachId), String(prajwal._id), 'from the token');
  assert.equal(String(doc.enrollmentId), String(enrollment._id));
  assert.equal(doc.planId, String(doc._id), 'a new identity - never a name, a date or gogetfit:');
  assert.equal(String(doc.createdBy), String(prajwalUser._id));
  assert.equal(doc.status, 'active');
  assert.ok(doc.assignedAt instanceof Date);
  assert.ok(doc.createdAt && doc.updatedAt);
  assert.equal(doc.legacy, undefined);
});

test('the name, profile snapshot, goal/bmr/tdee and targets are stored at the root as sent', async () => {
  const res = await create();
  const doc = await DietPlan.findById(res.body.data.dietPlan.id).lean();

  assert.equal(doc.name, 'Fat Loss October Plan');
  assert.deepEqual(
    { gender: doc.gender, age: doc.age, height: doc.height, weight: doc.weight, activityLevel: doc.activityLevel },
    { gender: 'male', age: 32, height: 180, weight: 86, activityLevel: 'moderate' },
  );
  assert.deepEqual({ goal: doc.goal, bmr: doc.bmr, tdee: doc.tdee }, { goal: 'Fat/Weight Loss', bmr: 1648, tdee: 1977.6 });
  assert.deepEqual(doc.targets, { dailyCalorieTarget: 1988, fat: 67.9, carbs: 382.1, protein: 229.3 });
  assert.equal('calories' in doc.targets, false, 'new plans use dailyCalorieTarget');
  for (const key of ['dates', 'profile', 'planProfile']) assert.equal(key in doc, false, key);
});

test('meals and foods: actual quantity and its nutrition snapshot, meal order, empty meals dropped', async () => {
  const res = await create();
  const doc = await DietPlan.findById(res.body.data.dietPlan.id).lean();

  assert.deepEqual(doc.meals.map((m) => m.meal), [1, 2]);
  assert.deepEqual(doc.meals[1].foods[0], { foodId: milk._id, qty: 250, portion: 250, servingUnit: 'ML', calories: 150, fat: 7.5, carbs: 12.5, protein: 7.5 });
  // Every reader shows value / portion * qty: the snapshot of 250 ml reads as 150 kcal.
  assert.equal(res.body.data.dietPlan.meals[1].foods[0].nutrition.calories, 150);
  assert.equal(res.body.data.dietPlan.targets.calories, 1988, 'readers keep reporting targets.calories');
});

test('dates: a range or a continuous run is fromDate/toDate only', async () => {
  for (const extra of [{}, { selectedDates: ['2026-10-10', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-11', '2026-10-09'] }]) {
    const res = await create(body(extra));
    const doc = await DietPlan.findById(res.body.data.dietPlan.id).lean();
    assert.equal(businessDayOf(doc.fromDate), '2026-10-08');
    assert.equal(businessDayOf(doc.toDate), '2026-10-12');
    assert.equal('selectedDates' in doc, false);
  }
});

test('dates: picked days with a gap keep exactly those days, sorted and de-duplicated', async () => {
  const res = await create(body({ fromDate: '2026-10-08', toDate: '2026-10-13', selectedDates: ['2026-10-12', '2026-10-08', '2026-10-13', '2026-10-09', '2026-10-12'] }));
  const doc = await DietPlan.findById(res.body.data.dietPlan.id).lean();

  assert.deepEqual(doc.selectedDates.map((d) => businessDayOf(d)), ['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13']);
  assert.equal(businessDayOf(doc.fromDate), '2026-10-08');
  assert.equal(businessDayOf(doc.toDate), '2026-10-13');
  assert.deepEqual(res.body.data.dietPlan.selectedDates, ['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13']);
  assert.equal(res.body.data.dietPlan.days, 4);
});

test('a gapped plan is seen on its days only - never on the gap', async () => {
  await create(body({ fromDate: '2026-10-08', toDate: '2026-10-13', selectedDates: ['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13'] }));
  const onDay = (d) => DietPlan.findForDay(chethan._id, startOfBusinessDay(d)).lean();

  assert.ok(await onDay('2026-10-09'));
  assert.equal(await onDay('2026-10-10'), null);
  assert.equal(await onDay('2026-10-11'), null);
  assert.ok(await onDay('2026-10-12'));

  // And the coach's history shows two stretches, not one filled run.
  const history = await server.request('GET', `/api/coach/enrollments/${enrollment._id}/diet-plans`, { token: tokenFor(prajwalUser) });
  const [plan] = history.body.data.plans;
  assert.deepEqual(plan.coverage.map((c) => [c.fromDate, c.toDate]), [['2026-10-08', '2026-10-09'], ['2026-10-12', '2026-10-13']]);
});

test('a single day is a one-day plan, no selectedDates', async () => {
  const res = await create(body({ fromDate: '2026-10-08', toDate: '2026-10-08', selectedDates: ['2026-10-08'] }));
  const doc = await DietPlan.findById(res.body.data.dietPlan.id).lean();
  assert.equal(businessDayOf(doc.fromDate), businessDayOf(doc.toDate));
  assert.equal('selectedDates' in doc, false);
});

test('same name, same dates, same enrollment: a second, separate plan - nothing overwritten', async () => {
  const migrated = await DietPlan.create({ planId: 'gogetfit:166', clientId: chethan._id, name: 'Fat Loss October Plan', fromDate: startOfBusinessDay('2026-10-08'), toDate: startOfBusinessDay('2026-10-12'), assignedAt: new Date('2024-01-01'), targets: { calories: 1770, fat: 39, carbs: 221, protein: 133 }, legacy: { source: 'gogetfit', dietPlanId: 166, segment: { index: 0, of: 1 } } });
  const before = await DietPlan.findById(migrated._id).lean();

  const first = await create();
  const second = await create();

  assert.notEqual(first.body.data.dietPlan.id, second.body.data.dietPlan.id);
  assert.notEqual(first.body.data.dietPlan.planId, second.body.data.dietPlan.planId);
  assert.equal(await DietPlan.countDocuments(), 3);
  assert.deepEqual(await DietPlan.findById(migrated._id).lean(), before, 'the migrated plan is untouched');
});

test('another coach\'s enrollment is 403; unknown, malformed or deleted is 404; members and anonymous refused', async () => {
  assert.equal((await create(body(), { enrollmentId: siriEnrollment._id })).status, 403);
  assert.equal((await create(body(), { enrollmentId: '64b7f0000000000000000000' })).status, 404);
  assert.equal((await create(body(), { enrollmentId: 'nope' })).status, 404);
  await EnrolledClient.updateOne({ _id: enrollment._id }, { isDeleted: true });
  assert.equal((await create()).status, 404);
  assert.equal((await create(body(), { token: tokenFor(chethan), enrollmentId: siriEnrollment._id })).status, 403);
  assert.equal((await server.request('POST', `/api/coach/enrollments/${siriEnrollment._id}/diet-plans`, { body: body() })).status, 401);
  assert.equal(await DietPlan.countDocuments(), 0);
});

test('unknown or archived foods are refused, and nothing is written', async () => {
  const archived = await Food.create({ name: 'Old', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 1, fat: 0, carbs: 0, protein: 0, status: 'archived' });
  for (const foodId of ['64b7f0000000000000000000', String(archived._id), 'not-an-id']) {
    const res = await create(body({ meals: [{ meal: 1, foods: [{ foodId, qty: 1, portion: 1, servingUnit: 'Grams', calories: 1, fat: 0, carbs: 0, protein: 0 }] }] }));
    assert.equal(res.status, 400, foodId);
  }
  assert.equal(await DietPlan.countDocuments(), 0);
  assert.equal((await Food.findById(archived._id).lean()).status, 'archived', 'the food is not changed');
});

test('a missing name, no foods, missing or backwards dates are refused', async () => {
  const cases = [
    body({ name: '   ' }),
    body({ name: undefined }),
    body({ meals: [{ meal: 1, foods: [] }] }),
    body({ fromDate: undefined }),
    body({ toDate: '2026-13-01' }),
    body({ fromDate: '2026-10-12', toDate: '2026-10-08' }),
    body({ fromDate: '2026-10-08', toDate: '2026-10-13', selectedDates: ['2026-10-09', '2026-10-13'] }),
    body({ goal: 'Get huge' }),
    body({ targets: { fat: 1, carbs: 1, protein: 1 } }),
  ];
  for (const payload of cases) assert.equal((await create(payload)).status, 400, JSON.stringify(payload).slice(0, 80));
  assert.equal(await DietPlan.countDocuments(), 0);
});

test('date normalisation on its own', () => {
  assert.deepEqual(normaliseDietPlanDates({ fromDate: '2026-12-30', toDate: '2027-01-02', selectedDates: ['2027-01-02', '2026-12-31', '2026-12-30', '2027-01-01'] }), { fromDate: '2026-12-30', toDate: '2027-01-02' });
  assert.deepEqual(normaliseDietPlanDates({ fromDate: '2026-12-30', toDate: '2027-01-02', selectedDates: ['2027-01-02', '2026-12-30'] }), { fromDate: '2026-12-30', toDate: '2027-01-02', selectedDates: ['2026-12-30', '2027-01-02'] });
});
