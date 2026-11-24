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
import { submitDailyUpdate } from '../../src/services/daily-update.service.js';
import { getDietPlanForDay, getDietPlanHistoryForUser } from '../../src/services/diet-plan.service.js';
import { getRewards } from '../../src/services/rewards.service.js';
import { listMemberEnrollments } from '../../src/services/member-enrollment.service.js';
import { getWorkoutPlanForDay } from '../../src/services/workout-plan.service.js';
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
  assert.equal((await planAccessOf(member._id, ist('2026-11-18T23:59:30'))).access.planActive, true, 'unlocked at once');
});

test('a Start at 00:00 / 00:01 IST is that new day\'s Start: first official day the day after', async () => {
  for (const at of ['2026-11-19T00:00:00', '2026-11-19T00:01:00']) {
    await clearTestDb();
    await WorkoutPlan.deleteMany({});
    plan = await GogetfitPlan.create({ name: '12 WEEKS', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1, pricing: { basePrice: 1, reward: 0 } });
    member = await seedUser(['user', 'client'], 'Chethan');
    coachUser = await seedUser(['user', 'coach'], 'Prajwal');
    coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
    enrollment = await enroll();
    await ready();
    const res = await startPlanForCoach(coachUser._id, enrollment._id, { now: ist(at) });
    assert.deepEqual([res.planStartDate, res.planEndDate], ['2026-11-20', '2027-02-11'], at);
    assert.equal((await planAccessOf(member._id, ist(at))).access.planActive, true, at);
  }
});

test('scheduled -> active -> completed: Intake permissions and food-log authorization follow it', async () => {
  await ready();
  // Before the coach's Start: nothing unlocked.
  await assert.rejects(submitAt(ist('2026-11-18T14:59:00')), notActive);
  await startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK });

  // Scheduled (Start clicked, first official day tomorrow): unlocked at once -
  // the food log and Daily Update the same afternoon - while the official
  // dates stay tomorrow .. 10 Feb.
  let { access } = await planAccessOf(member._id, ist('2026-11-18T15:01:00'));
  assert.equal(access.status, 'scheduled');
  assert.equal(access.planActive, true);
  assert.deepEqual([access.canSetOwnCalorieGoal, access.canSubmitFoodLog], [false, true]);
  assert.equal(access.activeEnrollmentId, String(enrollment._id));
  assert.deepEqual([access.planStartDate, access.planEndDate], ['2026-11-19', '2027-02-10']);
  await submitAt(ist('2026-11-18T15:01:00'));
  const day0 = await FoodLog.findOne({ logDate: '2026-11-18' }).lean();
  assert.equal(String(day0.enrollmentId), String(enrollment._id));
  const du = await submitDailyUpdate(
    member._id,
    '2026-11-18',
    { weightKg: 80, workoutMinutes: 60, steps: 8000, calorieOut: { bmr: 1542, tef: 220, eat: 150, neat: 144 }, submissionId: null },
    { now: ist('2026-11-18T15:05:00') },
  );
  assert.equal(du.date, '2026-11-18');
  // Rewards are unchanged: they count the official days only.
  assert.equal(du.rewards.rewardAwarded, false);
  ({ access } = await planAccessOf(member._id, ist('2026-11-18T23:59:59.999')));
  assert.equal(access.canSubmitFoodLog, true, 'still unlocked at 23:59 the day before the first');
  const doc = await EnrolledClient.findById(enrollment._id).lean();
  assert.deepEqual([businessDayOf(doc.startDate), businessDayOf(doc.endDate)], ['2026-11-19', '2027-02-10'], 'dates not moved');

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
  // The member's Intake is unlocked the moment the Start succeeds.
  const day = await server.request('GET', '/api/users/me/food-log', { token: tokenFor(member) });
  assert.equal(day.body.data.planAccess.planActive, true);
  assert.equal(day.body.data.planAccess.canSetOwnCalorieGoal, false);
  assert.equal((await server.request('GET', '/api/users/me/food-log/history', { token: tokenFor(member) })).status, 200);
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

