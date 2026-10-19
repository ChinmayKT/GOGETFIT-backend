import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import DietPlan from '../../src/models/diet-plan.model.js';
import Food from '../../src/models/food.model.js';
import FoodLog from '../../src/models/food-log.model.js';
import User from '../../src/models/user.model.js';
import { submitFoodLog } from '../../src/services/food-log.service.js';
import { startOfBusinessDay } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Food History - GET /api/users/me/food-log/history and the day read
 * (GET /api/users/me/food-log?date=). Only days the member submitted, newest
 * first, read from the stored snapshots and never written to.
 */
let server;
let member;
let other;
let rice; // 113 kcal per 100 g

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (name) => {
  seq += 1;
  const phone = `9155000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles: ['user', 'client'], status: 'active' });
};
const history = (qs = '', user = member) => server.request('GET', `/api/users/me/food-log/history${qs}`, { token: tokenFor(user) });
const dayRead = (date, user = member) => server.request('GET', `/api/users/me/food-log?date=${date}`, { token: tokenFor(user) });

/** Noon IST on [day] - inside that business day. */
const noonOn = (day) => new Date(`${day}T06:30:00.000Z`);
/** Saves [grams] of rice as [user]'s log for [day], as the app would. */
const logDay = (day, grams = 100, user = member, memberGoal = { calories: 2000, fat: 60, carbs: 220, protein: 150 }) =>
  submitFoodLog(user._id, { meals: [{ meal: 1, foods: [{ entryId: `${day}-a`, foodId: String(rice._id), qty: grams }] }], memberGoal, day: null }, { now: noonOn(day) });

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

test('only days the member submitted, newest first, one per day, totals only', async () => {
  await logDay('2026-10-14', 100);
  await logDay('2026-10-16', 200);
  await logDay('2026-10-16', 300); // same day again: still one
  await logDay('2026-10-18', 50);
  await logDay('2026-10-17', 100, other);

  const res = await history();
  assert.equal(res.status, 200);
  const { items, nextCursor, timezone } = res.body.data;
  assert.equal(timezone, 'Asia/Kolkata');
  assert.deepEqual(items.map((i) => i.date), ['2026-10-18', '2026-10-16', '2026-10-14'], 'no 15th, no 17th');
  assert.equal(nextCursor, null);
  const d16 = items[1];
  assert.equal(d16.consumed.calories, 339);
  assert.deepEqual(d16.targets, { calories: 2000, fat: 60, carbs: 220, protein: 150 });
  assert.equal(d16.remaining.calories, 1661);
  assert.equal(d16.status, 'open');
  assert.equal(d16.mealsLogged, 1);
  assert.equal(d16.foodsLogged, 1);
  assert.ok(!('meals' in d16), 'no meals in the list');
});

test('pages by date with no duplicates or gaps', async () => {
  const days = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];
  for (const d of days) await logDay(d);

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await history(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...res.body.data.items.map((i) => i.date));
    cursor = res.body.data.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);
  assert.deepEqual(seen, [...days].reverse());
  assert.equal(pages, 3);
});

test('a date range is a week for the Weekly Consistency card', async () => {
  for (const d of ['2026-10-11', '2026-10-12', '2026-10-15', '2026-10-19']) await logDay(d);
  const res = await history('?from=2026-10-12&to=2026-10-18');
  assert.deepEqual(res.body.data.items.map((i) => i.date), ['2026-10-15', '2026-10-12']);
  // The average is over submitted days only: 2 days of 113 kcal, not 7.
  const items = res.body.data.items;
  assert.equal(items.reduce((n, i) => n + i.consumed.calories, 0) / items.length, 113);
});

test('a day read gives that day\'s whole log, never today\'s instead', async () => {
  await logDay('2026-10-16', 200);
  await logDay('2026-10-18', 50);

  const d16 = (await dayRead('2026-10-16')).body.data;
  assert.equal(d16.date, '2026-10-16');
  assert.equal(d16.foodLog.date, '2026-10-16');
  assert.equal(d16.foodLog.consumed.calories, 226);
  assert.equal(d16.foodLog.meals[0].foods[0].qty, 200);
  assert.equal(d16.foodLog.status, 'open');
  assert.ok(d16.foodLog.submittedAt);
  // A day with nothing saved is null, not another day's log.
  const d17 = (await dayRead('2026-10-17')).body.data;
  assert.equal(d17.date, '2026-10-17');
  assert.equal(d17.foodLog, null);
});

test('another member\'s days are out of reach, whatever is asked', async () => {
  await logDay('2026-10-16', 200, other);
  assert.deepEqual((await history()).body.data.items, []);
  assert.deepEqual((await history(`?clientId=${other._id}`)).body.data.items, []);
  assert.equal((await dayRead('2026-10-16')).body.data.foodLog, null);
  assert.equal((await server.request('GET', '/api/users/me/food-log/history')).status, 401);
});

test('history keeps the targets and nutrition it was saved with', async () => {
  await DietPlan.create({
    planId: 'app:1', clientId: member._id, name: 'Cut', fromDate: startOfBusinessDay('2026-10-01'), toDate: startOfBusinessDay('2026-10-31'),
    assignedAt: new Date('2026-09-30'), targets: { calories: 1450, fat: 32, carbs: 181, protein: 109 }, meals: [],
  });
  await logDay('2026-10-16', 100);
  // Later: the plan's targets, the coach's intake and the food all change.
  await DietPlan.updateOne({}, { $set: { 'targets.calories': 1999, coachGivenTargets: { calories: 1600, protein: 1, carbs: 1, fat: 1, setAt: new Date(), setBy: member._id } } });
  await Food.updateOne({ _id: rice._id }, { $set: { calories: 500 } });
  const before = await FoodLog.findOne().lean();

  const item = (await history()).body.data.items[0];
  assert.deepEqual(item.targets, { calories: 1450, fat: 32, carbs: 181, protein: 109 });
  assert.equal(item.targetsSource, 'plan');
  assert.equal(item.consumed.calories, 113);
  const day = (await dayRead('2026-10-16')).body.data.foodLog;
  assert.equal(day.meals[0].foods[0].perPortion.calories, 113);
  assert.equal(day.meals[0].foods[0].nutrition.calories, 113);
  // Reading never wrote anything.
  assert.deepEqual(await FoodLog.findOne().lean(), before);
});

test('an older document without status or submittedAt still reads', async () => {
  await FoodLog.collection.insertOne({
    clientId: member._id, logDate: '2026-09-01', timezone: 'Asia/Kolkata',
    consumed: { calories: 100, fat: 1, carbs: 1, protein: 1 }, meals: [],
  });
  const item = (await history()).body.data.items[0];
  assert.equal(item.date, '2026-09-01');
  assert.equal(item.status, 'open');
  assert.equal(item.targets, null);
  assert.equal(item.remaining, null);
  assert.equal(item.submittedAt, null);
  assert.equal((await dayRead('2026-09-01')).body.data.foodLog.consumed.calories, 100);
});

test('a resubmitted day is still one document in history', async () => {
  await logDay('2026-10-16', 100);
  await logDay('2026-10-16', 250);
  assert.equal(await FoodLog.countDocuments({ clientId: member._id }), 1);
  const items = (await history()).body.data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].consumed.calories, 282.5);
});

test('bad dates and limits are a 400', async () => {
  for (const qs of ['?from=18-10-2026', '?to=2026-13-01', '?cursor=nope', '?limit=0', '?limit=abc', '?from=2026-10-18&to=2026-10-01']) {
    const res = await history(qs);
    assert.equal(res.status, 400, qs);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal((await dayRead('2026-02-30')).status, 400);
  // An over-large limit is capped, not refused.
  assert.equal((await history('?limit=999')).status, 200);
});
