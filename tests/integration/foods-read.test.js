import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Food from '../../src/models/food.model.js';
import User from '../../src/models/user.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * GET /api/foods - the canonical Food database, read-only, for any signed-in
 * user (the coach's Add to Meal, the member's Add Food). The admin list's own
 * query and rows, active foods only, no writes.
 */
let server;
let memberToken;
let coachToken;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const seedUser = (phone, roles) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: phone }, roles, status: 'active' });

let seq = 0;
const seedFood = (overrides = {}) => {
  seq += 1;
  return Food.create({
    name: `Food ${String(seq).padStart(3, '0')}`,
    foodType: 'Vegetarian',
    brand: null,
    servingUnit: 'Grams',
    servingQuantity: 100,
    calories: 100,
    fat: 1,
    carbs: 2,
    protein: 3,
    ...overrides,
  });
};

const foods = (qs = '', token = memberToken) => server.request('GET', `/api/foods${qs}`, { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  seq = 0;
  memberToken = tokenFor(await seedUser('919100000001', ['user', 'client']));
  coachToken = tokenFor(await seedUser('919100000002', ['user', 'coach']));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('any signed-in user can read it; no token is 401', async () => {
  await seedFood();

  assert.equal((await foods('', memberToken)).status, 200);
  assert.equal((await foods('', coachToken)).status, 200);
  assert.equal((await server.request('GET', '/api/foods')).status, 401);
});

test('paged on the server, in the admin list\'s shape and rows', async () => {
  for (let i = 0; i < 25; i += 1) await seedFood();

  const res = await foods('?page=2&pageSize=10');

  assert.deepEqual(res.body.data.pagination, { page: 2, pageSize: 10, total: 25, totalPages: 3 });
  assert.equal(res.body.data.foods.length, 10);
  const [row] = res.body.data.foods;
  assert.equal(row.name, 'Food 011', 'name order, as the admin list');
  for (const key of ['id', 'name', 'foodType', 'brand', 'servingUnit', 'servingQuantity', 'calories', 'fat', 'carbs', 'protein', 'image']) {
    assert.ok(key in row, key);
  }
});

test('search (name or brand) and foodType filter run on the server', async () => {
  await seedFood({ name: 'Grilled Chicken', foodType: 'Non-Vegetarian' });
  await seedFood({ name: 'Paneer', brand: 'Chicken Farm Dairy' });
  await seedFood({ name: 'Oats' });

  const byName = await foods('?search=chicken');
  const veg = await foods('?foodType=Vegetarian');
  const nonVegChicken = await foods('?search=chicken&foodType=Non-Vegetarian');

  assert.equal(byName.body.data.pagination.total, 2);
  assert.deepEqual(veg.body.data.foods.map((f) => f.name), ['Oats', 'Paneer']);
  assert.deepEqual(nonVegChicken.body.data.foods.map((f) => f.name), ['Grilled Chicken']);
});

test('archived foods are never listed, even when asked for', async () => {
  await seedFood({ name: 'Live' });
  await seedFood({ name: 'Gone', status: 'archived' });

  const all = await foods();
  const asked = await foods('?status=archived');

  assert.deepEqual(all.body.data.foods.map((f) => f.name), ['Live']);
  assert.deepEqual(asked.body.data.foods.map((f) => f.name), ['Live']);
});

test('the page size is capped, and a bad query is a 400', async () => {
  await seedFood();

  assert.equal((await foods('?pageSize=5000')).body.data.pagination.pageSize, 100);
  assert.equal((await foods('?page=0')).status, 400);
  assert.equal((await foods('?foodType=Egg')).status, 400);
});

test('read-only: there is no write route, and reading changes nothing', async () => {
  const food = await seedFood();
  const before = await Food.find().lean();

  await foods();
  assert.equal((await server.request('POST', '/api/foods', { token: memberToken, body: { name: 'x' } })).status, 404);
  assert.equal((await server.request('DELETE', `/api/foods/${food._id}`, { token: memberToken })).status, 404);

  assert.deepEqual(await Food.find().lean(), before);
});

// --- Sorting: ?sortBy=calories|fat|carbs|protein&sortOrder=asc|desc ---------

const names = (res) => res.body.data.foods.map((f) => f.name);

test('each nutrient sorts numerically both ways, decimals included', async () => {
  // Values chosen so a text sort would differ: 9 < 10 < 100, 2.5 < 2.75 < 12.
  await seedFood({ name: 'A', calories: 100, fat: 2.75, carbs: 9, protein: 12 });
  await seedFood({ name: 'B', calories: 9, fat: 12, carbs: 100, protein: 2.5 });
  await seedFood({ name: 'C', calories: 10, fat: 2.5, carbs: 10.5, protein: 100 });

  const expected = {
    calories: ['B', 'C', 'A'],
    fat: ['C', 'A', 'B'],
    carbs: ['A', 'C', 'B'],
    protein: ['B', 'A', 'C'],
  };
  for (const [field, asc] of Object.entries(expected)) {
    assert.deepEqual(names(await foods(`?sortBy=${field}&sortOrder=asc`)), asc, `${field} asc`);
    assert.deepEqual(names(await foods(`?sortBy=${field}&sortOrder=desc`)), [...asc].reverse(), `${field} desc`);
  }
  // sortBy alone is ascending.
  assert.deepEqual(names(await foods('?sortBy=calories')), expected.calories);
});

test('sorted before paging: pages run on with no duplicates, equal values stable', async () => {
  // 25 foods, protein in 5 groups of equal values.
  for (let i = 0; i < 25; i += 1) await seedFood({ protein: i % 5 });

  const seen = [];
  const proteins = [];
  for (let page = 1; page <= 3; page += 1) {
    const res = await foods(`?sortBy=protein&sortOrder=desc&page=${page}&pageSize=10`);
    assert.equal(res.body.data.pagination.total, 25);
    seen.push(...res.body.data.foods.map((f) => f.id));
    proteins.push(...res.body.data.foods.map((f) => f.protein));
  }
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25, 'no food on two pages');
  assert.deepEqual(proteins, [...proteins].sort((a, b) => b - a), 'whole catalogue in order');

  // The same request twice gives the same order (the _id tie-break).
  const again = [];
  for (let page = 1; page <= 3; page += 1) {
    const res = await foods(`?sortBy=protein&sortOrder=desc&page=${page}&pageSize=10`);
    again.push(...res.body.data.foods.map((f) => f.id));
  }
  assert.deepEqual(again, seen);
});

test('sorting keeps search, foodType and the active-only rule', async () => {
  await seedFood({ name: 'Chicken Breast', foodType: 'Non-Vegetarian', protein: 31 });
  await seedFood({ name: 'Chicken Curry', foodType: 'Non-Vegetarian', protein: 18 });
  await seedFood({ name: 'Chicken Soup Mix', protein: 5 });
  await seedFood({ name: 'Chicken Archived', foodType: 'Non-Vegetarian', protein: 99, status: 'archived' });
  await seedFood({ name: 'Paneer', protein: 21 });

  const res = await foods('?search=chicken&foodType=Non-Vegetarian&sortBy=protein&sortOrder=desc');

  assert.deepEqual(names(res), ['Chicken Breast', 'Chicken Curry']);
  assert.deepEqual(res.body.data.pagination, { page: 1, pageSize: 25, total: 2, totalPages: 1 });
});

test('no sort parameters: name A-Z as before', async () => {
  await seedFood({ name: 'Zucchini', calories: 1 });
  await seedFood({ name: 'Almonds', calories: 600 });

  assert.deepEqual(names(await foods()), ['Almonds', 'Zucchini']);
});

test('a bad sortBy or sortOrder is a 400', async () => {
  await seedFood();

  for (const qs of [
    '?sortBy=name', // a field members cannot sort by
    '?sortBy=legacyFoodId',
    '?sortBy=calories;drop',
    '?sortBy=calories&sortOrder=sideways',
    '?sortOrder=desc', // nothing to order
  ]) {
    const res = await foods(qs);
    assert.equal(res.status, 400, qs);
    assert.equal(res.body.success, false, qs);
  }
});