test('one plan at a time: B bought during A stays not started, never current, and its Start is refused until A expires', async () => {
  await ready();
  await startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK }); // A: 19 Nov .. 10 Feb
  const aBefore = await EnrolledClient.findById(enrollment._id).lean();
  const b = await enroll({ enrollDate: new Date('2027-01-15') });
  await ready(b._id); // B's own diet + workout plans, covering A's days too
  const jan20 = ist('2027-01-20T00:00:00');
  await assignWorkout(b._id, { selectedDates: [jan20], fromDate: jan20, toDate: jan20 });

  // Bought during A: A rules everywhere; B unlocks nothing and gets no dates.
  const during = ist('2027-01-20T10:00:00');
  let { access } = await planAccessOf(member._id, during);
  assert.equal(access.activeEnrollmentId, String(enrollment._id));
  assert.equal((await listMemberEnrollments(member._id, during)).current.id, String(enrollment._id));
  const dayView = await getDietPlanForDay(member._id, { today: '2027-01-20', now: during });
  const aDiet = await DietPlan.findOne({ enrollmentId: enrollment._id }).lean();
  assert.equal(dayView.dietPlan.id, String(aDiet._id), "A's diet plan, not B's newer one");
  const workout = await getWorkoutPlanForDay(member._id, { date: '2027-01-20', now: during });
  assert.equal(workout.workoutPlan, null, "B's workout plan never shows before B's Start");
  await submitAt(during);
  const log = await FoodLog.findOne({ logDate: '2027-01-20' }).lean();
  assert.equal(String(log.enrollmentId), String(enrollment._id));
  assert.equal(String(log.dietPlanId), String(aDiet._id), "Intake targets from A's diet plan");

  // Start B while A runs - and at 23:59:59 on A's last day: 409, nothing written.
  const refused = (e) =>
    e.statusCode === 409 &&
    e.code === 'ACTIVE_PLAN_EXISTS' &&
    e.message === "The client's current plan is still active. You can start this plan only after the current plan expires." &&
    e.details.currentPlanEndDate === '2027-02-10';
  const bBefore = await EnrolledClient.findById(b._id).lean();
  for (const at of ['2027-01-20T10:00:00', '2027-02-10T23:59:59.999']) {
    await assert.rejects(startPlanForCoach(coachUser._id, b._id, { now: ist(at) }), refused, at);
  }
  assert.deepEqual(await EnrolledClient.findById(b._id).lean(), bBefore, 'B unchanged (no startedAt, no dates)');
  assert.deepEqual(await EnrolledClient.findById(enrollment._id).lean(), aBefore, 'A unchanged');

  // A expires at 00:00 IST 11 Feb: no plan, nothing starts by itself, B's plans stay hidden.
  const gap = ist('2027-02-12T10:00:00');
  ({ access } = await planAccessOf(member._id, gap));
  assert.deepEqual([access.status, access.planActive, access.canSetOwnCalorieGoal], ['none', false, true]);
  assert.equal((await listMemberEnrollments(member._id, gap)).current, null);
  assert.equal((await getDietPlanForDay(member._id, { today: '2027-02-12', now: gap })).dietPlan, null);
  // History: A's plan with all 84 days it was shown; B's never-started plan is not there.
  const history = await getDietPlanHistoryForUser(member._id, { today: '2027-02-12' });
  assert.deepEqual(history.plans.map((p) => p.planId), [aDiet.planId]);
  assert.equal(history.plans[0].shownDays, 84);
  const coachHistory = await getDietPlanHistoryForUser(member._id, { today: '2027-02-12', includeCurrent: true });
  const bInCoach = coachHistory.plans.find((p) => p.planId !== aDiet.planId);
  assert.ok(bInCoach, 'the coach still lists the plan assigned for B');
  assert.equal(bInCoach.shownDays, 0, 'never shown to the member');
  assert.equal((await EnrolledClient.findById(b._id).lean()).hasStarted, false);
  await assert.rejects(submitAt(gap), notActive);

  // 00:00 IST 11 Feb, A just expired: B's Start succeeds - access at once, Day 1 the next day, full 12 weeks.
  const click = ist('2027-02-11T00:00:00');
  const res = await startPlanForCoach(coachUser._id, b._id, { now: click });
  assert.deepEqual([res.planStartDate, res.planEndDate], ['2027-02-12', '2027-05-06']);
  ({ access } = await planAccessOf(member._id, click));
  assert.deepEqual([access.planActive, access.activeEnrollmentId], [true, String(b._id)]);
  assert.equal((await listMemberEnrollments(member._id, click)).current.id, String(b._id));
  assert.deepEqual(await EnrolledClient.findById(enrollment._id).lean(), aBefore, "A's record untouched");
  assert.equal(await FoodLog.countDocuments({ enrollmentId: enrollment._id }), 1, "A's history stays A's");
});

test('B and C bought during A: both stay not started; either Start is refused during A; after it the coach picks one, the other waits', async () => {
  await ready();
  await startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK });
  const b = await enroll({ enrollDate: new Date('2027-01-10') });
  const c = await enroll({ enrollDate: new Date('2027-01-12') });
  await ready(b._id);
  await ready(c._id);
  const during = ist('2027-01-20T10:00:00');
  for (const e of [b, c]) {
    await assert.rejects(startPlanForCoach(coachUser._id, e._id, { now: during }), (err) => err.code === 'ACTIVE_PLAN_EXISTS');
  }
  assert.equal((await planAccessOf(member._id, during)).access.activeEnrollmentId, String(enrollment._id));

  const after = ist('2027-02-11T09:00:00');
  await startPlanForCoach(coachUser._id, c._id, { now: after }); // the coach's choice, not purchase order
  assert.equal((await EnrolledClient.findById(b._id).lean()).hasStarted, false, 'B still waits');
  await assert.rejects(startPlanForCoach(coachUser._id, b._id, { now: after }), (err) => err.code === 'ACTIVE_PLAN_EXISTS');
  assert.equal((await planAccessOf(member._id, after)).access.activeEnrollmentId, String(c._id));
});

