import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import User from '../../src/models/user.model.js';
import Food from '../../src/models/food.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * GET /api/admin/foods?sort=calories:desc,protein:desc,fat:asc,carbs:desc -
 * the Food Database's multi-level nutrition sort. Rules apply in priority
 * order: each later rule only orders foods every earlier rule left tied.
 */
let server;
let adminToken;
let memberToken;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const seedUser = (phone, roles) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: phone }, roles, status: 'active' });

const seed = (name, { calories, protein, fat, carbs }, overrides = {}) =>
  Food.create({
    name,
    foodType: 'Vegetarian',
    brand: null,
    servingUnit: 'Grams',
    servingQuantity: 100,
    calories,
    protein,
    fat,
    carbs,
    ...overrides,
  });

const list = (qs = '', token = adminToken) => server.request('GET', `/api/admin/foods${qs}`, { token });
const names = (res) => {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.foods.map((f) => f.name);
};

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  adminToken = tokenFor(await seedUser('918000000000', ['user', 'admin']));
  memberToken = tokenFor(await seedUser('919000000001', ['user', 'client']));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('every metric sorts numerically both ways', async () => {
  // A text sort would put 100 before 9 and 12 before 2.5.
  await seed('A', { calories: 9, protein: 2.5, fat: 12, carbs: 100 });
  await seed('B', { calories: 100, protein: 12, fat: 2.5, carbs: 9 });
  await seed('C', { calories: 10, protein: 2.75, fat: 10, carbs: 10 });
  const asc = { calories: ['A', 'C', 'B'], protein: ['A', 'C', 'B'], fat: ['B', 'C', 'A'], carbs: ['B', 'C', 'A'] };
  for (const [metric, order] of Object.entries(asc)) {
    assert.deepEqual(names(await list(`?sort=${metric}:asc`)), order, `${metric} asc`);
    assert.deepEqual(names(await list(`?sort=${metric}:desc`)), [...order].reverse(), `${metric} desc`);
  }
});

test('later rules only break the ties of earlier ones (examples A-D)', async () => {
  await seed('P', { calories: 200, protein: 10, fat: 5, carbs: 30 });
  await seed('Q', { calories: 200, protein: 20, fat: 9, carbs: 10 });
  await seed('R', { calories: 200, protein: 20, fat: 3, carbs: 10 });
  await seed('S', { calories: 200, protein: 20, fat: 3, carbs: 50 });
  await seed('T', { calories: 300, protein: 1, fat: 1, carbs: 1 });
  await seed('U', { calories: 100, protein: 99, fat: 99, carbs: 99 });

  // A: calories desc, protein desc - T first on calories alone, never on protein.
  assert.deepEqual(names(await list('?sort=calories:desc,protein:desc')), ['T', 'Q', 'R', 'S', 'P', 'U']);
  // B: + fat asc orders Q/R/S, which tie on calories and protein.
  assert.deepEqual(names(await list('?sort=calories:desc,protein:desc,fat:asc')), ['T', 'R', 'S', 'Q', 'P', 'U']);
  // C: + carbs desc orders R/S, which tie on all three.
  assert.deepEqual(
    names(await list('?sort=calories:desc,protein:desc,fat:asc,carbs:desc')),
    ['T', 'S', 'R', 'Q', 'P', 'U'],
  );
  // D: calories asc, fat desc.
  assert.deepEqual(names(await list('?sort=calories:asc,fat:desc')), ['U', 'Q', 'P', 'R', 'S', 'T']);
  // Priority is the order given, not a fixed metric order.
  assert.deepEqual(names(await list('?sort=protein:desc,calories:desc')), ['U', 'Q', 'R', 'S', 'P', 'T']);
});

test('E: all rule values equal - the list sort, then _id, decide, and pages never repeat', async () => {
  const same = { calories: 50, protein: 5, fat: 5, carbs: 5 };
  for (const name of ['Delta', 'Alpha', 'Charlie', 'Bravo']) await seed(name, same);

  // Default list sort (name A-Z) breaks the tie.
  assert.deepEqual(names(await list('?sort=calories:desc,protein:desc')), ['Alpha', 'Bravo', 'Charlie', 'Delta']);
  // The Name control still applies within ties.
  assert.deepEqual(names(await list('?sort=calories:desc&sortKey=name&sortDir=desc')), ['Delta', 'Charlie', 'Bravo', 'Alpha']);

  // Identical foods (same name too): _id keeps one fixed order across pages.
  await Food.deleteMany({});
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(String((await seed('Twin', same))._id));
  const seen = [];
  for (const page of [1, 2, 3]) {
    const res = await list(`?sort=fat:asc&pageSize=2&page=${page}`);
    seen.push(...res.body.data.foods.map((f) => f.id));
  }
  assert.deepEqual(seen, [...ids].sort());
});

test('a list sort on a rule metric never overrides that rule\'s direction', async () => {
  await seed('Low', { calories: 10, protein: 1, fat: 1, carbs: 1 });
  await seed('High', { calories: 90, protein: 1, fat: 1, carbs: 1 });
  assert.deepEqual(names(await list('?sort=calories:desc&sortKey=calories&sortDir=asc')), ['High', 'Low']);
});

