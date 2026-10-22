import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Food from '../../src/models/food.model.js';
import FoodLog from '../../src/models/food-log.model.js';
import User from '../../src/models/user.model.js';
import { submitFoodLog } from '../../src/services/food-log.service.js';
import { businessDayOf } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Intake: at most 3 successful food log submissions per member per business
 * day (Asia/Kolkata). Enforced by the save itself - concurrent requests and
 * direct API calls included; failures are not counted, a retried submission
 * (same submissionId) is not counted twice, and a new day starts again at 3.
 */
let server;
let member;
let other;
let rice;

const LIMIT_MESSAGE = "You've reached your daily Intake submission limit. You can submit again tomorrow.";
const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (name) => {
  seq += 1;
  const phone = `9188200${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles: ['user', 'client'], status: 'active' });
};
const noonOn = (day) => new Date(`${day}T06:30:00.000Z`);
const body = (grams, extra = {}) => ({
  meals: [{ meal: 1, foods: [{ entryId: 'e1', foodId: String(rice._id), qty: grams }] }],
  memberGoal: null,
  day: null,
  submissionId: null,
  ...extra,
});
const submit = (user, grams, now, extra) => submitFoodLog(user._id, body(grams, extra), { now });
const rejectsWithLimit = (promise) =>
  assert.rejects(promise, (e) => e.statusCode === 429 && e.code === 'INTAKE_DAILY_LIMIT_REACHED' && e.message === LIMIT_MESSAGE);
const countOf = async (user, day) => (await FoodLog.findOne({ clientId: user._id, logDate: day }).lean())?.submissionCount ?? 0;

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  member = await seedUser('Chethan');
  other = await seedUser('Bob');
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 113, fat: 3.5, carbs: 19, protein: 2 });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('first, second and third submissions are accepted (3 → 2 → 1 → 0 left); the fourth is refused', async () => {
  const day = '2026-10-20';
  const remaining = [];
  for (const grams of [100, 150, 200]) {
    const res = await submit(member, grams, noonOn(day));
    remaining.push(res.submissions.remaining);
  }
  assert.deepEqual(remaining, [2, 1, 0]);
  await rejectsWithLimit(submit(member, 250, noonOn(day)));
  const doc = await FoodLog.findOne({ clientId: member._id, logDate: day }).lean();
  assert.equal(doc.submissionCount, 3);
  assert.equal(doc.meals[0].foods[0].qty, 200, 'the refused fourth wrote nothing');
  assert.equal(await FoodLog.countDocuments(), 1);
});

test('a failed submission does not use a slot', async () => {
  const day = '2026-10-20';
  await submit(member, 100, noonOn(day));
  // An unknown food (validation) and a day-changed refusal: neither counts.
  await assert.rejects(
    submitFoodLog(member._id, { ...body(100), meals: [{ meal: 1, foods: [{ entryId: 'x', foodId: '64b000000000000000000000', qty: 1 }] }] }, { now: noonOn(day) }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(submit(member, 100, noonOn(day), { day: '2026-10-19' }), (e) => e.code === 'FOOD_LOG_DAY_CHANGED');
  assert.equal(await countOf(member, day), 1);
  assert.equal((await submit(member, 120, noonOn(day))).submissions.remaining, 1);
});

test('the limit resets on the next Asia/Kolkata day - midnight there, not UTC', async () => {
  // 18:29:59.999Z is 23:59:59.999 IST on the 20th; 18:30Z is 00:00 IST on the 21st.
  const lastMoment = new Date('2026-10-20T18:29:59.999Z');
  const nextDay = new Date('2026-10-20T18:30:00.000Z');
  assert.equal(businessDayOf(lastMoment), '2026-10-20');
  assert.equal(businessDayOf(nextDay), '2026-10-21');
  for (let i = 0; i < 3; i += 1) await submit(member, 100 + i, lastMoment);
  await rejectsWithLimit(submit(member, 200, lastMoment));
  const fresh = await submit(member, 200, nextDay);
  assert.equal(fresh.date, '2026-10-21');
  assert.equal(fresh.submissions.remaining, 2);
  assert.equal(await countOf(member, '2026-10-20'), 3);
  assert.equal(await countOf(member, '2026-10-21'), 1);
});

test('concurrent submissions can never exceed three', async () => {
  const day = '2026-10-20';
  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5, 6, 7].map((i) => submit(member, 100 + i, noonOn(day), { submissionId: `tap-${i}` })),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 3, JSON.stringify(refused.map((r) => r.reason?.code)));
  for (const r of refused) assert.equal(r.reason.code, 'INTAKE_DAILY_LIMIT_REACHED');
  assert.equal(await countOf(member, day), 3);
  assert.equal(await FoodLog.countDocuments({ clientId: member._id }), 1);
});

test('a retried submission (same submissionId) is counted once - even at the limit', async () => {
  const day = '2026-10-20';
  await submit(member, 100, noonOn(day), { submissionId: 'a' });
  // The response to "b" was lost; the app sends "b" again.
  await submit(member, 110, noonOn(day), { submissionId: 'b' });
  const retried = await submit(member, 110, noonOn(day), { submissionId: 'b' });
  assert.equal(retried.submissions.remaining, 1);
  assert.equal(await countOf(member, day), 2);
  // Retrying concurrently is safe as well.
  await Promise.all([1, 2, 3].map(() => submit(member, 120, noonOn(day), { submissionId: 'c' })));
  assert.equal(await countOf(member, day), 3);
  // At the limit, a retry of the last one still succeeds (it was saved); a new one does not.
  assert.equal((await submit(member, 120, noonOn(day), { submissionId: 'c' })).submissions.remaining, 0);
  await rejectsWithLimit(submit(member, 130, noonOn(day), { submissionId: 'd' }));
});

test('a log saved before the limit existed starts at 0 used', async () => {
  const day = '2026-10-20';
  await submit(member, 100, noonOn(day));
  await FoodLog.updateOne({ clientId: member._id, logDate: day }, { $unset: { submissionCount: '', lastSubmissionId: '' } });
  assert.equal((await submit(member, 110, noonOn(day))).submissions.remaining, 2);
});

test('HTTP: today\'s count is the token\'s own; unauthenticated is refused; one member never uses another\'s', async () => {
  const today = businessDayOf(new Date());
  const put = (user, b) => server.request('PUT', '/api/users/me/food-log', { body: b, token: user && tokenFor(user) });

  assert.equal((await put(null, body(100))).status, 401);
  assert.equal((await server.request('GET', '/api/users/me/food-log')).status, 401);

  for (const grams of [100, 110, 120]) {
    const res = await put(member, body(grams));
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const fourth = await put(member, body(130));
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.error.code, 'INTAKE_DAILY_LIMIT_REACHED');
  assert.equal(fourth.body.error.message, LIMIT_MESSAGE);

  // The member's read shows 0 left; the other member is untouched, at 3.
  const mine = await server.request('GET', '/api/users/me/food-log', { token: tokenFor(member) });
  assert.deepEqual(mine.body.data.submissions, { used: 3, limit: 3, remaining: 0 });
  const theirs = await server.request('GET', '/api/users/me/food-log', { token: tokenFor(other) });
  assert.deepEqual(theirs.body.data.submissions, { used: 0, limit: 3, remaining: 3 });
  const res = await put(other, body(100));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.submissions, { used: 1, limit: 3, remaining: 2 });
  assert.equal(await countOf(member, today), 3);
});
