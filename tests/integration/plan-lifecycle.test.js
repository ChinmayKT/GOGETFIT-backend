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
import WorkoutPlan from '../../src/models/workout-plan.model.js';
import { getFoodLogForDay, submitFoodLog, uploadFoodLogMealImage } from '../../src/services/food-log.service.js';
import { planAccessOf, startPlanForCoach } from '../../src/services/plan-lifecycle.service.js';
import { businessDayOf } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * The coaching-plan lifecycle end to end: coach Start (POST
 * /api/coach/enrollments/:id/start) and the Intake permissions and food-log
 * authorization that follow from it. Asia/Kolkata calendar days, end day
 * inclusive, no grace after the last day.
 */
let server;
let plan;
let member;
let coachUser;
let coach;
let otherCoachUser;
let enrollment;
let rice;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9188300${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};
const ist = (iso) => new Date(`${iso}+05:30`);
const CLICK = ist('2026-11-18T15:00:00'); // the coach clicks Start
const enroll = (extra = {}) =>
  EnrolledClient.create({ userId: member._id, planId: plan._id, coachId: coach._id, enrollDate: new Date('2026-11-01'), hasStarted: false, ...extra });
const assignDiet = (enrollmentId = enrollment._id, extra = {}) =>
  DietPlan.create({
    planId: `app:${(seq += 1)}`,
    clientId: member._id,
    enrollmentId,
    coachId: coach._id,
    name: 'Cut',
    fromDate: ist('2026-11-19T00:00:00'),
    toDate: ist('2027-02-10T00:00:00'),
    assignedAt: CLICK,
    targets: { calories: 1800, fat: 50, carbs: 200, protein: 120 },
    meals: [],
    ...extra,
  });
const assignWorkout = (enrollmentId = enrollment._id, extra = {}) =>
  WorkoutPlan.create({ planId: `wp:${(seq += 1)}`, clientId: member._id, coachId: coach._id, enrollmentId, name: 'Strength', assignedAt: CLICK, ...extra });
const ready = async (enrollmentId = enrollment._id) => {
  await assignDiet(enrollmentId);
  await assignWorkout(enrollmentId);
};
const meals = [{ meal: 1, foods: [{ entryId: 'e1', foodId: '', qty: 100 }] }];
const submitAt = (now, extra = {}) =>
  submitFoodLog(member._id, { meals: [{ ...meals[0], foods: [{ ...meals[0].foods[0], foodId: String(rice._id) }] }], memberGoal: null, day: null, submissionId: null, ...extra }, { now });
const notActive = (e) =>
  e.statusCode === 403 &&
  e.code === 'INTAKE_PLAN_NOT_ACTIVE' &&
  e.message === 'Food intake submission is available only during an active coaching plan.';
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  await WorkoutPlan.deleteMany({});
  plan = await GogetfitPlan.create({ name: '12 WEEKS', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1, pricing: { basePrice: 1, reward: 0 } });
  member = await seedUser(['user', 'client'], 'Chethan');
  coachUser = await seedUser(['user', 'coach'], 'Prajwal');
  coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  otherCoachUser = await seedUser(['user', 'coach'], 'Siri');
  await Coach.create({ userId: otherCoachUser._id, profile: { level: 'LEVEL 1' } });
  enrollment = await enroll();
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 113, fat: 3.5, carbs: 19, protein: 2 });
});

after(async () => {
  await WorkoutPlan.deleteMany({});
  await server.close();
  await disconnectTestDb();
});

test('a purchased plan the coach has not started is not active: own goal allowed, no food log', async () => {
  const { access } = await planAccessOf(member._id, CLICK);
  assert.equal(access.status, 'none');
  assert.equal(access.canSetOwnCalorieGoal, true);
  assert.equal(access.canSubmitFoodLog, false);
  assert.equal(access.planActive, false);
  await assert.rejects(submitAt(CLICK), notActive);
  assert.equal(await FoodLog.countDocuments(), 0);
});

test('a new user with no plan: own goal allowed, no food log, no photo', async () => {
  const fresh = await seedUser(['user'], 'New');
  const { access } = await planAccessOf(fresh._id, CLICK);
  assert.deepEqual([access.canSetOwnCalorieGoal, access.canSubmitFoodLog], [true, false]);
  await assert.rejects(uploadFoodLogMealImage(fresh._id, 1, jpeg(), { now: CLICK }), notActive);
});

test('Start saves the dates: tomorrow in IST, 12 weeks = 84 days, last day inclusive', async () => {
  await ready();
  const res = await startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK });
  assert.equal(res.planStartDate, '2026-11-19');
  assert.equal(res.planEndDate, '2027-02-10');
  assert.equal(res.lifecycle, 'scheduled');
  assert.equal(res.durationWeeks, 12);
  const doc = await EnrolledClient.findById(enrollment._id).lean();
  assert.equal(doc.hasStarted, true);
  assert.equal(doc.startedAt.toISOString(), CLICK.toISOString());
  assert.equal(businessDayOf(doc.startDate), '2026-11-19');
  assert.equal(businessDayOf(doc.endDate), '2027-02-10');
  assert.equal((doc.endDate - doc.startDate) / 86_400_000 + 1, 84);
  assert.equal(String(doc.updatedBy), String(coachUser._id));
});