test('a food missing a value sorts last in both directions', async () => {
  await seed('Has 5', { calories: 5, protein: 1, fat: 1, carbs: 1 });
  await seed('Has 50', { calories: 50, protein: 1, fat: 1, carbs: 1 });
  // The schema requires the numbers; a bad legacy write could still lack one.
  await Food.collection.insertOne({ name: 'No calories', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, protein: 1, fat: 1, carbs: 1, status: 'active' });
  await Food.collection.insertOne({ name: 'Null calories', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: null, protein: 1, fat: 1, carbs: 1, status: 'active' });

  const asc = names(await list('?sort=calories:asc'));
  const desc = names(await list('?sort=calories:desc'));
  assert.deepEqual(asc.slice(0, 2), ['Has 5', 'Has 50']);
  assert.deepEqual(desc.slice(0, 2), ['Has 50', 'Has 5']);
  assert.deepEqual(asc.slice(2).sort(), ['No calories', 'Null calories']);
  assert.deepEqual(desc.slice(2).sort(), ['No calories', 'Null calories']);
});

test('search, food type, unit and status filter before the sort, and the total counts matches', async () => {
  await seed('Chicken breast', { calories: 165, protein: 31, fat: 4, carbs: 0 }, { foodType: 'Non-Vegetarian' });
  await seed('Chicken curry', { calories: 240, protein: 20, fat: 15, carbs: 8 }, { foodType: 'Non-Vegetarian' });
  await seed('Chicken soup', { calories: 90, protein: 31, fat: 2, carbs: 6 }, { foodType: 'Non-Vegetarian', servingUnit: 'ML' });
  await seed('Paneer', { calories: 300, protein: 40, fat: 20, carbs: 4 });
  await seed('Archived chicken', { calories: 999, protein: 99, fat: 1, carbs: 1 }, { foodType: 'Non-Vegetarian', status: 'archived' });

  const res = await list('?search=chicken&foodType=Non-Vegetarian&sort=protein:desc,fat:asc');
  assert.deepEqual(names(res), ['Chicken soup', 'Chicken breast', 'Chicken curry']);
  assert.equal(res.body.data.pagination.total, 3);

  assert.deepEqual(names(await list('?search=chicken&unit=Grams&sort=calories:asc')), ['Chicken breast', 'Chicken curry']);
  assert.deepEqual(names(await list('?status=archived&sort=calories:desc')), ['Archived chicken']);
});

test('sorted across the whole result before paging, in the existing response shape', async () => {
  for (let i = 0; i < 25; i += 1) await seed(`F${i}`, { calories: (i * 7) % 25, protein: i % 3, fat: 1, carbs: 1 });

  const all = [];
  for (const page of [1, 2, 3]) {
    const res = await list(`?sort=calories:desc,protein:asc&page=${page}&pageSize=10`);
    assert.deepEqual(res.body.data.pagination, { page, pageSize: 10, total: 25, totalPages: 3 });
    all.push(...res.body.data.foods);
  }
  assert.equal(new Set(all.map((f) => f.id)).size, 25, 'no food on two pages');
  const sorted = [...all].sort((a, b) => b.calories - a.calories || a.protein - b.protein);
  assert.deepEqual(all.map((f) => [f.calories, f.protein]), sorted.map((f) => [f.calories, f.protein]));
  // Rows are the list's own allow-listed rows - no sort helper fields leak out.
  assert.ok(!Object.keys(all[0]).some((k) => k.startsWith('_')));
});

test('invalid rules are a 400 VALIDATION_ERROR, never a partial sort', async () => {
  await seed('Any', { calories: 1, protein: 1, fat: 1, carbs: 1 });
  for (const [qs, message] of [
    ['?sort=calories:desc,calories:asc', /more than once/],
    ['?sort=calories:desc,protein:desc,fat:asc,carbs:desc,calories:asc', /at most 4 rules/],
    ['?sort=name:asc', /metric must be one of/],
    ['?sort=legacy.foodId:asc', /metric must be one of/],
    ['?sort=calories:sideways', /direction must be one of/],
    ['?sort=calories', /metric:direction/],
    ['?sort=calories:desc:1', /metric:direction/],
    ['?sort=calories:desc,', /metric:direction/],
    ['?sort=', /comma-separated list/],
    ['?sort=calories:desc&sort=protein:asc', /comma-separated list/],
    ['?sort=' + encodeURIComponent('{"calories":-1}'), /metric/],
  ]) {
    const res = await list(qs);
    assert.equal(res.status, 400, qs);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR', qs);
    assert.match(res.body.error.message, message, qs);
  }
});

test('still admin only', async () => {
  assert.equal((await list('?sort=calories:desc', memberToken)).status, 403);
  assert.equal((await server.request('GET', '/api/admin/foods?sort=calories:desc', {})).status, 401);
});

test('no sort parameter: the existing single-field sort is unchanged', async () => {
  await seed('Banana', { calories: 89, protein: 1, fat: 0, carbs: 23 });
  await seed('Apple', { calories: 52, protein: 0, fat: 0, carbs: 14 });
  assert.deepEqual(names(await list()), ['Apple', 'Banana']);
  assert.deepEqual(names(await list('?sortKey=calories&sortDir=desc')), ['Banana', 'Apple']);
});
