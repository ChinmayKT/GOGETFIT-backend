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
import { getDietPlanForDay } from '../../src/services/diet-plan.service.js';
import { listMemberEnrollments } from '../../src/services/member-enrollment.service.js';
import { getWorkoutPlanForDay } from '../../src/services/workout-plan.service.js';
import { submitFoodLog, uploadFoodLogMealImage } from '../../src/services/food-log.service.js';
import { getClientEnrollmentsForCoachUser } from '../../src/services/coach-dashboard.service.js';
import { planAccessOf, startPlanForCoach, stopPlanForCoach } from '../../src/services/plan-lifecycle.service.js';
import { businessDayOf } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Coach Stop Plan (POST /api/coach/enrollments/:id/stop): a permanent end of
 * the client's running enrollment. Access ends at once, the enrollment never
 * runs again, its record (dates, payment) stays, and no other plan starts.
 */
let server;
let plan;
let member;
let coachUser;
let coach;
let otherCoachUser;
let planA;
let rice;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9188400${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};
const ist = (iso) => new Date(`${iso}+05:30`);
const CLICK = ist('2026-11-18T15:00:00'); // Start of Plan A
const STOP = ist('2026-11-25T11:00:00'); // Plan A is in its official days
const LATER = ist('2026-11-25T11:05:00');
const enroll = (extra = {}) =>
  EnrolledClient.create({
    userId: member._id,
    planId: plan._id,
    coachId: coach._id,
    enrollDate: new Date('2026-11-01'),
    hasStarted: false,
    payment: { transactionId: `pay_${(seq += 1)}`, amount: 4999, currency: 'INR', status: 'Success', paidAt: new Date('2026-11-01') },
    ...extra,
  });
const ready = async (enrollmentId) => {
  await DietPlan.create({
    planId: `app:${(seq += 1)}`,
    clientId: member._id,
    enrollmentId,
    coachId: coach._id,
    name: 'Cut',
    fromDate: ist('2026-11-19T00:00:00'),
    toDate: ist('2027-06-10T00:00:00'),
    assignedAt: CLICK,
    targets: { calories: 1800, fat: 50, carbs: 200, protein: 120 },
    meals: [],
  });
  await WorkoutPlan.create({
    planId: `wp:${(seq += 1)}`,
    clientId: member._id,
    coachId: coach._id,
    enrollmentId,
    name: 'Strength',
    assignedAt: CLICK,
    fromDate: ist('2026-11-24T00:00:00'),
    toDate: ist('2026-11-25T00:00:00'),
    selectedDates: [ist('2026-11-24T00:00:00'), ist('2026-11-25T00:00:00')],
  });
};
const startA = async () => {
  await ready(planA._id);
  return startPlanForCoach(coachUser._id, planA._id, { now: CLICK });
};
const code = (c) => (e) => e.code === c;
const submitAt = (now) =>
  submitFoodLog(member._id, { meals: [{ meal: 1, foods: [{ entryId: 'e1', foodId: String(rice._id), qty: 100 }] }], memberGoal: null, day: null, submissionId: null }, { now });
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
  planA = await enroll();
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 113, fat: 3.5, carbs: 19, protein: 2 });
});

after(async () => {
  await WorkoutPlan.deleteMany({});
  await server.close();
  await disconnectTestDb();
});

test('Stop records the stop and keeps the original dates, purchase and payment', async () => {
  await startA();
  const before = await EnrolledClient.findById(planA._id).lean();
  const res = await stopPlanForCoach(coachUser._id, planA._id, { now: STOP });
  assert.equal(res.lifecycle, 'stopped');
  assert.equal(res.status, 'stopped');
  assert.equal(res.stoppedAt, STOP.toISOString());
  assert.equal(res.planEndDate, '2027-02-10', 'the scheduled last day, not the stop day');

  const after = await EnrolledClient.findById(planA._id).lean();
  assert.equal(after.stoppedAt.toISOString(), STOP.toISOString());
  assert.equal(String(after.stoppedBy), String(coachUser._id));
  for (const key of ['enrollDate', 'startDate', 'endDate', 'startedAt', 'planId', 'coachId', 'payment', 'hasStarted', 'userId']) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(businessDayOf(after.endDate), '2027-02-10');
});

test('Stop revokes access at once: food log, photo, diet and workout of the day; earlier days stay readable', async () => {
  await startA();
  await submitAt(ist('2026-11-24T10:00:00'));
  assert.equal((await planAccessOf(member._id, STOP)).access.planActive, true);
  assert.ok((await getWorkoutPlanForDay(member._id, { now: STOP })).workoutPlan);

  await stopPlanForCoach(coachUser._id, planA._id, { now: STOP });
  const { enrollment, access } = await planAccessOf(member._id, LATER);
  assert.equal(enrollment, null);
  assert.deepEqual([access.planActive, access.canSubmitFoodLog, access.status, access.activeEnrollmentId], [false, false, 'none', null]);
  await assert.rejects(submitAt(LATER), code('INTAKE_PLAN_NOT_ACTIVE'));
  await assert.rejects(uploadFoodLogMealImage(member._id, 1, jpeg(), { now: LATER }), code('INTAKE_PLAN_NOT_ACTIVE'));
  assert.equal((await getWorkoutPlanForDay(member._id, { now: LATER })).workoutPlan, null);
  assert.equal((await getDietPlanForDay(member._id, { today: businessDayOf(LATER), now: LATER })).dietPlan, null);
  // Nothing is deleted: the day before the stop still shows its plan, and the log is kept.
  assert.ok((await getWorkoutPlanForDay(member._id, { date: '2026-11-24', now: LATER })).workoutPlan);
  assert.equal(await FoodLog.countDocuments({ clientId: member._id }), 1);
  assert.equal(await DietPlan.countDocuments({ enrollmentId: planA._id }), 1);
});