test('concurrent Starts of two plans of one member: exactly one succeeds; other members are not blocked', async () => {
  const b = await enroll();
  await ready();
  await ready(b._id);
  const other = await seedUser(['user', 'client'], 'Other');
  const theirs = await EnrolledClient.create({ userId: other._id, planId: plan._id, coachId: coach._id, enrollDate: new Date('2026-11-01'), hasStarted: false });
  await assignDiet(theirs._id, { clientId: other._id });
  await assignWorkout(theirs._id, { clientId: other._id });

  const userBefore = await User.findById(member._id).lean();
  const results = await Promise.allSettled([
    startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK }),
    startPlanForCoach(coachUser._id, b._id, { now: CLICK }),
    startPlanForCoach(coachUser._id, theirs._id, { now: CLICK }),
  ]);
  const mine = results.slice(0, 2);
  assert.equal(mine.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.reason?.code ?? r.status)));
  assert.equal(mine.find((r) => r.status === 'rejected').reason.code, 'ACTIVE_PLAN_EXISTS');
  assert.equal(results[2].status, 'fulfilled', 'another member starts regardless');
  assert.equal(await EnrolledClient.countDocuments({ userId: member._id, hasStarted: true }), 1);
  const loser = await EnrolledClient.findOne({ userId: member._id, hasStarted: false }).lean();
  assert.equal(loser.startedAt ?? null, null);
  assert.deepEqual(await User.findById(member._id).lean(), userBefore, 'the member record is not touched by the lock');
});

test('a repeated Start of the same plan never resets its dates', async () => {
  await ready();
  const first = await startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK });
  await assert.rejects(startPlanForCoach(coachUser._id, enrollment._id, { now: ist('2026-12-05T10:00:00') }), (e) => e.code === 'PLAN_ALREADY_STARTED');
  const doc = await EnrolledClient.findById(enrollment._id).lean();
  assert.deepEqual([doc.startedAt.toISOString(), doc.startDate.toISOString()], [first.startedAt, first.startDate]);
});

test('over HTTP: Start during an active plan is 409 ACTIVE_PLAN_EXISTS with the coach-facing message', async () => {
  await ready();
  await EnrolledClient.updateOne(
    { _id: enrollment._id },
    { $set: { hasStarted: true, startDate: new Date('1999-12-31T18:30:00.000Z'), endDate: new Date('2099-12-30T18:30:00.000Z') } },
  );
  const b = await enroll();
  await ready(b._id);
  const res = await server.request('POST', `/api/coach/enrollments/${b._id}/start`, { token: tokenFor(coachUser) });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ACTIVE_PLAN_EXISTS');
  assert.equal(res.body.error.message, "The client's current plan is still active. You can start this plan only after the current plan expires.");
  assert.equal(res.body.error.details.currentPlanEndDate, '2099-12-31');
  assert.equal((await EnrolledClient.findById(b._id).lean()).hasStarted, false);
});

test('rewards before the first counted day read the current plan\'s length, not a plan bought during it', async () => {
  await ready();
  await startPlanForCoach(coachUser._id, enrollment._id, { now: CLICK }); // 12 weeks
  const short = await GogetfitPlan.create({ name: '4 WEEKS', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 4, personsAllowed: 1, pricing: { basePrice: 1, reward: 0 } });
  await enroll({ planId: short._id, enrollDate: new Date('2026-12-01') });
  assert.equal((await getRewards(member._id, ist('2026-12-05T10:00:00'))).planDays, 84);
});

test('Intake endpoints: history, another day\'s log and meal photos need a coach-started, unexpired plan; today is always readable', async () => {
  const token = tokenFor(member);
  const DAY = 86_400_000;
  const pastDay = businessDayOf(new Date(Date.now() - 3 * DAY));
  const statuses = async () => {
    const photo = await uploadFoodLogMealImage(member._id, 1, jpeg()).then(() => 200, (e) => e.statusCode);
    return {
      history: (await server.request('GET', '/api/users/me/food-log/history', { token })).status,
      pastDay: (await server.request('GET', `/api/users/me/food-log?date=${pastDay}`, { token })).status,
      today: (await server.request('GET', '/api/users/me/food-log', { token })).status,
      photo,
    };
  };
  const refused = { history: 403, pastDay: 403, today: 200, photo: 403 };

  // Purchased, the coach has not started it (beforeEach's enrollment).
  assert.deepEqual(await statuses(), refused, 'purchased, not started');

  // Expired.
  await EnrolledClient.updateOne(
    { _id: enrollment._id },
    { $set: { hasStarted: true, startDate: new Date(Date.now() - 90 * DAY), endDate: new Date(Date.now() - 5 * DAY) } },
  );
  assert.deepEqual(await statuses(), refused, 'expired');

  // The coach clicked Start just now (Day 1 tomorrow): open at once.
  await EnrolledClient.updateOne(
    { _id: enrollment._id },
    { $set: { startedAt: new Date(Date.now() - 60_000), startDate: new Date(Date.now() + DAY), endDate: new Date(Date.now() + 85 * DAY) } },
  );
  assert.deepEqual(await statuses(), { history: 200, pastDay: 200, today: 200, photo: 200 }, 'coach-started');
});
