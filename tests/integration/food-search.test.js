import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Food from '../../src/models/food.model.js';
import User from '../../src/models/user.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Food List search finds a food by any word of its name (brackets
 * included), brand or comments - every word, in any order, case-insensitive,
 * partial words included - for members (GET /api/foods) and the admin list
 * (GET /api/admin/foods) alike. Active foods only; filters, paging kept.
 */
let server;
let memberToken;
let adminToken;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const seedUser = (phone, roles) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: phone }, roles, status: 'active' });
const food = (o) =>
  Food.create({ foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 100, fat: 1, carbs: 2, protein: 3, ...o });
const names = async (qs, path = '/api/foods', token = memberToken) => {
  const res = await server.request('GET', `${path}${qs}`, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.foods.map((f) => f.name);
};
const search = (q, extra = '') => names(`?search=${encodeURIComponent(q)}${extra}`);

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  memberToken = tokenFor(await seedUser('919100000101', ['user', 'client']));
  adminToken = tokenFor(await seedUser('919100000102', ['user', 'admin']));
  await food({ name: 'Paneer (Low Fat)', brand: 'Amul', notes: 'High protein, no added sugar' }); // Food A
  await food({ name: 'Greek Yogurt [Plain]', brand: 'Epigamia', notes: 'Unsweetened, high protein' }); // Food B
  await food({ name: 'Chicken Breast', foodType: 'Non-Vegetarian', brand: null, notes: 'High protein, grilled' });
  await food({ name: 'Old Paneer (Low Fat)', brand: 'Amul', notes: 'High protein', status: 'archived' });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('each field finds its food: name, bracket text, brand and comments', async () => {
  assert.deepEqual(await search('low fat'), ['Paneer (Low Fat)']);
  assert.deepEqual(await search('amul'), ['Paneer (Low Fat)']);
  assert.deepEqual(await search('no added sugar'), ['Paneer (Low Fat)']);
  assert.deepEqual(await search('plain'), ['Greek Yogurt [Plain]']);
  assert.deepEqual(await search('epigamia'), ['Greek Yogurt [Plain]']);
  assert.deepEqual(await search('unsweetened'), ['Greek Yogurt [Plain]']);
  assert.deepEqual(await search('high protein'), ['Chicken Breast', 'Greek Yogurt [Plain]', 'Paneer (Low Fat)']);
});

test('multi-word: every word, anywhere, in any order - across fields', async () => {
  assert.deepEqual(await search('paneer low fat'), ['Paneer (Low Fat)']);
  assert.deepEqual(await search('greek plain'), ['Greek Yogurt [Plain]']);
  assert.deepEqual(await search('amul paneer'), ['Paneer (Low Fat)']);
  assert.deepEqual(await search('fat low paneer'), ['Paneer (Low Fat)']);
  assert.deepEqual(await search('greek sugar'), [], 'every word must be present - not too broad');
});

test('case, partial words, punctuation, brackets, regex characters and spaces', async () => {
  for (const q of ['LOW FAT', 'Low Fat', 'lOw fAt']) assert.deepEqual(await search(q), ['Paneer (Low Fat)'], q);
  assert.deepEqual(await search('pane'), ['Paneer (Low Fat)'], 'partial word');
  assert.deepEqual(await search('epiga'), ['Greek Yogurt [Plain]']);
  assert.deepEqual(await search('(Low-Fat)'), ['Paneer (Low Fat)']);
  assert.deepEqual(await search('[plain]'), ['Greek Yogurt [Plain]']);
  assert.deepEqual(await search('   paneer    low   '), ['Paneer (Low Fat)']);
  assert.deepEqual(await search('no, added; sugar!'), ['Paneer (Low Fat)']);
  assert.deepEqual(await search('.*'), ['Chicken Breast', 'Greek Yogurt [Plain]', 'Paneer (Low Fat)'], 'regex input is no search, never a pattern');
});

test('empty search and cleared search return the whole active list; archived never appears', async () => {
  const all = ['Chicken Breast', 'Greek Yogurt [Plain]', 'Paneer (Low Fat)'];
  assert.deepEqual(await names(''), all);
  assert.deepEqual(await search(''), all);
  assert.deepEqual(await search('   '), all);
  assert.ok(!(await search('old paneer')).length, 'archived food is never found');
});

test('Veg / Non-Veg filters, paging and the admin list keep working with search', async () => {
  assert.deepEqual(await search('high protein', '&foodType=Vegetarian'), ['Greek Yogurt [Plain]', 'Paneer (Low Fat)']);
  assert.deepEqual(await search('high protein', '&foodType=Non-Vegetarian'), ['Chicken Breast']);
  const page = await server.request('GET', '/api/foods?search=protein&pageSize=2&page=2', { token: memberToken });
  assert.deepEqual(page.body.data.foods.map((f) => f.name), ['Paneer (Low Fat)']);
  assert.equal(page.body.data.pagination.total, 3);
  // The admin portal's list: the same search.
  assert.deepEqual(await names('?search=no%20added%20sugar', '/api/admin/foods', adminToken), ['Paneer (Low Fat)']);
});