test('a Start just before midnight IST still begins the next IST day, not the next UTC day', async () => {
  await ready();
  const res = await startPlanForCoach(coachUser._id, enrollment._id, { now: ist('2026-11-18T23:59:00') });
  assert.equal(res.planStartDate, '2026-11-19');
});

test('scheduled -> active -> completed: Intake permissions and food-log authorization follow it', async () => {
  await ready();
  await startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK });

  // Scheduled (started, first day tomorrow): neither own goal nor food log.
  let { access } = await planAccessOf(member._id, ist('2026-11-18T23:59:59.999'));
  assert.equal(access.status, 'scheduled');
  assert.deepEqual([access.canSetOwnCalorieGoal, access.canSubmitFoodLog], [false, false]);
  assert.equal(access.planStartDate, '2026-11-19');
  await assert.rejects(submitAt(ist('2026-11-18T23:59:59.999')), notActive);

  // Active from the first day: the log is the authorizing enrollment's.
  ({ access } = await planAccessOf(member._id, ist('2026-11-19T00:00:00')));
  assert.equal(access.status, 'active');
  assert.equal(access.activeEnrollmentId, String(enrollment._id));
  assert.equal(access.activePlanId, String(plan._id));
  assert.deepEqual([access.canSetOwnCalorieGoal, access.canSubmitFoodLog], [false, true]);
  const first = await submitAt(ist('2026-11-19T09:00:00'));
  assert.equal(first.planAccess.canSubmitFoodLog, true);
  const log = await FoodLog.findOne({ logDate: '2026-11-19' }).lean();
  assert.equal(String(log.enrollmentId), String(enrollment._id));
  assert.equal(String(log.coachId), String(coach._id));
  assert.equal(String(log.clientId), String(member._id));

  // Still active through the last second of the last day.
  await submitAt(ist('2027-02-10T23:59:59.999'));
  assert.equal(await FoodLog.countDocuments({ logDate: '2027-02-10' }), 1);

  // 11 Feb 00:00 IST: completed. No grace - not even for the last day's log.
  const expired = ist('2027-02-11T00:00:00');
  ({ access } = await planAccessOf(member._id, expired));
  assert.equal(access.status, 'none');
  assert.deepEqual([access.canSetOwnCalorieGoal, access.canSubmitFoodLog], [true, false]);
  await assert.rejects(submitAt(expired, { day: '2027-02-10', submissionId: 'pending' }), notActive);
  await assert.rejects(submitAt(expired), notActive);
  await assert.rejects(uploadFoodLogMealImage(member._id, 1, jpeg(), { now: expired }), notActive);
  assert.equal(await FoodLog.countDocuments({ logDate: '2027-02-11' }), 0);
  const day = await getFoodLogForDay(member._id, { now: expired });
  assert.equal(day.planAccess.canSetOwnCalorieGoal, true);
});

test('the daily limit of three still holds during an active plan; a retry is not counted twice', async () => {
  await ready();
  await startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK });
  const at = ist('2026-12-01T10:00:00');
  await submitAt(at, { submissionId: 'a' });
  const retry = await submitAt(at, { submissionId: 'a' });
  assert.equal(retry.submissions.remaining, 2);
  await submitAt(at, { submissionId: 'b' });
  await submitAt(at, { submissionId: 'c' });
  await assert.rejects(submitAt(at, { submissionId: 'd' }), (e) => e.code === 'INTAKE_DAILY_LIMIT_REACHED');
});

test('Start needs both an active diet plan and an active workout plan for THIS enrollment', async () => {
  const notReady = (missing) => (e) => e.statusCode === 409 && e.code === 'PLAN_NOT_READY' && e.message.includes(missing);
  await assert.rejects(startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK }), notReady('diet plan and workout plan'));
  // Archived plans, and plans of another enrollment, are not this one's.
  const elsewhere = await enroll();
  await assignDiet(elsewhere._id);
  await assignWorkout(enrollment._id, { status: 'archived' });
  await assert.rejects(startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK }), notReady('diet plan and workout plan'));
  await assignDiet();
  await assert.rejects(startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK }), notReady('workout plan'));
  await assignWorkout();
  assert.equal((await startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK })).planStartDate, '2026-11-19');
  assert.equal((await EnrolledClient.findById(elsewhere._id).lean()).hasStarted, false, 'nothing else started');
});

test('Start is refused when already started, and for a plan without a duration', async () => {
  await ready();
  await startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK });
  await assert.rejects(startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK }), (e) => e.code === 'PLAN_ALREADY_STARTED');

  const noWeeks = await GogetfitPlan.create({ name: 'X', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 0, personsAllowed: 1, pricing: { basePrice: 1, reward: 0 } });
  const other = await enroll({ planId: noWeeks._id });
  await ready(other._id);
  await assert.rejects(startPlanForCoach(coachUser._id, other._id, { now: CLICK }), (e) => e.code === 'PLAN_DURATION_MISSING');
});