test('over HTTP: the existing session is refused right after the stop; public reads still work', async () => {
  await ready(planA._id);
  // Plan A running today (real clock), started by the coach.
  await EnrolledClient.updateOne(
    { _id: planA._id },
    { $set: { hasStarted: true, startedAt: new Date(Date.now() - 86_400_000), startDate: new Date('1999-12-31T18:30:00.000Z'), endDate: new Date('2099-12-30T18:30:00.000Z') } },
  );
  const token = tokenFor(member);
  assert.equal((await server.request('GET', '/api/users/me/food-log/history', { token })).status, 200);

  const stop = await server.request('POST', `/api/coach/enrollments/${planA._id}/stop`, { token: tokenFor(coachUser) });
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  assert.equal(stop.body.data.status, 'stopped');

  const put = await server.request('PUT', '/api/users/me/food-log', {
    token,
    body: { meals: [{ meal: 1, foods: [{ entryId: 'e1', foodId: String(rice._id), qty: 100 }] }] },
  });
  assert.equal(put.status, 403);
  assert.equal(put.body.error.code, 'INTAKE_PLAN_NOT_ACTIVE');
  assert.equal((await server.request('GET', '/api/users/me/food-log/history', { token })).status, 403);
  const today = await server.request('GET', '/api/users/me/food-log', { token });
  assert.equal(today.status, 200, 'today stays readable: it says why');
  assert.equal(today.body.data.planAccess.planActive, false);
  assert.equal((await server.request('GET', '/api/users/me/workout-plan', { token })).body.data.workoutPlan, null);
  assert.equal((await server.request('GET', '/api/coaches', { token })).status, 200, 'public browsing is untouched');

  const mine = await server.request('GET', '/api/users/me/enrollments', { token });
  assert.equal(mine.body.data.current, null);
  assert.equal(mine.body.data.enrollments[0].status, 'stopped');
});

test('over HTTP: only the enrollment\'s own coach can stop it; members and anonymous callers cannot', async () => {
  await startA();
  const path = `/api/coach/enrollments/${planA._id}/stop`;
  assert.equal((await server.request('POST', path, { token: tokenFor(otherCoachUser) })).status, 404);
  assert.equal((await server.request('POST', path, { token: tokenFor(member) })).status, 403);
  assert.equal((await server.request('POST', path)).status, 401);
  assert.equal((await EnrolledClient.findById(planA._id).lean()).stoppedAt, null);
});

test('only the running plan can be stopped: not an unstarted, an expired, or a stopped one', async () => {
  await assert.rejects(stopPlanForCoach(coachUser._id, planA._id, { now: STOP }), code('PLAN_NOT_ACTIVE'));
  await startA();
  await assert.rejects(stopPlanForCoach(coachUser._id, planA._id, { now: ist('2027-02-11T00:00:00') }), code('PLAN_NOT_ACTIVE'), 'expired');
  // An admin row dated ahead without a coach Start is not running yet.
  const ahead = await enroll({ hasStarted: true, startDate: ist('2027-03-01T00:00:00'), endDate: ist('2027-05-23T00:00:00') });
  await assert.rejects(stopPlanForCoach(coachUser._id, ahead._id, { now: STOP }), code('PLAN_NOT_ACTIVE'));

  await stopPlanForCoach(coachUser._id, planA._id, { now: STOP });
  await assert.rejects(stopPlanForCoach(coachUser._id, planA._id, { now: LATER }), code('PLAN_STOPPED'));
  assert.equal((await EnrolledClient.findById(planA._id).lean()).stoppedAt.toISOString(), STOP.toISOString(), 'first stop kept');
});

test('a plan can be stopped the day the coach started it (access already unlocked, Day 1 tomorrow)', async () => {
  await startA();
  const res = await stopPlanForCoach(coachUser._id, planA._id, { now: ist('2026-11-18T16:00:00') });
  assert.equal(res.lifecycle, 'stopped');
  assert.equal((await planAccessOf(member._id, ist('2026-11-19T09:00:00'))).access.planActive, false, 'Day 1 never unlocks it');
});

