import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Coach from '../../src/models/coach.model.js';
import DailyUpdate from '../../src/models/daily-update.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import Food from '../../src/models/food.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import Questionnaire from '../../src/models/questionnaire.model.js';
import User from '../../src/models/user.model.js';
import { submitDailyUpdate } from '../../src/services/daily-update.service.js';
import { submitFoodLog } from '../../src/services/food-log.service.js';
import { businessDayOf } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Daily Update persistence - the member's GET/PUT/history under
 * /api/users/me/daily-updates, and the coach's read-only
 * /api/coach/enrollments/:enrollmentId/daily-updates. One record per member
 * per day, overwritten in place; Calorie In from the day's food log; totals
 * summed server-side and never partial.
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
const seedUser = (roles, name, extra = {}) => {
  seq += 1;
  const phone = `9188100${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name, ...extra }, roles, status: 'active' });
};
const enroll = (user, c) =>
  EnrolledClient.create({
    userId: user._id,
    planId: plan._id,
    coachId: c._id,
    enrollDate: new Date('2026-09-01'),
    startDate: new Date('2026-09-01'),
    endDate: new Date('2099-01-01'),
    hasStarted: true,
    isDeleted: false,
  });
const noonOn = (day) => new Date(`${day}T06:30:00.000Z`);
const body = (over = {}) => ({
  weightKg: 80,
  workoutMinutes: 60,
  steps: 8000,
  calorieOut: { bmr: 1542, tef: 220, eat: 150, neat: 144 },
  ...over,
});
// 1,000 g of rice = 1,130 kcal, 20 g protein, 190 g carbs, 35 g fat.
const logDay = (user, day, grams = 1000) =>
  submitFoodLog(
    user._id,
    { meals: [{ meal: 1, foods: [{ entryId: `${day}-a`, foodId: String(rice._id), qty: grams }] }], memberGoal: { calories: 2000, fat: 60, carbs: 220, protein: 150 }, day: null },
    { now: noonOn(day) },
  );
const put = (date, b, user = member) => server.request('PUT', `/api/users/me/daily-updates/${date}`, { body: b, token: tokenFor(user) });
const get = (path, user = member) => server.request('GET', path, { token: tokenFor(user) });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  plan = await GogetfitPlan.create({ name: '12 WEEKS', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1, pricing: { basePrice: 1, reward: 0 } });
  member = await seedUser(['user', 'client'], 'Chethan', { gender: 'male' });
  other = await seedUser(['user', 'client'], 'Bob');
  coachUser = await seedUser(['user', 'coach'], 'Prajwal');
  coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  otherCoachUser = await seedUser(['user', 'coach'], 'Siri');
  const otherCoach = await Coach.create({ userId: otherCoachUser._id, profile: { level: 'LEVEL 1' } });
  enrollment = await enroll(member, coach);
  otherEnrollment = await enroll(other, otherCoach);
  await Questionnaire.create({
    userId: member._id,
    enrollmentId: enrollment._id,
    coachId: coach._id,
    answers: { gender: 'Male', age: '30', height: '5.6' },
    status: 'submitted',
  });
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 113, fat: 3.5, carbs: 19, protein: 2 });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('PUT today creates the record: ids from the token and enrollment, Calorie In from the food log, totals summed', async () => {
  const today = businessDayOf(new Date());
  await logDay(member, today);
  const res = await put(today, body({ clientId: String(other._id), coachId: 'x', calorieIn: { calories: 99999 } }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data.dailyUpdate;
  assert.equal(d.date, today);
  assert.equal(d.enrollmentId, String(enrollment._id));
  assert.equal(d.coachId, String(coach._id));
  assert.equal(d.planId, String(plan._id));
  assert.deepEqual(d.profile, { name: 'Chethan', gender: 'male', age: 30, heightCm: 171 });
  assert.deepEqual(d.activity, { weightKg: 80, workoutMinutes: 60, steps: 8000 });
  assert.equal(d.calorieIn.consumed.calories, 1130);
  assert.deepEqual(d.calorieIn.targets, { calories: 2000, protein: 150, carbs: 220, fat: 60 });
  assert.deepEqual(d.calorieOut, { bmr: 1542, tef: 220, eat: 150, neat: 144, total: 2056 });
  assert.deepEqual(d.energyBalance, { kcal: 1130 - 2056, status: 'negative' });
  const saved = await DailyUpdate.findOne().lean();
  assert.equal(String(saved.clientId), String(member._id), 'never the body\'s clientId');
});

test('a second PUT the same day overwrites the same record; createdAt kept', async () => {
  const day = '2026-10-20';
  await logDay(member, day);
  const first = await submitDailyUpdate(member._id, day, { ...body(), calorieOut: body().calorieOut }, { now: noonOn(day) });
  const second = await submitDailyUpdate(
    member._id,
    day,
    { weightKg: 79.5, workoutMinutes: 30, steps: 5000, calorieOut: { bmr: 1535, tef: 220, eat: 75, neat: 90 } },
    { now: new Date(noonOn(day).getTime() + 3600_000) },
  );
  assert.equal(await DailyUpdate.countDocuments(), 1);
  assert.equal(second.dailyUpdate.createdAt, first.dailyUpdate.createdAt);
  assert.notEqual(second.dailyUpdate.updatedAt, first.dailyUpdate.updatedAt);
  assert.deepEqual(second.dailyUpdate.activity, { weightKg: 79.5, workoutMinutes: 30, steps: 5000 });
  assert.equal(second.dailyUpdate.calorieOut.total, 1920);
  assert.equal(second.dailyUpdate.energyBalance.kcal, 1130 - 1920);
});

test('racing first submissions: still one record', async () => {
  const day = '2026-10-20';
  await Promise.all(
    [1, 2, 3].map((i) => submitDailyUpdate(member._id, day, { ...body(), steps: 1000 * i, calorieOut: body().calorieOut }, { now: noonOn(day) })),
  );
  assert.equal(await DailyUpdate.countDocuments({ clientId: member._id, date: day }), 1);
});

test('different days are different records; history is newest first, summaries only, paged', async () => {
  for (const day of ['2026-10-18', '2026-10-20', '2026-10-19']) {
    await logDay(member, day);
    await submitDailyUpdate(member._id, day, { ...body(), calorieOut: body().calorieOut }, { now: noonOn(day) });
  }
  await submitDailyUpdate(other._id, '2026-10-20', { ...body(), calorieOut: body().calorieOut }, { now: noonOn('2026-10-20') });

  const res = await get('/api/users/me/daily-updates');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.items.map((i) => i.date), ['2026-10-20', '2026-10-19', '2026-10-18']);
  const item = res.body.data.items[0];
  assert.equal(item.weightKg, 80);
  assert.equal(item.calorieIn, 1130);
  assert.equal(item.calorieOut, 2056);
  assert.equal(item.energyBalance, -926);
  assert.equal(item.status, 'negative');
  assert.equal(item.activity, undefined, 'no full record in the list');
  const page = await get('/api/users/me/daily-updates?limit=2');
  assert.deepEqual(page.body.data.items.map((i) => i.date), ['2026-10-20', '2026-10-19']);
  assert.equal(page.body.data.nextCursor, '2026-10-19');
  const rest = await get('/api/users/me/daily-updates?cursor=2026-10-19');
  assert.deepEqual(rest.body.data.items.map((i) => i.date), ['2026-10-18']);

  const one = await get('/api/users/me/daily-updates/2026-10-19');
  assert.equal(one.body.data.dailyUpdate.date, '2026-10-19');
  assert.equal((await get('/api/users/me/daily-updates/2026-10-17')).body.data.dailyUpdate, null);
});

test('missing values stay null: a part unavailable, or no food log', async () => {
  const day = '2026-10-20';
  const noLog = await submitDailyUpdate(member._id, day, { ...body(), calorieOut: { bmr: 1542, tef: null, eat: 150, neat: 144 } }, { now: noonOn(day) });
  assert.equal(noLog.dailyUpdate.calorieIn, null);
  assert.deepEqual(noLog.dailyUpdate.calorieOut, { bmr: 1542, tef: null, eat: 150, neat: 144, total: null });
  assert.deepEqual(noLog.dailyUpdate.energyBalance, { kcal: null, status: null });
});

test('only today can be submitted; bad dates and bodies are refused', async () => {
  const today = businessDayOf(new Date());
  const past = await put('2026-01-01', body());
  assert.equal(past.status, 409);
  assert.equal(past.body.error.code, 'DAILY_UPDATE_DAY_CLOSED');
  for (const date of ['2026-02-30', 'today', '20-10-2026']) {
    assert.equal((await put(date, body())).status, 400, date);
    assert.equal((await get(`/api/users/me/daily-updates/${date}`)).status, 400, date);
  }
  assert.equal((await put(today, body({ weightKg: 500 }))).status, 400);
  assert.equal((await put(today, body({ steps: 1.5 }))).status, 400);
  assert.equal(await DailyUpdate.countDocuments(), 0);
});

test('a member only ever reads and writes their own', async () => {
  const day = '2026-10-20';
  await submitDailyUpdate(other._id, day, { ...body(), calorieOut: body().calorieOut }, { now: noonOn(day) });
  assert.equal((await get(`/api/users/me/daily-updates/${day}`)).body.data.dailyUpdate, null);
  assert.deepEqual((await get('/api/users/me/daily-updates')).body.data.items, []);
  assert.equal((await server.request('GET', '/api/users/me/daily-updates')).status, 401);
});

test('coach: their own client\'s days and one day in full - read-only, never another coach\'s client', async () => {
  for (const day of ['2026-10-19', '2026-10-20']) {
    await logDay(member, day);
    await submitDailyUpdate(member._id, day, { ...body(), calorieOut: body().calorieOut }, { now: noonOn(day) });
  }
  const before = await DailyUpdate.find().sort({ date: 1 }).lean();

  const list = await get(`/api/coach/enrollments/${enrollment._id}/daily-updates`, coachUser);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.data.items.map((i) => i.date), ['2026-10-20', '2026-10-19']);
  const one = await get(`/api/coach/enrollments/${enrollment._id}/daily-updates/2026-10-19`, coachUser);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.data.dailyUpdate.calorieOut, { bmr: 1542, tef: 220, eat: 150, neat: 144, total: 2056 });
  assert.equal(one.body.data.dailyUpdate.profile.name, 'Chethan');
  assert.deepEqual(await DailyUpdate.find().sort({ date: 1 }).lean(), before);

  // Another coach's enrollment, a made-up id, a member token: refused.
  assert.equal((await get(`/api/coach/enrollments/${otherEnrollment._id}/daily-updates`, coachUser)).status, 404);
  assert.equal((await get(`/api/coach/enrollments/${enrollment._id}/daily-updates`, otherCoachUser)).status, 404);
  assert.equal((await get('/api/coach/enrollments/nope/daily-updates', coachUser)).status, 404);
  assert.equal((await get(`/api/coach/enrollments/${enrollment._id}/daily-updates`, member)).status, 403);
  // No coach writes.
  const write = await server.request('PUT', `/api/coach/enrollments/${enrollment._id}/daily-updates/2026-10-20`, { body: body(), token: tokenFor(coachUser) });
  assert.equal(write.status, 404);
});

// --- At most 3 submissions per member per day (as Intake) -------------------

const LIMIT_MESSAGE = "You've reached your daily Daily Update submission limit. You can submit again tomorrow.";
const counted = async (user, day) => (await DailyUpdate.findOne({ clientId: user._id, date: day }).lean())?.submissionCount ?? 0;
const once = (user, day, extra = {}, now = noonOn(day)) =>
  submitDailyUpdate(user._id, day, { ...body(), calorieOut: body().calorieOut, submissionId: null, ...extra }, { now });
const rejectsWithLimit = (promise) =>
  assert.rejects(promise, (e) => e.statusCode === 429 && e.code === 'DAILY_UPDATE_DAILY_LIMIT_REACHED' && e.message === LIMIT_MESSAGE);

test('limit: 1st, 2nd, 3rd accepted (2 → 1 → 0 left); the 4th refused, the record as the 3rd left it', async () => {
  const day = '2026-10-20';
  const left = [];
  for (const steps of [1000, 2000, 3000]) left.push((await once(member, day, { steps })).submissions.remaining);
  assert.deepEqual(left, [2, 1, 0]);
  await rejectsWithLimit(once(member, day, { steps: 4000 }));
  const doc = await DailyUpdate.findOne({ clientId: member._id, date: day }).lean();
  assert.equal(doc.submissionCount, 3);
  assert.equal(doc.activity.steps, 3000);
});

test('limit: failures are not counted; a new Asia/Kolkata day starts again', async () => {
  const lastMoment = new Date('2026-10-20T18:29:59.999Z'); // 23:59:59.999 IST
  const nextDay = new Date('2026-10-20T18:30:00.000Z'); // 00:00 IST on the 21st
  await assert.rejects(once(member, '2026-10-19', {}, lastMoment), (e) => e.code === 'DAILY_UPDATE_DAY_CLOSED');
  for (let i = 0; i < 3; i += 1) await once(member, '2026-10-20', { steps: i }, lastMoment);
  await rejectsWithLimit(once(member, '2026-10-20', {}, lastMoment));
  const fresh = await once(member, '2026-10-21', {}, nextDay);
  assert.equal(fresh.submissions.remaining, 2);
  assert.equal(await counted(member, '2026-10-20'), 3);
});

test('limit: concurrent submissions never exceed three; a retried id counts once', async () => {
  const day = '2026-10-20';
  const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => once(member, day, { steps: i, submissionId: `tap-${i}` })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'DAILY_UPDATE_DAILY_LIMIT_REACHED');
  assert.equal(await counted(member, day), 3);

  const other2 = '2026-10-21';
  await once(member, other2, { submissionId: 'a' }, noonOn(other2));
  await once(member, other2, { submissionId: 'a' }, noonOn(other2)); // the lost response, retried
  assert.equal(await counted(member, other2), 1);
});

test('limit over HTTP: the member\'s own count, 429 on the fourth; another member untouched', async () => {
  const today = businessDayOf(new Date());
  for (let i = 0; i < 3; i += 1) assert.equal((await put(today, body({ steps: i }))).status, 200);
  const fourth = await put(today, body());
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.error.code, 'DAILY_UPDATE_DAILY_LIMIT_REACHED');
  assert.equal(fourth.body.error.message, LIMIT_MESSAGE);
  assert.deepEqual((await get(`/api/users/me/daily-updates/${today}`)).body.data.submissions, { used: 3, limit: 3, remaining: 0 });
  assert.deepEqual((await get(`/api/users/me/daily-updates/${today}`, other)).body.data.submissions, { used: 0, limit: 3, remaining: 3 });
});