test('over HTTP: only the enrollment\'s own coach can start it', async () => {
  await ready();
  const path = `/api/coach/enrollments/${enrollment._id}/start`;
  assert.equal((await server.request('POST', path, { token: tokenFor(otherCoachUser) })).status, 404);
  assert.equal((await server.request('POST', path, { token: tokenFor(member) })).status, 403);
  assert.equal((await server.request('POST', path)).status, 401);
  assert.equal((await EnrolledClient.findById(enrollment._id).lean()).hasStarted, false);

  const res = await server.request('POST', path, { token: tokenFor(coachUser) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.lifecycle, 'scheduled');
  assert.equal(res.body.data.durationWeeks, 12);
});

test('over HTTP: a direct food-log PUT outside an active plan is 403, and GET reports why', async () => {
  const res = await server.request('PUT', '/api/users/me/food-log', {
    token: tokenFor(member),
    body: { meals: [{ meal: 1, foods: [{ entryId: 'e1', foodId: String(rice._id), qty: 100 }] }] },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'INTAKE_PLAN_NOT_ACTIVE');
  assert.equal(res.body.error.message, 'Food intake submission is available only during an active coaching plan.');
  const day = await server.request('GET', '/api/users/me/food-log', { token: tokenFor(member) });
  assert.equal(day.status, 200);
  assert.equal(day.body.data.planAccess.canSubmitFoodLog, false);
  assert.equal(day.body.data.planAccess.canSetOwnCalorieGoal, true);
  assert.equal(await FoodLog.countDocuments(), 0);
  // Food Intake History is an active-plan feature too.
  const past = await server.request('GET', '/api/users/me/food-log/history', { token: tokenFor(member) });
  assert.equal(past.status, 403);
  assert.equal(past.body.error.code, 'INTAKE_PLAN_NOT_ACTIVE');
});

test('over HTTP: during an active plan the member submits and reads History; the coach still reads it after expiry', async () => {
  await EnrolledClient.updateOne(
    { _id: enrollment._id },
    { $set: { hasStarted: true, startDate: new Date('1999-12-31T18:30:00.000Z'), endDate: new Date('2099-12-30T18:30:00.000Z') } },
  );
  const token = tokenFor(member);
  const put = await server.request('PUT', '/api/users/me/food-log', {
    token,
    body: { meals: [{ meal: 1, foods: [{ entryId: 'e1', foodId: String(rice._id), qty: 100 }] }] },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.data.planAccess.planActive, true);
  assert.equal((await server.request('GET', '/api/users/me/food-log/history', { token })).status, 200);

  // Expired: the member's History is closed, the records are untouched and
  // the coach's read of them is not affected.
  await EnrolledClient.updateOne({ _id: enrollment._id }, { $set: { endDate: new Date('2000-01-01T18:30:00.000Z') } });
  assert.equal((await server.request('GET', '/api/users/me/food-log/history', { token })).status, 403);
  assert.equal(await FoodLog.countDocuments(), 1);
  const coachRead = await server.request('GET', `/api/coach/enrollments/${enrollment._id}/food-log/history`, { token: tokenFor(coachUser) });
  assert.equal(coachRead.status, 200);
});

test('consecutive plans: an unstarted next plan never overrides the active one, and is started by hand after it', async () => {
  await ready();
  await startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK });
  const next = await enroll({ enrollDate: new Date('2027-01-15') });
  await ready(next._id);

  // Bought during the active plan: the active one still rules.
  let { access } = await planAccessOf(member._id, ist('2027-01-20T10:00:00'));
  assert.equal(access.activeEnrollmentId, String(enrollment._id));
  assert.deepEqual([access.canSetOwnCalorieGoal, access.canSubmitFoodLog], [false, true]);

  // Starting it while the first still runs past tomorrow would overlap.
  await assert.rejects(startPlanForCoach(coachUser._id, next._id, { now: ist('2027-01-20T10:00:00') }), (e) => e.code === 'PLAN_OVERLAP');

  // After the first ends nothing starts by itself: own goal again, no food log.
  ({ access } = await planAccessOf(member._id, ist('2027-02-12T10:00:00')));
  assert.deepEqual([access.status, access.canSetOwnCalorieGoal, access.canSubmitFoodLog], ['none', true, false]);
  assert.equal((await EnrolledClient.findById(next._id).lean()).hasStarted, false);

  // On the first plan's last day the next one may be started for the day after.
  const res = await startPlanForCoach(coachUser._id, next._id, { now: ist('2027-02-10T12:00:00') });
  assert.deepEqual([res.planStartDate, res.planEndDate], ['2027-02-11', '2027-05-05']);
  ({ access } = await planAccessOf(member._id, ist('2027-02-11T08:00:00')));
  assert.equal(access.activeEnrollmentId, String(next._id));
  await submitAt(ist('2027-02-11T08:00:00'));
  const log = await FoodLog.findOne({ logDate: '2027-02-11' }).lean();
  assert.equal(String(log.enrollmentId), String(next._id));
});