test('a stopped plan can never be started, resumed or reactivated', async () => {
  await startA();
  await stopPlanForCoach(coachUser._id, planA._id, { now: STOP });
  await assert.rejects(startPlanForCoach(coachUser._id, planA._id, { now: LATER }), code('PLAN_STOPPED'));
  const res = await server.request('POST', `/api/coach/enrollments/${planA._id}/start`, { token: tokenFor(coachUser) });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'PLAN_STOPPED');
  // No resume/reactivate route exists.
  for (const verb of ['resume', 'reactivate', 'unstop', 'restart']) {
    assert.equal((await server.request('POST', `/api/coach/enrollments/${planA._id}/${verb}`, { token: tokenFor(coachUser) })).status, 404, verb);
  }
  // Still stopped later on, inside its original dates.
  assert.equal((await planAccessOf(member._id, ist('2027-01-01T12:00:00'))).access.planActive, false);
});

test('duplicate concurrent Stops: exactly one succeeds, one stop recorded', async () => {
  await startA();
  const results = await Promise.allSettled([
    stopPlanForCoach(coachUser._id, planA._id, { now: STOP }),
    stopPlanForCoach(coachUser._id, planA._id, { now: LATER }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.reason?.code ?? r.status)));
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'PLAN_STOPPED');
  const doc = await EnrolledClient.findById(planA._id).lean();
  assert.equal(doc.stoppedAt.toISOString(), results.find((r) => r.status === 'fulfilled').value.stoppedAt);
});

test('concurrent Stop A and Start B: never two running plans; B starts only once A is stopped', async () => {
  await startA();
  const b = await enroll();
  await ready(b._id);
  const results = await Promise.allSettled([
    stopPlanForCoach(coachUser._id, planA._id, { now: STOP }),
    startPlanForCoach(coachUser._id, b._id, { now: STOP }),
  ]);
  assert.equal(results[0].status, 'fulfilled', JSON.stringify(results[0].reason?.code));
  const docs = await EnrolledClient.find({ userId: member._id }).lean();
  const running = docs.filter((d) => !d.stoppedAt && d.hasStarted);
  assert.ok(running.length <= 1, 'at most one plan runs');
  if (results[1].status === 'rejected') assert.equal(results[1].reason.code, 'ACTIVE_PLAN_EXISTS');
  else assert.equal(String(running[0]._id), String(b._id));
});

test('Plan A stopped, Plan B stays bought and unstarted until the coach starts it - then the usual Start rules', async () => {
  const b = await enroll({ enrollDate: new Date('2026-11-10') });
  await startA();
  await ready(b._id);
  await assert.rejects(startPlanForCoach(coachUser._id, b._id, { now: STOP }), code('ACTIVE_PLAN_EXISTS'));

  await stopPlanForCoach(coachUser._id, planA._id, { now: STOP });
  const waiting = await EnrolledClient.findById(b._id).lean();
  assert.deepEqual([waiting.hasStarted, waiting.startDate, waiting.startedAt, waiting.stoppedAt], [false, null, null, null], 'B is not started by the stop');
  const { current, enrollments } = await listMemberEnrollments(member._id, LATER);
  assert.equal(current, null, 'nothing is current: B waits for the coach');
  assert.deepEqual(
    enrollments.map((e) => [e.id, e.status]),
    [
      [String(b._id), 'not_started'],
      [String(planA._id), 'stopped'],
    ],
  );

  const started = await startPlanForCoach(coachUser._id, b._id, { now: LATER });
  assert.equal(started.planStartDate, '2026-11-26', 'Day 1 is the next IST day');
  assert.equal(started.planEndDate, '2027-02-17', '12 weeks, last day inclusive');
  assert.equal((await planAccessOf(member._id, ist('2026-11-25T12:00:00'))).access.activeEnrollmentId, String(b._id), 'access the Start day');
  assert.equal((await EnrolledClient.findById(planA._id).lean()).stoppedAt.toISOString(), STOP.toISOString(), 'A stays stopped');

  // The coach's history keeps A, marked stopped, behind the current B.
  const history = await getClientEnrollmentsForCoachUser(coachUser._id, String(member._id), ist('2026-11-25T12:00:00'));
  assert.deepEqual(
    history.enrollments.map((e) => [e.enrollmentId, e.lifecycle, e.isCurrent]),
    [
      [String(b._id), 'scheduled', true],
      [String(planA._id), 'stopped', false],
    ],
  );
  assert.equal(history.enrollments[1].stoppedAt, STOP.toISOString());
});

test('admin list: a stopped plan is neither active nor inactive, and has its own status filter', async () => {
  await startA();
  await stopPlanForCoach(coachUser._id, planA._id, { now: STOP });
  const admin = await seedUser(['user', 'admin'], 'Admin');
  const list = (status) => server.request('GET', `/api/admin/enrolled-clients?status=${status}`, { token: tokenFor(admin) });
  const stopped = await list('stopped');
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  const rows = stopped.body.data.items ?? stopped.body.data.enrolledClients ?? stopped.body.data.rows ?? stopped.body.data;
  assert.ok(Array.isArray(rows), JSON.stringify(stopped.body.data).slice(0, 200));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'stopped');
  assert.equal(rows[0].isCurrent, false);
  assert.ok(rows[0].stoppedAt);
  const active = await list('active');
  const activeRows = active.body.data.items ?? active.body.data.enrolledClients ?? active.body.data.rows ?? active.body.data;
  assert.equal(activeRows.length, 0);
});
