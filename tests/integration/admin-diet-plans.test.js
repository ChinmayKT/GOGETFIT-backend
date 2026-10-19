import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import DietPlan from '../../src/models/diet-plan.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import Food from '../../src/models/food.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { listDietPlansForAdmin } from '../../src/services/diet-plan.service.js';
import { startOfBusinessDay } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let adminToken;
let memberToken;
let member;
let other;
let prajwal;
let siri;
let rice;
let egg;
let enrollment;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9184000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name: name ?? `User ${seq}` }, roles, status: 'active' });
};
const seedFood = (name, servingUnit, servingQuantity, image = null) =>
  Food.create({ name, foodType: 'Vegetarian', brand: name === 'Rice' ? 'Daawat' : null, servingUnit, servingQuantity, calories: 999, fat: 999, carbs: 999, protein: 999, image });

const day = (d) => startOfBusinessDay(d);
const plan = (overrides = {}) => ({
  planId: 'gogetfit:1',
  clientId: member._id,
  coachId: prajwal,
  name: 'Fat loss plan',
  fromDate: day('2024-06-01'),
  toDate: day('2024-06-03'),
  assignedAt: new Date('2024-05-30T10:00:00Z'),
  bmr: 1543.15,
  tdee: 1851.78,
  goal: 'Fat/Weight Loss',
  targets: { calories: 1601, fat: 36, carbs: 200, protein: 120 },
  meals: [
    { meal: 1, foods: [{ foodId: rice._id, qty: 200, portion: 100, servingUnit: 'Grams', calories: 113, fat: 3.5, carbs: 19, protein: 2 }] },
    {
      meal: 3,
      foods: [
        { foodId: egg._id, qty: 2, portion: 1, servingUnit: 'Piece', calories: 78, fat: 5.3, carbs: 0.6, protein: 6.3 },
        { foodId: rice._id, qty: 50, portion: 100, servingUnit: 'Grams', calories: 113, fat: 3.5, carbs: 19, protein: 2 },
      ],
    },
  ],
  ...overrides,
});

