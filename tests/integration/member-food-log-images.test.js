import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import jwt from 'jsonwebtoken';

import env from '../../src/config/env.js';
import Food from '../../src/models/food.model.js';
import FoodLog from '../../src/models/food-log.model.js';
import User from '../../src/models/user.model.js';
import { getFoodLogForDay, getFoodLogHistory, submitFoodLog, uploadFoodLogMealImage } from '../../src/services/food-log.service.js';
import { resetStorage } from '../../src/services/storage/index.js';
import { businessDayOf } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Meal photos in the Intake food log, and `foods` (once `entries`).
 *
 * A photo is uploaded on its own (PUT /me/food-log/meals/:meal/image) only to
 * get a reference; the log changes only when a submission carrying that
 * reference is saved. Per meal: a reference sets or replaces the photo, null
 * removes it, and leaving it out keeps the saved one.
 */
let server;
let uploadRoot;
let member;
let other;
let rice; // 113 kcal per 100 g
let whey; // 120 kcal per scoop

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (name) => {
  seq += 1;
  const phone = `9177000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles: ['user', 'client'], status: 'active' });
};
const jpeg = (fill = 0x01) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
const put = (body, user = member) => server.request('PUT', '/api/users/me/food-log', { token: tokenFor(user), body });
const upload = (meal, bytes, { user = member, contentType = 'image/jpeg' } = {}) =>
  fetch(`${server.baseUrl}/api/users/me/food-log/meals/${meal}/image`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, Authorization: `Bearer ${tokenFor(user)}` },
    body: bytes,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
/** Uploads [bytes] for [meal] and returns the reference a submission sends. */
const photo = async (meal, fill, user = member) => {
  const res = await upload(meal, jpeg(fill), { user });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.image;
};
const food = (entryId, f, qty) => ({ entryId, foodId: String(f._id), qty });
const stored = () => FoodLog.findOne({ clientId: member._id }).lean();
const mealOf = (log, n) => log.meals.find((m) => m.meal === n);

before(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ggf-food-log-'));
  env.storage.localRoot = uploadRoot;
  resetStorage();
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  member = await seedUser('Chethan');
  other = await seedUser('Bob');
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 113, fat: 3.5, carbs: 19, protein: 2 });
  whey = await Food.create({ name: 'Whey', foodType: 'Vegetarian', servingUnit: 'Scoop', servingQuantity: 1, calories: 120, fat: 2, carbs: 7, protein: 24 });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

test('uploading a photo stores the file only - the log is saved with the submission', async () => {
  const image = await photo(1, 1);
  const folder = `food-logs/${member._id}/${businessDayOf(new Date())}/meal-1`;
  assert.match(image.storageKey, new RegExp(`^${folder}/[0-9a-f]{32}\\.jpg$`));
  assert.ok(image.url.endsWith(`/uploads/${image.storageKey}`));
  await fs.access(path.join(uploadRoot, image.storageKey));
  assert.equal(await FoodLog.countDocuments(), 0, 'nothing in the database yet');

  // The same photo again (a retry) is the same file, not a second one.
  assert.deepEqual(await photo(1, 1), image);
  assert.equal((await fs.readdir(path.join(uploadRoot, folder))).length, 1);
});

test('one photo per meal, each meal its own, all in the day\'s one document', async () => {
  const one = await photo(1, 1);
  const two = await photo(2, 2);
  const res = await put({
    meals: [
      { meal: 1, image: { storageKey: one.storageKey, url: 'https://evil.example/x.jpg' }, foods: [food('a', rice, 100), food('b', whey, 1)] },
      { meal: 2, image: two, foods: [food('c', rice, 50)] },
      { meal: 3, image: null, foods: [food('d', whey, 1)] },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const log = res.body.data.foodLog;
  assert.deepEqual(mealOf(log, 1).image, one, 'the server\'s URL, not the one sent');
  assert.deepEqual(mealOf(log, 2).image, two);
  assert.equal(mealOf(log, 3).image, null);
  assert.deepEqual(mealOf(log, 1).foods.map((f) => f.entryId), ['a', 'b']);
  assert.ok(!('entries' in mealOf(log, 1)), 'responses say foods');

  const doc = await stored();
  assert.equal(await FoodLog.countDocuments(), 1);
  assert.deepEqual(doc.meals.map((m) => [m.meal, m.image?.storageKey ?? null]), [[1, one.storageKey], [2, two.storageKey], [3, null]]);
  assert.ok(doc.meals.every((m) => Array.isArray(m.foods) && !('entries' in m)), 'stored as foods only');
});

test('replace, keep when left out, remove with null - totals never move', async () => {
  const first = await photo(1, 1);
  await put({ meals: [{ meal: 1, image: first, foods: [food('a', rice, 100)] }, { meal: 2, image: await photo(2, 2), foods: [food('b', whey, 1)] }] });
  const totals = (await stored()).consumed;

  // Replace Meal 1's photo.
  const second = await photo(1, 3);
  let log = (await put({ meals: [{ meal: 1, image: second, foods: [food('a', rice, 100)] }, { meal: 2, foods: [food('b', whey, 1)] }] })).body.data.foodLog;
  assert.equal(mealOf(log, 1).image.storageKey, second.storageKey);
  assert.ok(mealOf(log, 2).image, 'left out: Meal 2 keeps its photo');
  assert.deepEqual((await stored()).consumed, totals);

  // A food-only edit (the app sends each meal's photo as it holds it).
  log = (await put({ meals: [{ meal: 1, image: second, foods: [food('a', rice, 200)] }, { meal: 2, image: mealOf(log, 2).image, foods: [food('b', whey, 1)] }] })).body.data.foodLog;
  assert.equal(mealOf(log, 1).image.storageKey, second.storageKey);
  assert.equal(mealOf(log, 1).foods[0].qty, 200);

  // Removed.
  log = (await put({ meals: [{ meal: 1, image: null, foods: [food('a', rice, 200)] }, { meal: 2, foods: [food('b', whey, 1)] }] })).body.data.foodLog;
  assert.equal(mealOf(log, 1).image, null);
  assert.ok(mealOf(log, 2).image);
  assert.equal(await FoodLog.countDocuments(), 1);
  // The replaced file is never deleted: nothing a log may point at is lost.
  await fs.access(path.join(uploadRoot, first.storageKey));
});

test('only this member\'s own upload, for this meal and today, is accepted', async () => {
  const mine = await photo(1, 1);
  const theirs = await photo(1, 4, other);
  const day = businessDayOf(new Date());
  for (const image of [
    theirs, // another member's
    await photo(2, 5), // another meal's
    { storageKey: mine.storageKey.replace(day, '2020-01-01') }, // another day's
    { storageKey: `food-logs/${member._id}/${day}/meal-1/${'a'.repeat(32)}.jpg` }, // never uploaded
    { storageKey: '../../etc/passwd' },
    { url: mine.url }, // a URL is not a reference
    'abc',
  ]) {
    const res = await put({ meals: [{ meal: 1, image, foods: [food('a', rice, 100)] }] });
    assert.equal(res.status, 400, JSON.stringify(image));
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(await FoodLog.countDocuments(), 0, 'nothing saved by a refused submission');
});

test('uploads take real images only, for meals 1 to 8, signed in', async () => {
  assert.equal((await upload(1, Buffer.from('not an image at all'))).status, 400);
  assert.equal((await upload(9, jpeg())).status, 400);
  assert.equal((await upload('x', jpeg())).status, 400);
  const anonymous = await fetch(`${server.baseUrl}/api/users/me/food-log/meals/1/image`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg() });
  assert.equal(anonymous.status, 401);
});

test('a save that fails after the upload can be retried with the same photo', async () => {
  const image = await photo(1, 1);
  const archived = await Food.create({ name: 'Gone', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 1, fat: 0, carbs: 0, protein: 0, status: 'archived' });
  const failed = await put({ meals: [{ meal: 1, image, foods: [food('a', archived, 100)] }] });
  assert.equal(failed.status, 400);
  assert.equal(await FoodLog.countDocuments(), 0);

  const res = await put({ meals: [{ meal: 1, image, foods: [food('a', rice, 100)] }] });
  assert.equal(res.status, 200);
  assert.equal(mealOf(res.body.data.foodLog, 1).image.storageKey, image.storageKey);
  assert.equal(await FoodLog.countDocuments(), 1);
});

test('an older app sending entries still saves - as foods', async () => {
  const res = await put({ meals: [{ meal: 1, entries: [food('a', rice, 100)] }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(mealOf(res.body.data.foodLog, 1).foods.map((f) => f.entryId), ['a']);
  const doc = await stored();
  assert.deepEqual(doc.meals[0].foods.map((f) => f.entryId), ['a']);
  assert.ok(!('entries' in doc.meals[0]));
});

test('logs saved as entries read as foods, counted once, and update into foods', async () => {
  const today = businessDayOf(new Date());
  const snapshot = (entryId, qty) => ({ entryId, foodId: rice._id, foodName: 'Rice', qty, portion: 100, servingUnit: 'Grams', calories: 113, fat: 3.5, carbs: 19, protein: 2 });
  await FoodLog.collection.insertOne({
    clientId: member._id, logDate: today, timezone: 'Asia/Kolkata', status: 'open', submittedAt: new Date(),
    consumed: { calories: 113, fat: 3.5, carbs: 19, protein: 2 },
    meals: [{ meal: 1, entries: [snapshot('old-1', 100)] }],
  });
  await FoodLog.collection.insertOne({
    clientId: member._id, logDate: '2026-01-01', timezone: 'Asia/Kolkata', status: 'open', submittedAt: new Date(),
    consumed: { calories: 113, fat: 3.5, carbs: 19, protein: 2 },
    // Both names on one meal: read once, never added together.
    meals: [{ meal: 1, foods: [snapshot('new-1', 100)], entries: [snapshot('new-1', 100)] }],
  });

  const day = (await getFoodLogForDay(member._id)).foodLog;
  assert.deepEqual(mealOf(day, 1).foods.map((f) => f.entryId), ['old-1']);
  assert.equal(mealOf(day, 1).image, null);
  const both = (await getFoodLogForDay(member._id, { date: '2026-01-01' })).foodLog;
  assert.deepEqual(mealOf(both, 1).foods.map((f) => f.entryId), ['new-1']);
  const history = (await getFoodLogHistory(member._id)).items;
  assert.deepEqual(history.map((i) => [i.date, i.foodsLogged]), [[today, 1], ['2026-01-01', 1]]);

  // Resubmitted: the old entry keeps its snapshot, now under foods only.
  await Food.updateOne({ _id: rice._id }, { $set: { calories: 999 } });
  const log = (await put({ meals: [{ meal: 1, foods: [food('old-1', rice, 100), food('x', whey, 1)] }] })).body.data.foodLog;
  assert.equal(log.consumed.calories, 233, '113 kept + 120 - no double count');
  const doc = await FoodLog.findOne({ clientId: member._id, logDate: today }).lean();
  assert.ok(!('entries' in doc.meals[0]));
  assert.equal(doc.meals[0].foods[0].calories, 113);
});

test('a past day keeps its photos when today is saved', async () => {
  const noon16 = new Date('2026-10-16T06:30:00.000Z');
  const { image } = await uploadFoodLogMealImage(member._id, 1, jpeg(7), { now: noon16 });
  await submitFoodLog(member._id, { meals: [{ meal: 1, image, foods: [food('a', rice, 100)] }], memberGoal: null, day: null }, { now: noon16 });

  await put({ meals: [{ meal: 1, image: await photo(1, 8), foods: [food('b', rice, 100)] }] });
  const past = (await getFoodLogForDay(member._id, { date: '2026-10-16' })).foodLog;
  assert.equal(mealOf(past, 1).image.storageKey, image.storageKey);
  // History stays light: totals, no meals or photos.
  const item = (await getFoodLogHistory(member._id)).items.find((i) => i.date === '2026-10-16');
  assert.ok(!('meals' in item));
});
