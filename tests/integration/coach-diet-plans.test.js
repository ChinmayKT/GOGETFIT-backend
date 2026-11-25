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
import { getDietPlanHistoryForCoach } from '../../src/services/diet-plan.service.js';
import { addCalendarDays, businessDayOf, startOfBusinessDay } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let prajwalUser;
let siriUser;
let chethan;
let bob;
let enrollment;
let siriEnrollment;
let rice;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9188000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};
const day = (d) => startOfBusinessDay(d);
const today = () => businessDayOf(new Date());

const plan = (overrides = {}) => ({
  planId: 'gogetfit:166',
  clientId: chethan._id,
  name: 'Chethan34 meal plan',
  fromDate: day('2024-05-31'),
  toDate: day('2024-06-01'),
  assignedAt: new Date('2024-05-30T10:00:00Z'),
  goal: 'Fat/Weight Loss',
  bmr: 1683.91,
  tdee: 2020.69,
  targets: { calories: 1770, fat: 39, carbs: 221, protein: 133 },
  meals: [{ meal: 1, foods: [{ foodId: rice._id, qty: 200, portion: 100, servingUnit: 'Grams', calories: 113, fat: 3.5, carbs: 19, protein: 2 }] }],
  ...overrides,
});

const list = (enrollmentId, token) => server.request('GET', `/api/coach/enrollments/${enrollmentId}/diet-plans`, { token });
const onDay = (enrollmentId, date, token) => server.request('GET', `/api/coach/enrollments/${enrollmentId}/diet-plan?date=${date}`, { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  const gp = await GogetfitPlan.create({ name: '12 WEEKS GOGETFIT PLAN', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1, pricing: { basePrice: 4999, reward: 0 } });
  prajwalUser = await seedUser(['user', 'coach'], 'Prajwal');
  siriUser = await seedUser(['user', 'coach'], 'Siri');
  const prajwal = await Coach.create({ userId: prajwalUser._id, profile: { level: 'LEVEL 1' } });
  const siri = await Coach.create({ userId: siriUser._id, profile: { level: 'LEVEL 1' } });
  chethan = await seedUser(['user', 'client'], 'Chethan Kumar');
  bob = await seedUser(['user', 'client'], 'Bob');
  enrollment = await EnrolledClient.create({ userId: chethan._id, planId: gp._id, coachId: prajwal._id, enrollDate: new Date('2024-05-01'), hasStarted: true, isDeleted: false });
  siriEnrollment = await EnrolledClient.create({ userId: bob._id, planId: gp._id, coachId: siri._id, enrollDate: new Date('2024-05-01'), hasStarted: true, isDeleted: false });
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 1, fat: 1, carbs: 1, protein: 1, image: { url: '/uploads/foods/rice.jpg', storageKey: 'k' } });
  // Plan 166 in three back-to-back runs; plan 92 with a real gap, its second run
  // hidden by the newer plan 95.
  await DietPlan.create(plan({ coachId: prajwal._id }));
  await DietPlan.create(plan({ coachId: prajwal._id, fromDate: day('2024-06-02'), toDate: day('2024-08-25') }));
  await DietPlan.create(plan({ coachId: prajwal._id, fromDate: day('2024-08-26'), toDate: day('2024-09-14') }));
  await DietPlan.create(plan({ coachId: prajwal._id, planId: 'gogetfit:92', name: 'chiiii test', fromDate: day('2023-10-23'), toDate: day('2023-10-25'), assignedAt: new Date('2023-10-20') }));
  await DietPlan.create(plan({ coachId: prajwal._id, planId: 'gogetfit:92', name: 'chiiii test', fromDate: day('2023-10-30'), toDate: day('2023-11-01'), assignedAt: new Date('2023-10-20') }));
  await DietPlan.create(plan({ coachId: prajwal._id, planId: 'gogetfit:95', name: 'Chethu diet plan', fromDate: day('2023-10-30'), toDate: day('2024-01-21'), assignedAt: new Date('2023-10-29') }));
  await DietPlan.create(plan({ clientId: bob._id, planId: 'gogetfit:9', name: 'Bob plan', coachId: siri._id }));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('unauthenticated is 401; a member without the coach role is 403', async () => {
  assert.equal((await list(enrollment._id)).status, 401);
  const res = await list(enrollment._id, tokenFor(chethan));
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');
  assert.equal((await onDay(enrollment._id, '2024-06-01', tokenFor(chethan))).status, 403);
});

