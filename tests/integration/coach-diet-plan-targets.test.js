import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Coach from '../../src/models/coach.model.js';
import DietPlan from '../../src/models/diet-plan.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import Food from '../../src/models/food.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { addCalendarDays, businessDayOf, startOfBusinessDay } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Set Calorie Intake - PUT /api/coach/enrollments/:enrollmentId/diet-plans/
 * :dietPlanId/coach-targets. The coach's daily targets live beside the plan's
 * own (`targets`, read as `dietPlanTargets`), which they never rewrite; every
 * reader is told the effective targets: the coach's when complete, else the
 * plan's.
 */
let server;
let prajwalUser;
let siriUser;
let prajwal;
let chethan;
let bob;
let enrollment;
let oldEnrollment;
let siriEnrollment;
let rice;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9177000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};
const today = () => businessDayOf(new Date());
const day = (d) => startOfBusinessDay(d);

const ORIGINAL = { calories: 1450, fat: 32, carbs: 181, protein: 109 };
const COACH = { calories: 1600, protein: 120, carbs: 180, fat: 45 };

const plan = (overrides = {}) =>
  DietPlan.create({
    planId: `app:${(seq += 1)}`,
    clientId: chethan._id,
    enrollmentId: enrollment._id,
    coachId: prajwal._id,
    name: 'Chethan cut',
    fromDate: day(addCalendarDays(today(), -3)),
    toDate: day(addCalendarDays(today(), 10)),
    assignedAt: new Date('2025-01-01T10:00:00Z'),
    targets: ORIGINAL,
    meals: [{ meal: 1, foods: [{ foodId: rice._id, qty: 200, portion: 100, servingUnit: 'Grams', calories: 113, fat: 3.5, carbs: 19, protein: 2 }] }],
    ...overrides,
  });

const put = (enrollmentId, dietPlanId, body, token = tokenFor(prajwalUser)) =>
  server.request('PUT', `/api/coach/enrollments/${enrollmentId}/diet-plans/${dietPlanId}/coach-targets`, { token, body });
const memberDay = (user = chethan) => server.request('GET', '/api/users/me/diet-plan', { token: tokenFor(user) });
const coachDay = () => server.request('GET', `/api/coach/enrollments/${enrollment._id}/diet-plan?date=${today()}`, { token: tokenFor(prajwalUser) });

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
  bob = await seedUser(['user', 'client'], 'Bob');
  enrollment = await EnrolledClient.create({ userId: chethan._id, planId: gp._id, coachId: prajwal._id, enrollDate: new Date('2025-01-01'), hasStarted: true, isDeleted: false });
  // An earlier cycle of the same client with another coach.
  oldEnrollment = await EnrolledClient.create({ userId: chethan._id, planId: gp._id, coachId: siri._id, enrollDate: new Date('2024-01-01'), hasStarted: true, isDeleted: false });
  siriEnrollment = await EnrolledClient.create({ userId: bob._id, planId: gp._id, coachId: siri._id, enrollDate: new Date('2025-01-01'), hasStarted: true, isDeleted: false });
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 113, fat: 3.5, carbs: 19, protein: 2 });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('a coach sets the intake on their client\'s plan: stored beside, never over, the plan\'s targets', async () => {
  const doc = await plan();
  const before = await DietPlan.findById(doc._id).lean();
  const count = await DietPlan.countDocuments();

  const res = await put(enrollment._id, doc._id, COACH);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.targets.coachGivenTargets, COACH);
  assert.deepEqual(res.body.data.targets.dietPlanTargets, ORIGINAL);
  assert.deepEqual(res.body.data.targets.effectiveTargets, COACH);
  assert.equal(res.body.data.targets.targetsSource, 'coach');

  const after = await DietPlan.findById(doc._id).lean();
  assert.deepEqual(
    { calories: after.coachGivenTargets.calories, protein: after.coachGivenTargets.protein, carbs: after.coachGivenTargets.carbs, fat: after.coachGivenTargets.fat },
    COACH,
  );
  assert.equal(String(after.coachGivenTargets.setBy), String(prajwalUser._id));
  assert.equal(String(after.updatedBy), String(prajwalUser._id));
  // Only coachGivenTargets / updatedBy / updatedAt changed.
  const strip = ({ coachGivenTargets: _c, updatedBy: _u, updatedAt: _t, ...rest }) => rest;
  assert.deepEqual(strip(after), strip(before));
  assert.equal(await DietPlan.countDocuments(), count, 'no plan created');
});