const list = (id, token = adminToken) => server.request('GET', `/api/admin/users/${id}/diet-plans`, { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  const gp = await GogetfitPlan.create({ name: '12 WEEKS GOGETFIT PLAN', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1, pricing: { basePrice: 4999, reward: 0 } });
  prajwal = (await Coach.create({ userId: (await seedUser(['user', 'coach'], 'Prajwal'))._id, profile: { level: 'LEVEL 1' } }))._id;
  siri = (await Coach.create({ userId: (await seedUser(['user', 'coach'], 'Siri'))._id, profile: { level: 'LEVEL 2' } }))._id;
  adminToken = tokenFor(await seedUser(['user', 'admin']));
  member = await seedUser(['user', 'client'], 'Jeevika');
  other = await seedUser(['user', 'client'], 'Someone Else');
  memberToken = tokenFor(member);
  rice = await seedFood('Rice', 'Grams', 100, { url: '/uploads/foods/rice.jpg', storageKey: 'foods/rice.jpg' });
  egg = await seedFood('Egg', 'Piece', 1);
  enrollment = await EnrolledClient.create({ userId: member._id, planId: gp._id, coachId: prajwal, enrollDate: new Date('2024-05-01'), startDate: day('2024-05-02'), endDate: day('2024-07-25'), hasStarted: true, isDeleted: false });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// ─── access ──────────────────────────────────────────────────────────────────

test('admin only: no token is 401, a member (even the plan owner) is 403', async () => {
  await DietPlan.create(plan());
  assert.equal((await server.request('GET', `/api/admin/users/${member._id}/diet-plans`, {})).status, 401);
  const res = await list(member._id, memberToken);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');
});

test('an unknown or malformed client id is a 404', async () => {
  assert.equal((await list(new mongoose.Types.ObjectId())).body.error.code, 'USER_NOT_FOUND');
  assert.equal((await list('not-an-id')).status, 404);
});

test('a client with no diet plan gets an empty list and schedule', async () => {
  const res = await list(member._id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.dietPlans, []);
  assert.deepEqual(res.body.data.schedule, []);
  assert.deepEqual(res.body.data.client, { id: String(member._id), name: 'Jeevika' });
});

test('client isolation: another client\'s plans are never returned', async () => {
  await DietPlan.create(plan());
  await DietPlan.create(plan({ planId: 'gogetfit:2', clientId: other._id, name: 'Not yours' }));

  const mine = (await list(member._id)).body.data.dietPlans;
  assert.deepEqual(mine.map((p) => p.name), ['Fat loss plan']);
  const theirs = (await list(other._id)).body.data.dietPlans;
  assert.deepEqual(theirs.map((p) => p.name), ['Not yours']);
});

// ─── content ─────────────────────────────────────────────────────────────────

test('one plan: header, snapshot, coach, enrollment, meals and foods in stored order', async () => {
  const doc = await DietPlan.create(plan({ enrollmentId: enrollment._id }));
  const [p] = (await list(member._id)).body.data.dietPlans;

  assert.equal(p.id, String(doc._id));
  assert.equal(p.planId, 'gogetfit:1');
  assert.equal(p.fromDate, '2024-06-01');
  assert.equal(p.toDate, '2024-06-03');
  assert.equal(p.days, 3);
  assert.equal(p.period, 'past');
  assert.equal(p.goal, 'Fat/Weight Loss');
  assert.equal(p.bmr, 1543.15);
  assert.equal(p.tdee, 1851.78);
  assert.deepEqual(p.targets, { calories: 1601, protein: 120, carbs: 200, fat: 36 });
  assert.deepEqual(p.coach, { id: String(prajwal), name: 'Prajwal', level: 'LEVEL 1' });
  assert.equal(p.enrollment.id, String(enrollment._id));
  assert.equal(p.enrollment.planName, '12 WEEKS GOGETFIT PLAN');
  assert.deepEqual(p.meals.map((m) => [m.meal, m.label]), [[1, 'Meal 1'], [3, 'Meal 3']]);
  assert.deepEqual(p.meals[1].foods.map((f) => f.food.name), ['Egg', 'Rice']);
});

test('a food shows Food identity but the plan\'s frozen numbers, scaled to qty', async () => {
  await DietPlan.create(plan());
  const [p] = (await list(member._id)).body.data.dietPlans;
  const [r] = p.meals[0].foods;

  assert.deepEqual(r.food, { id: String(rice._id), name: 'Rice', brand: 'Daawat', notes: null, foodType: 'Vegetarian', image: { url: '/uploads/foods/rice.jpg', storageKey: 'foods/rice.jpg' }, status: 'active' });
  assert.equal(r.qty, 200);
  assert.equal(r.portion, 100);
  assert.equal(r.servingUnit, 'Grams');
  // The Food master holds 999s; none of them leak into the plan.
  assert.deepEqual(r.perPortion, { calories: 113, protein: 2, carbs: 19, fat: 3.5 });
  assert.deepEqual(r.nutrition, { calories: 226, protein: 4, carbs: 38, fat: 7 });

  const egg2 = p.meals[1].foods[0];
  assert.equal(egg2.servingUnit, 'Piece');
  assert.deepEqual(egg2.nutrition, { calories: 156, protein: 12.6, carbs: 1.2, fat: 10.6 });
  // Meal 3: 2 eggs + 50 g rice. Totals add unrounded values and round once.
  assert.deepEqual(p.meals[1].totals, { calories: 212.5, protein: 13.6, carbs: 10.7, fat: 12.4 });
  assert.deepEqual(p.totals, { calories: 438.5, protein: 17.6, carbs: 48.7, fat: 19.4 });
});

test('a missing Food reference is reported, not fatal', async () => {
  const ghost = new mongoose.Types.ObjectId();
  await DietPlan.create(plan({ meals: [{ meal: 2, foods: [{ foodId: ghost, qty: 1, portion: 1, servingUnit: 'Bowl', calories: 50, fat: 1, carbs: 2, protein: 3 }] }] }));
  const res = await list(member._id);

  assert.equal(res.status, 200);
  const [f] = res.body.data.dietPlans[0].meals[0].foods;
  assert.equal(f.foodId, String(ghost));
  assert.equal(f.food, null);
  assert.equal(f.missingFood, true);
  assert.deepEqual(f.nutrition, { calories: 50, protein: 3, carbs: 2, fat: 1 });
  assert.deepEqual(res.body.data.missingFoodIds, [String(ghost)]);
});

test('a plan with no meals, and a null coach or enrollment, are returned as they are', async () => {
  await DietPlan.create(plan({ meals: [], coachId: null, enrollmentId: null, legacy: { source: 'gogetfit', dietPlanId: 9, createdBy: 332, segment: { index: 0, of: 1 } } }));
  const [p] = (await list(member._id)).body.data.dietPlans;
  assert.deepEqual(p.meals, []);
  assert.equal(p.coach, null);
  assert.equal(p.legacyCreatedBy, 332);
  assert.equal(p.enrollment, null);
  assert.equal(p.missingEnrollmentId, null);
  assert.deepEqual(p.totals, { calories: 0, protein: 0, carbs: 0, fat: 0 });
});

// ─── dates, runs, precedence ─────────────────────────────────────────────────

test('date runs stay separate documents and gaps are never filled', async () => {
  await DietPlan.create(plan({ fromDate: day('2024-06-01'), toDate: day('2024-06-02') }));
  await DietPlan.create(plan({ fromDate: day('2024-06-05'), toDate: day('2024-06-05') }));
  const { dietPlans, schedule } = (await list(member._id)).body.data;

  assert.equal(dietPlans.length, 2);
  assert.deepEqual(dietPlans.map((p) => [p.fromDate, p.toDate]), [['2024-06-01', '2024-06-02'], ['2024-06-05', '2024-06-05']]);
  assert.deepEqual(schedule.map((s) => [s.from, s.to]), [['2024-06-01', '2024-06-02'], ['2024-06-05', '2024-06-05']]);
});

test('the schedule follows newest-assignment-wins, exactly like DietPlan.findForDay', async () => {
  const older = await DietPlan.create(plan({ planId: 'gogetfit:10', name: 'Karthik era', coachId: siri, fromDate: day('2024-06-01'), toDate: day('2024-06-10'), assignedAt: new Date('2024-05-01') }));
  const newer = await DietPlan.create(plan({ planId: 'gogetfit:11', name: 'Prajwal plan', fromDate: day('2024-06-04'), toDate: day('2024-06-06'), assignedAt: new Date('2024-06-03') }));
  const { dietPlans, schedule } = (await list(member._id)).body.data;

  // Newest assignment first; both coaches are listed with their own plan.
  assert.deepEqual(dietPlans.map((p) => [p.name, p.coach.name]), [['Prajwal plan', 'Prajwal'], ['Karthik era', 'Siri']]);
  assert.deepEqual(schedule, [
    { from: '2024-06-01', to: '2024-06-03', dietPlanId: String(older._id) },
    { from: '2024-06-04', to: '2024-06-06', dietPlanId: String(newer._id) },
    { from: '2024-06-07', to: '2024-06-10', dietPlanId: String(older._id) },
  ]);
  for (let d = 1; d <= 11; d += 1) {
    const key = `2024-06-${String(d).padStart(2, '0')}`;
    const expected = (await DietPlan.findForDay(member._id, day(key)).lean())?._id;
    const fromSchedule = schedule.find((s) => s.from <= key && key <= s.to)?.dietPlanId;
    assert.equal(fromSchedule ?? null, expected ? String(expected) : null, key);
  }
});

test('period is derived from the dates against today', async () => {
  await DietPlan.create(plan({ planId: 'p', fromDate: day('2024-06-01'), toDate: day('2024-06-03') }));
  await DietPlan.create(plan({ planId: 'c', fromDate: day('2024-06-05'), toDate: day('2024-06-09'), assignedAt: new Date('2024-06-01') }));
  await DietPlan.create(plan({ planId: 'u', fromDate: day('2024-06-20'), toDate: day('2024-06-21'), assignedAt: new Date('2024-06-02') }));
  const res = await listDietPlansForAdmin(String(member._id), { today: '2024-06-07' });
  assert.deepEqual(res.dietPlans.map((p) => [p.planId, p.period]).sort(), [['c', 'current'], ['p', 'past'], ['u', 'upcoming']]);
});

test('archived plans are listed but never scheduled', async () => {
  await DietPlan.create(plan({ status: 'archived' }));
  const { dietPlans, schedule } = (await list(member._id)).body.data;
  assert.equal(dietPlans[0].status, 'archived');
  assert.deepEqual(schedule, []);
});

test('reading never changes a diet plan', async () => {
  const doc = await DietPlan.create(plan({ enrollmentId: enrollment._id }));
  const before = await DietPlan.findById(doc._id).lean();
  await list(member._id);
  assert.deepEqual(await DietPlan.findById(doc._id).lean(), before);
});