test('a coach cannot reach another coach\'s client - by enrollment id or anything else', async () => {
  const token = tokenFor(prajwalUser);
  for (const res of [await list(siriEnrollment._id, token), await onDay(siriEnrollment._id, '2024-06-01', token)]) {
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
  }
  // A client id in place of an enrollment id is not an enrollment.
  assert.equal((await list(chethan._id, token)).status, 404);
  assert.equal((await list('not-an-id', token)).status, 404);
  // A query parameter cannot point the read elsewhere.
  const res = await server.request('GET', `/api/coach/enrollments/${enrollment._id}/diet-plans?userId=${bob._id}`, { token });
  assert.equal(res.body.data.client.name, 'Chethan Kumar');
});

test('a deleted enrollment no longer grants access', async () => {
  await EnrolledClient.updateOne({ _id: enrollment._id }, { $set: { isDeleted: true } });
  assert.equal((await list(enrollment._id, tokenFor(prajwalUser))).status, 404);
});

test('the coach sees exactly the client\'s History items for finished plans', async () => {
  const coachView = (await list(enrollment._id, tokenFor(prajwalUser))).body.data;
  const memberView = (await server.request('GET', '/api/users/me/diet-plans/history', { token: tokenFor(chethan) })).body.data;

  assert.deepEqual(coachView.plans.map((p) => p.planId), ['gogetfit:166', 'gogetfit:95', 'gogetfit:92']);
  assert.deepEqual(coachView.plans, memberView.plans);
  assert.equal(coachView.plans.some((p) => p.name === 'Bob plan'), false);
});

test('runs group into one plan, a real gap stays a gap, and newest-wins decides shown days', async () => {
  const { plans } = (await list(enrollment._id, tokenFor(prajwalUser))).body.data;
  const p166 = plans.find((p) => p.planId === 'gogetfit:166');
  assert.equal(p166.ranges.length, 3);
  assert.deepEqual(p166.coverage, [{ fromDate: '2024-05-31', toDate: '2024-09-14', days: 107 }]);
  assert.equal(p166.period, 'past');

  const p92 = plans.find((p) => p.planId === 'gogetfit:92');
  assert.deepEqual(p92.coverage, [
    { fromDate: '2023-10-23', toDate: '2023-10-25', days: 3 },
    { fromDate: '2023-10-30', toDate: '2023-11-01', days: 3 },
  ]);
  assert.deepEqual(p92.shown, [{ fromDate: '2023-10-23', toDate: '2023-10-25', days: 3 }]);
  assert.equal(p92.openDate, '2023-10-25');
  assert.equal(p92.coach.name, 'Prajwal');
});

test('current and upcoming plans are included for the coach (and not in the member History)', async () => {
  const t = today();
  await DietPlan.create(plan({ planId: 'gogetfit:now', name: 'Current plan', fromDate: day(addCalendarDays(t, -3)), toDate: day(addCalendarDays(t, 3)), assignedAt: new Date() }));
  await DietPlan.create(plan({ planId: 'gogetfit:next', name: 'Next plan', fromDate: day(addCalendarDays(t, 10)), toDate: day(addCalendarDays(t, 12)), assignedAt: new Date() }));

  const { plans } = (await list(enrollment._id, tokenFor(prajwalUser))).body.data;
  assert.deepEqual(plans.slice(0, 2).map((p) => [p.name, p.period]), [['Next plan', 'upcoming'], ['Current plan', 'current']]);
  assert.equal(plans.find((p) => p.name === 'Current plan').openDate, t);

  const member = (await server.request('GET', '/api/users/me/diet-plans/history', { token: tokenFor(chethan) })).body.data;
  assert.equal(member.plans.some((p) => ['Current plan', 'Next plan'].includes(p.name)), false);
});

test('a day resolves to the same plan the client sees, with the full content', async () => {
  const token = tokenFor(prajwalUser);
  for (const [date, planId] of [['2024-09-14', 'gogetfit:166'], ['2024-01-21', 'gogetfit:95'], ['2023-10-25', 'gogetfit:92'], ['2023-10-31', 'gogetfit:95'], ['2023-10-27', null]]) {
    const coach = (await onDay(enrollment._id, date, token)).body.data;
    const member = (await server.request('GET', `/api/users/me/diet-plan?date=${date}`, { token: tokenFor(chethan) })).body.data;
    assert.equal(coach.dietPlan?.planId ?? null, planId, date);
    // The same plan - except the coach's Set Calorie Intake, which the member
    // sees only during an active plan (this cycle has no started days).
    const restricted = ['coachGivenTargets', 'coachTargetsSetAt', 'effectiveTargets', 'targetsSource'];
    const planPart = (view) => (view ? Object.fromEntries(Object.entries(view).filter(([k]) => !restricted.includes(k))) : view);
    assert.deepEqual(planPart(coach.dietPlan), planPart(member.dietPlan), date);
    if (member.dietPlan) for (const k of restricted) assert.equal(member.dietPlan[k], null, `${date} ${k}`);
  }
  const p = (await onDay(enrollment._id, '2024-09-14', token)).body.data.dietPlan;
  assert.equal(p.meals[0].foods[0].food.image.url, '/uploads/foods/rice.jpg');
  assert.deepEqual(p.meals[0].foods[0].nutrition, { calories: 226, protein: 4, carbs: 38, fat: 7 });
  assert.equal((await onDay(enrollment._id, 'bad', token)).status, 400);
});