test('saving again replaces the coach\'s values; still one document', async () => {
  const doc = await plan();
  await put(enrollment._id, doc._id, COACH);
  const res = await put(enrollment._id, doc._id, { calories: 1700.5, protein: 130, carbs: 175.25, fat: 50 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.targets.coachGivenTargets, { calories: 1700.5, protein: 130, carbs: 175.25, fat: 50 });
  assert.equal(await DietPlan.countDocuments({ clientId: chethan._id }), 1);
});

test('member and coach reads: the coach\'s targets win; without them the plan\'s', async () => {
  const doc = await plan();

  let member = (await memberDay()).body.data.dietPlan;
  assert.deepEqual(member.dietPlanTargets, ORIGINAL);
  assert.equal(member.coachGivenTargets, null);
  assert.deepEqual(member.effectiveTargets, ORIGINAL);
  assert.equal(member.targetsSource, 'plan');
  assert.deepEqual(member.targets, ORIGINAL, 'existing readers keep the plan\'s own');

  await put(enrollment._id, doc._id, COACH);

  member = (await memberDay()).body.data.dietPlan;
  assert.deepEqual(member.effectiveTargets, COACH);
  assert.equal(member.targetsSource, 'coach');
  assert.deepEqual(member.dietPlanTargets, ORIGINAL);
  assert.deepEqual(member.targets, ORIGINAL);
  const coach = (await coachDay()).body.data.dietPlan;
  assert.deepEqual(coach.coachGivenTargets, COACH);
  assert.equal(coach.id, String(doc._id));
});

test('legacy plans: dailyCalorieTarget is the plan\'s calories; a partial coach set is ignored, never mixed', async () => {
  const doc = await plan({ targets: { dailyCalorieTarget: 2100, fat: 60, carbs: 250, protein: 140 } });
  // A partial set written outside the API (the schema would refuse it).
  await DietPlan.collection.updateOne({ _id: doc._id }, { $set: { coachGivenTargets: { calories: 1800 } } });

  const member = (await memberDay()).body.data.dietPlan;
  assert.deepEqual(member.dietPlanTargets, { calories: 2100, fat: 60, carbs: 250, protein: 140 });
  assert.equal(member.coachGivenTargets, null);
  assert.deepEqual(member.effectiveTargets, { calories: 2100, fat: 60, carbs: 250, protein: 140 });
  assert.equal(member.targetsSource, 'plan');
});

test('a plan with no enrollment (migrated) is set through its client', async () => {
  const doc = await plan({ enrollmentId: null, coachId: null });
  const res = await put(enrollment._id, doc._id, COACH);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.targets.targetsSource, 'coach');
});

test('several plans on a day: the one the client sees is the one read, and only it changes', async () => {
  const older = await plan({ name: 'older', assignedAt: new Date('2024-12-01') });
  const newer = await plan({ name: 'newer', assignedAt: new Date('2025-02-01') });

  const shown = (await coachDay()).body.data.dietPlan;
  assert.equal(shown.id, String(newer._id), 'newest assignment wins, as before');
  await put(enrollment._id, shown.id, COACH);

  assert.equal((await DietPlan.findById(older._id).lean()).coachGivenTargets, null);
  assert.deepEqual((await memberDay()).body.data.dietPlan.effectiveTargets, COACH);
});

test('no plan for the day: the read says so (nothing to set against)', async () => {
  await plan({ fromDate: day(addCalendarDays(today(), 5)), toDate: day(addCalendarDays(today(), 9)) });
  assert.equal((await coachDay()).body.data.dietPlan, null);
  assert.equal((await memberDay()).body.data.dietPlan, null);
});

test('authorization comes from the token and enrollment, never the request', async () => {
  const mine = await plan();
  const bobs = await plan({ clientId: bob._id, enrollmentId: siriEnrollment._id, coachId: null });
  const otherCycle = await plan({ enrollmentId: oldEnrollment._id });

  // No token / not a coach.
  assert.equal((await server.request('PUT', `/api/coach/enrollments/${enrollment._id}/diet-plans/${mine._id}/coach-targets`, { body: COACH })).status, 401);
  assert.equal((await put(enrollment._id, mine._id, COACH, tokenFor(chethan))).status, 403);
  // Another coach's enrollment.
  const viaSiri = await put(siriEnrollment._id, bobs._id, COACH);
  assert.equal(viaSiri.status, 404);
  assert.equal(viaSiri.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
  // Another client's plan through my own enrollment.
  const bobsViaMine = await put(enrollment._id, bobs._id, COACH);
  assert.equal(bobsViaMine.status, 404);
  assert.equal(bobsViaMine.body.error.code, 'DIET_PLAN_NOT_FOUND');
  // My client's plan from another coach's cycle.
  const cycle = await put(enrollment._id, otherCycle._id, COACH);
  assert.equal(cycle.status, 403);
  // A coachId in the body changes nothing.
  assert.equal((await put(siriEnrollment._id, bobs._id, { ...COACH, coachId: String(prajwal._id) })).status, 404);

  for (const id of [bobs._id, otherCycle._id]) {
    assert.equal((await DietPlan.findById(id).lean()).coachGivenTargets, null, 'nothing written');
  }
});

test('bad ids, missing or archived plans are 404', async () => {
  const archived = await plan({ status: 'archived' });
  for (const [enr, id, code] of [
    [enrollment._id, 'nope', 'DIET_PLAN_NOT_FOUND'],
    [enrollment._id, '64b7f0f0f0f0f0f0f0f0f0f0', 'DIET_PLAN_NOT_FOUND'],
    [enrollment._id, archived._id, 'DIET_PLAN_NOT_FOUND'],
    ['nope', archived._id, 'ENROLLED_CLIENT_NOT_FOUND'],
  ]) {
    const res = await put(enr, id, COACH);
    assert.equal(res.status, 404, `${enr} ${id}`);
    assert.equal(res.body.error.code, code);
  }
});

test('invalid or incomplete values are a 400 and write nothing', async () => {
  const doc = await plan();
  for (const body of [
    {},
    { calories: 1600, protein: 120, carbs: 180 },
    { ...COACH, calories: '1600' },
    { ...COACH, calories: 0 },
    { ...COACH, protein: -1 },
    { ...COACH, fat: null },
    { ...COACH, carbs: 'NaN' },
  ]) {
    const res = await put(enrollment._id, doc._id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal((await DietPlan.findById(doc._id).lean()).coachGivenTargets, null);
});
