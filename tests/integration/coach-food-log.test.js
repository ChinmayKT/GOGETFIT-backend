import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import Food from '../../src/models/food.model.js';
import FoodLog from '../../src/models/food-log.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { submitFoodLog } from '../../src/services/food-log.service.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * A coach's read-only view of a client's Food Log History -
 * GET /api/coach/enrollments/:enrollmentId/food-log/history and
 * GET /api/coach/enrollments/:enrollmentId/food-log?date=. Only through the
 * coach's own live enrollment; the same data the member sees; never written.
 */
let server;
let plan;
let member;
let other;
let coachUser;
let coach;
let otherCoachUser;
let enrollment;
let otherEnrollment;
let rice;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9188000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};
const enroll = (user, c, extra = {}) =>
  EnrolledClient.create({ userId: user._id, planId: plan._id, coachId: c._id, enrollDate: new Date('2026-09-01'), hasStarted: true, isDeleted: false, ...extra });
const noonOn = (day) => new Date(`${day}T06:30:00.000Z`);
const logDay = (user, day, grams) =>
  submitFoodLog(
    user._id,
    { meals: [{ meal: 1, foods: [{ entryId: `${day}-a`, foodId: String(rice._id), qty: grams }] }], memberGoal: { calories: 2000, fat: 60, carbs: 220, protein: 150 }, day: null },
    { now: noonOn(day) },
  );
const history = (enrollmentId, qs = '', user = coachUser) =>
  server.request('GET', `/api/coach/enrollments/${enrollmentId}/food-log/history${qs}`, { token: tokenFor(user) });
const dayRead = (enrollmentId, qs, user = coachUser) =>
  server.request('GET', `/api/coach/enrollments/${enrollmentId}/food-log${qs}`, { token: tokenFor(user) });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  plan = await GogetfitPlan.create({ name: '12 WEEKS', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1, pricing: { basePrice: 1, reward: 0 } });
  member = await seedUser(['user', 'client'], 'Chethan');
  other = await seedUser(['user', 'client'], 'Bob');
  coachUser = await seedUser(['user', 'coach'], 'Prajwal');
  coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  otherCoachUser = await seedUser(['user', 'coach'], 'Siri');
  const otherCoach = await Coach.create({ userId: otherCoachUser._id, profile: { level: 'LEVEL 1' } });
  enrollment = await enroll(member, coach);
  otherEnrollment = await enroll(other, otherCoach);
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 113, fat: 3.5, carbs: 19, protein: 2 });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('the client\'s submitted days, newest first - theirs only', async () => {
  await logDay(member, '2026-10-14', 100);
  await logDay(member, '2026-10-17', 200);
  await logDay(other, '2026-10-16', 100);
  await logDay(coachUser, '2026-10-15', 100); // the coach's own log, as a member

  const res = await history(enrollment._id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.items.map((i) => i.date), ['2026-10-17', '2026-10-14']);
  assert.equal(res.body.data.items[0].consumed.calories, 226);
  // Paging and ranges work as for the member.
  const page = await history(enrollment._id, '?limit=1');
  assert.deepEqual(page.body.data.items.map((i) => i.date), ['2026-10-17']);
  assert.equal(page.body.data.nextCursor, '2026-10-17');
});

test('one day in full, as stored - and reading writes nothing', async () => {
  await logDay(member, '2026-10-17', 200);
  const before = await FoodLog.findOne().lean();

  const res = await dayRead(enrollment._id, '?date=2026-10-17');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const log = res.body.data.foodLog;
  assert.equal(log.date, '2026-10-17');
  assert.equal(log.meals[0].foods[0].qty, 200);
  assert.equal(log.meals[0].foods[0].nutrition.calories, 226);
  assert.equal(log.meals[0].image, null);
  assert.deepEqual(log.targets, { calories: 2000, fat: 60, carbs: 220, protein: 150 });
  // A day with nothing saved is null - never another day, never today.
  assert.equal((await dayRead(enrollment._id, '?date=2026-10-16')).body.data.foodLog, null);
  assert.deepEqual(await FoodLog.findOne().lean(), before);
  assert.equal(await FoodLog.countDocuments(), 1);
});

test('a day must be named, and be a real date', async () => {
  for (const qs of ['', '?date=', '?date=2026-02-30', '?date=17-10-2026']) {
    const res = await dayRead(enrollment._id, qs);
    assert.equal(res.status, 400, qs);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal((await history(enrollment._id, '?from=nope')).status, 400);
});

test('only through the coach\'s own live enrollment', async () => {
  await logDay(other, '2026-10-16', 100);
  const deleted = await enroll(other, coach, { isDeleted: true });
  for (const id of [otherEnrollment._id, deleted._id, '64b7f0f0f0f0f0f0f0f0f0f0', 'nope']) {
    for (const res of [await history(id), await dayRead(id, '?date=2026-10-16')]) {
      assert.equal(res.status, 404, String(id));
      assert.equal(res.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
    }
  }
  // A client id in the request changes nothing: it is always the enrollment's.
  await logDay(member, '2026-10-17', 100);
  const res = await history(enrollment._id, `?clientId=${other._id}`);
  assert.deepEqual(res.body.data.items.map((i) => i.date), ['2026-10-17']);
});

test('members and signed-out callers are refused', async () => {
  assert.equal((await history(enrollment._id, '', member)).status, 403);
  assert.equal((await dayRead(enrollment._id, '?date=2026-10-17', member)).status, 403);
  const anon = await server.request('GET', `/api/coach/enrollments/${enrollment._id}/food-log/history`);
  assert.equal(anon.status, 401);
});