test('the list reads no foods, and nothing is written', async () => {
  const before = await DietPlan.find({}).sort({ _id: 1 }).lean();
  const collections = [];
  mongoose.set('debug', (collection) => collections.push(collection));
  try {
    await getDietPlanHistoryForCoach(prajwalUser._id, String(enrollment._id));
  } finally {
    mongoose.set('debug', false);
  }
  assert.equal(collections.includes('foods'), false, collections.join(','));
  assert.deepEqual(await DietPlan.find({}).sort({ _id: 1 }).lean(), before);
});

test('each plan carries what its meals actually add up to, not only the suggested targets', async () => {
  // Suggested 1770 kcal; the added food is 113 kcal per 100 g x 200 g = 226.
  const { plans } = (await list(enrollment._id, tokenFor(prajwalUser))).body.data;
  const p166 = plans.find((p) => p.planId === 'gogetfit:166');
  assert.deepEqual(p166.targets, { calories: 1770, protein: 133, carbs: 221, fat: 39 });
  assert.deepEqual(p166.totals, { calories: 226, protein: 4, carbs: 38, fat: 7 });
  // The same numbers the plan view itself shows.
  const view = (await onDay(enrollment._id, '2024-06-01', tokenFor(prajwalUser))).body.data.dietPlan;
  assert.deepEqual(p166.totals, view.totals);
});

test('a replaced plan (never shown on any day) opens by id, read only, for its coach only', async () => {
  // Plan 77: every day of it is covered by the newer plan 95.
  const replaced = await DietPlan.create(
    plan({ coachId: (await Coach.findOne({ userId: prajwalUser._id }))._id, planId: 'gogetfit:77', name: 'Old plan', fromDate: day('2023-11-05'), toDate: day('2023-11-06'), assignedAt: new Date('2023-10-01') }),
  );
  const token = tokenFor(prajwalUser);
  const item = (await list(enrollment._id, token)).body.data.plans.find((p) => p.planId === 'gogetfit:77');
  assert.equal(item.openDate, null, 'replaced: no day to open on');
  assert.equal(item.dietPlanId, String(replaced._id));

  const before = await DietPlan.findById(replaced._id).lean();
  const res = await server.request('GET', `/api/coach/enrollments/${enrollment._id}/diet-plans/${item.dietPlanId}`, { token });
  assert.equal(res.status, 200);
  const view = res.body.data.dietPlan;
  assert.equal(view.name, 'Old plan');
  assert.equal(view.meals.length, 1);
  assert.equal(view.meals[0].foods[0].qty, 200);
  assert.deepEqual(view.totals, item.totals);
  // Opening it changes nothing: same document, still replaced.
  assert.deepEqual(await DietPlan.findById(replaced._id).lean(), before);
  const again = (await list(enrollment._id, token)).body.data.plans.find((p) => p.planId === 'gogetfit:77');
  assert.equal(again.openDate, null);

  // Another coach, another client's plan, or a bad id: not found.
  const other = await server.request('GET', `/api/coach/enrollments/${siriEnrollment._id}/diet-plans/${item.dietPlanId}`, { token: tokenFor(siriUser) });
  assert.equal(other.status, 404);
  const bobPlan = await DietPlan.findOne({ clientId: bob._id }).lean();
  assert.equal((await server.request('GET', `/api/coach/enrollments/${enrollment._id}/diet-plans/${bobPlan._id}`, { token })).status, 404);
  assert.equal((await server.request('GET', `/api/coach/enrollments/${enrollment._id}/diet-plans/nope`, { token })).status, 404);
  assert.equal((await server.request('GET', `/api/coach/enrollments/${enrollment._id}/diet-plans/${item.dietPlanId}`, { token: tokenFor(chethan) })).status, 403);
});
