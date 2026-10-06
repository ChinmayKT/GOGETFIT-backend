import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import User from '../../src/models/user.model.js';
import Food from '../../src/models/food.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let adminToken;
let admin;
let memberToken;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const seedUser = (phone, roles) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: phone }, roles, status: 'active' });

const validFood = (overrides = {}) => ({
  name: 'Paneer Cubes',
  foodType: 'Vegetarian',
  brand: 'Farm Fresh',
  servingUnit: 'Grams',
  servingQuantity: 100,
  calories: 114,
  fat: 2.6,
  carbs: 0,
  protein: 21,
  notes: 'High protein',
  ...overrides,
});

/** A migrated food, written straight to the collection as the migration would. */
const seedMigratedFood = (foodId, overrides = {}) =>
  Food.create({
    name: `Legacy food ${foodId}`,
    foodType: 'Vegetarian',
    brand: null,
    servingUnit: 'Grams',
    servingQuantity: 100,
    calories: 100,
    fat: 1,
    carbs: 2,
    protein: 3,
    notes: null,
    image: null,
    legacy: { source: 'gogetfit', foodId },
    migration: { runId: 'foods-test', migratedAt: new Date(), version: 1 },
    ...overrides,
  });

const flat = (food) => ({
  servingUnit: food.servingUnit,
  servingQuantity: food.servingQuantity,
  calories: food.calories,
  fat: food.fat,
  carbs: food.carbs,
  protein: food.protein,
});

const create = (body, token = adminToken) => server.request('POST', '/api/admin/foods', { token, body });
const list = (qs = '', token = adminToken) => server.request('GET', `/api/admin/foods${qs}`, { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  admin = await seedUser('918000000000', ['user', 'admin']);
  adminToken = tokenFor(admin);
  memberToken = tokenFor(await seedUser('919000000001', ['user', 'client']));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// ─── authorization ───────────────────────────────────────────────────────────

test('every food endpoint requires authentication', async () => {
  const food = await seedMigratedFood(1);
  const id = String(food._id);

  for (const [method, path] of [
    ['GET', '/api/admin/foods'],
    ['POST', '/api/admin/foods'],
    ['GET', `/api/admin/foods/${id}`],
    ['PUT', `/api/admin/foods/${id}`],
    ['PATCH', `/api/admin/foods/${id}`],
    ['DELETE', `/api/admin/foods/${id}`],
  ]) {
    const res = await server.request(method, path, {});
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('a signed-in non-admin is refused with 403', async () => {
  const res = await list('', memberToken);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');

  const created = await create(validFood(), memberToken);
  assert.equal(created.status, 403);
  assert.equal(await Food.countDocuments(), 0);
});

// ─── list, pagination, search, filters, sorting ──────────────────────────────

test('the list is paginated in MongoDB, never in the browser', async () => {
  for (let i = 1; i <= 25; i += 1) await seedMigratedFood(i, { name: `Food ${String(i).padStart(2, '0')}` });

  const first = await list('?page=1&pageSize=10');
  assert.equal(first.status, 200);
  assert.equal(first.body.data.foods.length, 10);
  assert.deepEqual(first.body.data.pagination, { page: 1, pageSize: 10, total: 25, totalPages: 3 });

  const last = await list('?page=3&pageSize=10');
  assert.equal(last.body.data.foods.length, 5);

  // The alias the task's examples use works too.
  const aliased = await list('?page=1&limit=10');
  assert.equal(aliased.body.data.foods.length, 10);
});

test('page size is capped so one request cannot pull the whole collection', async () => {
  await seedMigratedFood(1);
  const res = await list('?pageSize=5000');
  assert.equal(res.body.data.pagination.pageSize, 100);
});

test('search matches name and brand, case-insensitively, across the collection', async () => {
  await seedMigratedFood(1, { name: 'Toned Milk', brand: 'Amul' });
  await seedMigratedFood(2, { name: 'Paneer', brand: 'Milky Mist' });
  await seedMigratedFood(3, { name: 'Brown Rice', brand: null });

  const byName = await list('?search=milk');
  assert.deepEqual(byName.body.data.foods.map((f) => f.name).sort(), ['Paneer', 'Toned Milk']);
  assert.equal(byName.body.data.pagination.total, 2);

  const upper = await list('?search=MILKY');
  assert.deepEqual(upper.body.data.foods.map((f) => f.name), ['Paneer']);

  // Search is not applied to the current page only: page 2 of a 1-per-page
  // search still reports the full match count.
  const paged = await list('?search=milk&pageSize=1&page=2');
  assert.equal(paged.body.data.pagination.total, 2);
  assert.equal(paged.body.data.foods.length, 1);
});

test('regex metacharacters in the search term are escaped, not executed', async () => {
  await seedMigratedFood(1, { name: 'Rice (Cooked)' });
  await seedMigratedFood(2, { name: 'Rice Cooked' });

  const res = await list('?search=' + encodeURIComponent('(Cooked)'));
  assert.deepEqual(res.body.data.foods.map((f) => f.name), ['Rice (Cooked)']);
});

test('food type and unit filters use the new vocabulary and run server-side', async () => {
  await seedMigratedFood(1, { name: 'Chicken', foodType: 'Non-Vegetarian', servingUnit: 'Grams', servingQuantity: 100 });
  await seedMigratedFood(2, { name: 'Milk', foodType: 'Vegetarian', servingUnit: 'ML', servingQuantity: 200 });
  await seedMigratedFood(3, { name: 'Roti', foodType: 'Vegetarian', servingUnit: 'Piece', servingQuantity: 1 });

  const veg = await list('?foodType=Vegetarian');
  assert.equal(veg.body.data.pagination.total, 2);

  const ml = await list('?unit=ML');
  assert.deepEqual(ml.body.data.foods.map((f) => f.name), ['Milk']);

  const both = await list('?foodType=Vegetarian&unit=Piece');
  assert.deepEqual(both.body.data.foods.map((f) => f.name), ['Roti']);

  // Legacy spellings are not a vocabulary this API knows.
  const legacyValue = await list('?foodType=Veg.');
  assert.equal(legacyValue.status, 400);
  assert.equal(legacyValue.body.error.code, 'VALIDATION_ERROR');
});

test('sorting is allow-listed; newest, oldest and name order all work', async () => {
  const a = await seedMigratedFood(1, { name: 'Apple' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const z = await seedMigratedFood(2, { name: 'Zucchini' });

  const az = await list('?sortKey=name&sortDir=asc');
  assert.deepEqual(az.body.data.foods.map((f) => f.name), ['Apple', 'Zucchini']);

  const za = await list('?sortKey=name&sortDir=desc');
  assert.deepEqual(za.body.data.foods.map((f) => f.name), ['Zucchini', 'Apple']);

  const newest = await list('?sortBy=createdAt&sortOrder=desc');
  assert.deepEqual(newest.body.data.foods.map((f) => f.id), [String(z._id), String(a._id)]);

  const oldest = await list('?sortKey=createdAt&sortDir=asc');
  assert.deepEqual(oldest.body.data.foods.map((f) => f.id), [String(a._id), String(z._id)]);

  const rejected = await list('?sortKey=nutrition.calories;drop');
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error.message, /sortKey must be one of/);
});

test('the list row carries what the Food Database table shows', async () => {
  await seedMigratedFood(42, {
    name: 'Peanut Butter',
    brand: 'Pintola',
    servingUnit: 'Spoon',
    servingQuantity: 2,
    calories: 190,
    fat: 16,
    carbs: 6,
    protein: 8,
  });

  const [row] = (await list()).body.data.foods;
  assert.equal(row.name, 'Peanut Butter');
  assert.equal(row.brand, 'Pintola');
  assert.deepEqual(flat(row), {
    servingUnit: 'Spoon',
    servingQuantity: 2,
    calories: 190,
    fat: 16,
    carbs: 6,
    protein: 8,
  });
  assert.equal(row.serving, undefined);
  assert.equal(row.nutrition, undefined);
  assert.equal(row.image, null);
  assert.equal(row.legacyFoodId, 42);
  assert.ok(row.createdAt);
});

// ─── detail ──────────────────────────────────────────────────────────────────

test('GET by id returns one real food, with legacy metadata as read-only extras', async () => {
  const food = await seedMigratedFood(777, { notes: 'From the legacy database' });

  const res = await server.request('GET', `/api/admin/foods/${food._id}`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.food.notes, 'From the legacy database');
  assert.deepEqual(res.body.data.food.legacy, { source: 'gogetfit', foodId: 777 });
  assert.equal(res.body.data.food.migration.runId, 'foods-test');
});

test('a malformed id is a 404 rather than a cast error', async () => {
  const res = await server.request('GET', '/api/admin/foods/not-an-object-id', { token: adminToken });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'FOOD_NOT_FOUND');
});

test('an id that is valid but unknown is a 404', async () => {
  const res = await server.request('GET', `/api/admin/foods/${new mongoose.Types.ObjectId()}`, { token: adminToken });
  assert.equal(res.status, 404);
});

// ─── create ──────────────────────────────────────────────────────────────────

test('creating a food stores the new shape and records the admin', async () => {
  const res = await create(validFood());
  assert.equal(res.status, 201);

  const doc = await Food.findById(res.body.data.food.id).lean();
  assert.equal(doc.name, 'Paneer Cubes');
  assert.equal(doc.foodType, 'Vegetarian');
  assert.equal(doc.brand, 'Farm Fresh');
  assert.deepEqual(flat(doc), {
    servingUnit: 'Grams',
    servingQuantity: 100,
    calories: 114,
    fat: 2.6,
    carbs: 0,
    protein: 21,
  });
  // The nested objects are not part of the stored shape any more.
  assert.equal(doc.serving, undefined);
  assert.equal(doc.nutrition, undefined);
  assert.equal(doc.status, 'active');
  assert.equal(doc.image, null);
  assert.equal(String(doc.createdBy), String(admin._id));
  assert.equal(String(doc.updatedBy), String(admin._id));
});

test('a food created in the portal gets no legacy metadata', async () => {
  const res = await create(validFood());

  assert.equal(res.body.data.food.legacyFoodId, null);
  assert.equal(res.body.data.food.legacy, null);
  const doc = await Food.findById(res.body.data.food.id).lean();
  assert.equal(doc.legacy, undefined);
});

test('a client may not send legacy, audit or image fields', async () => {
  for (const extra of [
    { legacy: { source: 'gogetfit', foodId: 99 } },
    { migration: { runId: 'x' } },
    { createdBy: String(admin._id) },
    { image: { url: '/uploads/x.png', storageKey: 'x' } },
    { _id: String(new mongoose.Types.ObjectId()) },
  ]) {
    const res = await create({ ...validFood(), ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.match(res.body.error.message, /not accepted from the client/);
  }
  assert.equal(await Food.countDocuments(), 0);
});

test('backend validation rejects what the legacy form accepted', async () => {
  const cases = [
    [{ name: '   ' }, /name is required/],
    [{ name: undefined }, /name is required/],
    [{ foodType: 'Veg.' }, /foodType must be one of/],
    [{ servingUnit: 'Katori' }, /servingUnit must be one of/],
    [{ servingUnit: undefined }, /servingUnit must be one of/],
    [{ servingQuantity: 0 }, /servingQuantity must be greater than 0/],
    [{ servingQuantity: -5 }, /servingQuantity must be greater than 0/],
    [{ servingQuantity: '100' }, /servingQuantity must be a number/],
    [{ servingQuantity: 10_001 }, /servingQuantity must be at most/],
    [{ calories: -1 }, /calories must be at least 0/],
    [{ calories: 999999 }, /calories must be at most/],
    [{ calories: 'lots' }, /calories must be a number/],
    [{ fat: -0.5 }, /fat must be at least 0/],
    [{ fat: 5001 }, /fat must be at most/],
    [{ fat: undefined }, /fat must be a number/],
    [{ carbs: -1 }, /carbs must be at least 0/],
    [{ carbs: Number.NaN }, /carbs must be a number/],
    [{ protein: undefined }, /protein must be a number/],
    [{ protein: -2 }, /protein must be at least 0/],
    [{ protein: 5001 }, /protein must be at most/],
    [{ name: 'x'.repeat(200) }, /name must be at most/],
  ];

  for (const [patch, expected] of cases) {
    const body = { ...validFood(), ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete body[key];
    const res = await create(body);
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.match(res.body.error.message, expected);
  }
  assert.equal(await Food.countDocuments(), 0);
});

test('two foods may share a name: the name is not an identity', async () => {
  const first = await create(validFood({ name: 'High Protein Paneer', servingUnit: 'Grams', servingQuantity: 100 }));
  const second = await create(validFood({ name: 'High Protein Paneer', servingUnit: 'Bowl', servingQuantity: 1 }));

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.data.food.id, second.body.data.food.id);
  assert.equal(await Food.countDocuments({ name: 'High Protein Paneer' }), 2);
});

// ─── update ──────────────────────────────────────────────────────────────────

test('PUT updates the supplied fields and leaves the rest alone', async () => {
  const created = await create(validFood());
  const id = created.body.data.food.id;

  const res = await server.request('PUT', `/api/admin/foods/${id}`, {
    token: adminToken,
    body: { name: 'Paneer Cubes (Low Fat)', calories: 90 },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.food.name, 'Paneer Cubes (Low Fat)');
  assert.equal(res.body.data.food.calories, 90);
  // Untouched fields survive a partial nutrition update.
  assert.equal(res.body.data.food.protein, 21);
  assert.equal(res.body.data.food.servingUnit, 'Grams');
  // _id is the identity and an update never changes it.
  assert.equal(res.body.data.food.id, id);
});

test('PATCH is accepted as well as PUT', async () => {
  const created = await create(validFood());
  const res = await server.request('PATCH', `/api/admin/foods/${created.body.data.food.id}`, {
    token: adminToken,
    body: { brand: 'Nandini' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.food.brand, 'Nandini');
});

test('updating a migrated food preserves its legacy metadata exactly', async () => {
  const food = await seedMigratedFood(123, { name: 'Legacy Milk' });

  const res = await server.request('PUT', `/api/admin/foods/${food._id}`, {
    token: adminToken,
    body: {
      name: 'Toned Milk',
      brand: 'Amul',
      foodType: 'Vegetarian',
      servingUnit: 'ML',
      servingQuantity: 200,
      calories: 120,
      fat: 4.5,
      carbs: 10,
      protein: 6.5,
      notes: 'Edited in the portal',
    },
  });

  assert.equal(res.status, 200);
  const doc = await Food.findById(food._id).lean();
  assert.equal(doc.name, 'Toned Milk');
  assert.deepEqual({ ...doc.legacy }, { source: 'gogetfit', foodId: 123 });
  assert.equal(doc.migration.runId, 'foods-test');
  assert.equal(String(doc.updatedBy), String(admin._id));
  assert.deepEqual(flat(doc), {
    servingUnit: 'ML',
    servingQuantity: 200,
    calories: 120,
    fat: 4.5,
    carbs: 10,
    protein: 6.5,
  });
});

test('legacy identity cannot be edited through the update endpoint', async () => {
  const food = await seedMigratedFood(321);

  const res = await server.request('PUT', `/api/admin/foods/${food._id}`, {
    token: adminToken,
    body: { legacy: { source: 'gogetfit', foodId: 999 } },
  });

  assert.equal(res.status, 400);
  const doc = await Food.findById(food._id).lean();
  assert.equal(doc.legacy.foodId, 321);
});

test('an update with no editable field is a validation error', async () => {
  const food = await seedMigratedFood(5);
  const res = await server.request('PUT', `/api/admin/foods/${food._id}`, { token: adminToken, body: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /No editable fields supplied/);
});

test('updating an unknown food is a 404', async () => {
  const res = await server.request('PUT', `/api/admin/foods/${new mongoose.Types.ObjectId()}`, {
    token: adminToken,
    body: { name: 'Nothing' },
  });
  assert.equal(res.status, 404);
});

test('the old nested serving / nutrition payload is refused, with the flat fields named', async () => {
  const nested = await create({
    name: 'Old Shape',
    foodType: 'Vegetarian',
    serving: { unit: 'Grams', quantity: 100 },
    nutrition: { calories: 1, fat: 0, carbs: 0, protein: 0 },
  });
  assert.equal(nested.status, 400);
  assert.match(nested.body.error.message, /serving is no longer accepted; send servingUnit, servingQuantity/);

  const created = await create(validFood());
  const id = created.body.data.food.id;
  const update = await server.request('PUT', `/api/admin/foods/${id}`, {
    token: adminToken,
    body: { nutrition: { calories: 5 } },
  });
  assert.equal(update.status, 400);
  assert.match(update.body.error.message, /nutrition is no longer accepted; send calories, fat, carbs, protein/);
  assert.equal((await Food.findById(id).lean()).calories, 114);
});

test('calories, protein, carbs and fat sort on the flat fields', async () => {
  await seedMigratedFood(1, { name: 'Low', calories: 10, protein: 30, carbs: 5, fat: 2 });
  await seedMigratedFood(2, { name: 'High', calories: 500, protein: 1, carbs: 60, fat: 20 });
  await seedMigratedFood(3, { name: 'Mid', calories: 120, protein: 12, carbs: 20, fat: 9 });

  const names = async (qs) => (await list(qs)).body.data.foods.map((f) => f.name);
  assert.deepEqual(await names('?sortKey=calories&sortDir=asc'), ['Low', 'Mid', 'High']);
  assert.deepEqual(await names('?sortKey=calories&sortDir=desc'), ['High', 'Mid', 'Low']);
  assert.deepEqual(await names('?sortKey=protein&sortDir=desc'), ['Low', 'Mid', 'High']);
  assert.deepEqual(await names('?sortKey=carbs&sortDir=asc'), ['Low', 'Mid', 'High']);
  assert.deepEqual(await names('?sortKey=fat&sortDir=desc'), ['High', 'Mid', 'Low']);
});

test('the unit filter combines with search on the flat servingUnit', async () => {
  await seedMigratedFood(1, { name: 'Toned Milk', servingUnit: 'ML', servingQuantity: 200 });
  await seedMigratedFood(2, { name: 'Milk Powder', servingUnit: 'Spoon', servingQuantity: 1 });
  await seedMigratedFood(3, { name: 'Orange Juice', servingUnit: 'ML', servingQuantity: 250 });

  const res = await list('?unit=ML&search=milk');
  assert.deepEqual(res.body.data.foods.map((f) => f.name), ['Toned Milk']);
  assert.equal(res.body.data.pagination.total, 1);
});

// ─── archive ─────────────────────────────────────────────────────────────────

test('DELETE archives rather than removing the document', async () => {
  const food = await seedMigratedFood(900);

  const res = await server.request('DELETE', `/api/admin/foods/${food._id}`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.food.status, 'archived');

  const doc = await Food.findById(food._id).lean();
  assert.ok(doc, 'the document still exists');
  assert.equal(doc.status, 'archived');
  assert.ok(doc.deletedAt);
  assert.equal(String(doc.deletedBy), String(admin._id));
  // Legacy data survives archiving.
  assert.deepEqual({ ...doc.legacy }, { source: 'gogetfit', foodId: 900 });
  assert.equal(doc.calories, 100);
  assert.equal(doc.protein, 3);
});

test('an archived food leaves the default list and can be restored', async () => {
  const food = await seedMigratedFood(901);
  await server.request('DELETE', `/api/admin/foods/${food._id}`, { token: adminToken });

  assert.equal((await list()).body.data.pagination.total, 0);
  assert.equal((await list('?status=archived')).body.data.pagination.total, 1);

  const restored = await server.request('PUT', `/api/admin/foods/${food._id}`, {
    token: adminToken,
    body: { status: 'active' },
  });
  assert.equal(restored.body.data.food.status, 'active');
  assert.equal(restored.body.data.food.deletedAt, null);
  assert.equal((await list()).body.data.pagination.total, 1);
});

// ─── image metadata ──────────────────────────────────────────────────────────

test('migrated foods have no image, and none is invented for them', async () => {
  await seedMigratedFood(1);
  const [row] = (await list()).body.data.foods;
  assert.equal(row.image, null);
});

test('the image endpoint refuses bytes that are not an image, and stores a reference when they are', async () => {
  const created = await create(validFood());
  const id = created.body.data.food.id;

  const notAnImage = await fetch(`${server.baseUrl}/api/admin/foods/${id}/image`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${adminToken}` },
    body: Buffer.from('this is not a png'),
  });
  assert.equal(notAnImage.status, 400);

  // A real 1x1 PNG, sniffed by its bytes rather than its content type.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const uploaded = await fetch(`${server.baseUrl}/api/admin/foods/${id}/image`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${adminToken}` },
    body: png,
  });
  assert.equal(uploaded.status, 200);

  const doc = await Food.findById(id).lean();
  assert.ok(doc.image.url, 'a url reference is stored');
  assert.ok(doc.image.storageKey, 'a storage key is stored');
  // The bytes never go into MongoDB.
  assert.ok(!JSON.stringify(doc.image).includes('iVBOR'));

  const removed = await server.request('DELETE', `/api/admin/foods/${id}/image`, { token: adminToken });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.food.image, null);
});
