import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import Food from '../../src/models/food.model.js';
import { flattenFoods, verifyFlattened } from '../../migration/loaders/food-flatten.loader.js';
import { assertDevelopmentConnection, assertDevelopmentTarget } from '../../migration/scripts/flatten-foods.js';
import { clearTestDb, connectTestDb, disconnectTestDb } from '../helpers/test-server.js';

const c = () => Food.collection;

const createdAt = new Date('2026-10-02T07:06:39.000Z');
const updatedAt = new Date('2026-10-02T07:06:39.857Z');

/** A food exactly as the original migration stored it, before the flattening. */
const nestedFood = (foodId, overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  name: `Food ${foodId}`,
  foodType: 'Vegetarian',
  brand: null,
  serving: { unit: 'Grams', quantity: 100 },
  nutrition: { calories: 77.8, fat: 1.5, carbs: 16, protein: 2.7 },
  notes: null,
  image: null,
  status: 'active',
  deletedAt: null,
  deletedBy: null,
  legacy: { source: 'gogetfit', foodId },
  migration: { runId: 'foods-run-1', migratedAt: createdAt, version: 1 },
  createdBy: null,
  updatedBy: null,
  createdAt,
  updatedAt,
  ...overrides,
});

/** Runs the migration for real and verifies it against the pre-run snapshot. */
const apply = async () => {
  const run = await flattenFoods({ dryRun: false });
  const verify = await verifyFlattened(run.docs, run.baseline.indexes);
  return { ...run, verify };
};

before(connectTestDb);
beforeEach(clearTestDb);
after(disconnectTestDb);

test('an old nested document is flattened in place, nested objects removed', async () => {
  const doc = nestedFood(14, { name: 'rice' });
  await c().insertOne(doc);

  const { summary, verify } = await apply();

  assert.equal(summary.flattened, 1);
  assert.equal(verify.ok, true, JSON.stringify(verify.mismatches));
  const after = await c().findOne({ _id: doc._id });
  assert.equal(after.servingUnit, 'Grams');
  assert.equal(after.servingQuantity, 100);
  assert.equal(after.calories, 77.8);
  assert.equal(after.fat, 1.5);
  assert.equal(after.carbs, 16);
  assert.equal(after.protein, 2.7);
  assert.equal('serving' in after, false);
  assert.equal('nutrition' in after, false);
});

test('_id and every unrelated field are preserved exactly, timestamps included', async () => {
  const adminId = new mongoose.Types.ObjectId();
  const doc = nestedFood(21, {
    brand: 'Amul',
    notes: 'kept',
    image: { url: '/uploads/foods/x.png', storageKey: 'foods/x.png' },
    status: 'archived',
    deletedAt: updatedAt,
    deletedBy: adminId,
    createdBy: adminId,
    updatedBy: adminId,
  });
  await c().insertOne(doc);

  await apply();

  const after = await c().findOne({ _id: doc._id });
  const { serving, nutrition, ...unrelated } = doc;
  for (const [key, value] of Object.entries(unrelated)) assert.deepEqual(after[key], value, key);
  assert.equal(await c().countDocuments(), 1);
});

test('an already-flat document is skipped and left byte-for-byte unchanged', async () => {
  const { serving, nutrition, ...rest } = nestedFood(30);
  const flat = { ...rest, servingUnit: 'ML', servingQuantity: 200, calories: 120, fat: 4.5, carbs: 10, protein: 6.5 };
  await c().insertOne(flat);

  const { summary, verify } = await apply();

  assert.equal(summary.alreadyFlat, 1);
  assert.equal(summary.toFlatten, 0);
  assert.equal(verify.ok, true);
  assert.deepEqual(await c().findOne({ _id: flat._id }), flat);
});

test('root values written since Step 1 win over the stale nested ones', async () => {
  // An admin edited calories and servingUnit through the flat API before Step 2.
  const doc = nestedFood(40, { calories: 90, servingUnit: 'Bowl' });
  await c().insertOne(doc);

  const { summary, verify } = await apply();

  assert.equal(summary.rootValuesKept, 2);
  assert.equal(verify.ok, true, JSON.stringify(verify.mismatches));
  const after = await c().findOne({ _id: doc._id });
  assert.equal(after.calories, 90);
  assert.equal(after.servingUnit, 'Bowl');
  // Everything not edited comes from the nested objects.
  assert.equal(after.servingQuantity, 100);
  assert.equal(after.protein, 2.7);
  assert.equal('nutrition' in after, false);
});

test('missing nested values are not invented; a nested null stays null', async () => {
  const doc = nestedFood(50, {
    serving: { unit: 'Piece' },
    nutrition: { calories: null, fat: 0 },
  });
  await c().insertOne(doc);

  const { summary, verify } = await apply();

  assert.equal(verify.ok, true, JSON.stringify(verify.mismatches));
  assert.equal(summary.missingNestedValues, 3);
  const after = await c().findOne({ _id: doc._id });
  assert.equal(after.servingUnit, 'Piece');
  assert.equal('servingQuantity' in after, false);
  assert.equal(after.calories, null);
  assert.equal(after.fat, 0);
  assert.equal('carbs' in after, false);
  assert.equal('protein' in after, false);
});

test('running twice is idempotent: the second run changes nothing', async () => {
  await c().insertMany([nestedFood(60), nestedFood(61, { calories: 5 }), nestedFood(62)]);

  const first = await apply();
  assert.equal(first.summary.flattened, 3);
  const afterFirst = await c().find({}).sort({ _id: 1 }).toArray();

  const second = await apply();
  assert.equal(second.summary.toFlatten, 0);
  assert.equal(second.summary.flattened, 0);
  assert.equal(second.summary.alreadyFlat, 3);
  assert.equal(second.verify.ok, true);
  assert.deepEqual(await c().find({}).sort({ _id: 1 }).toArray(), afterFirst);
});

test('a dry run writes nothing', async () => {
  const doc = nestedFood(70);
  await c().insertOne(doc);

  const { summary } = await flattenFoods({ dryRun: true });

  assert.equal(summary.toFlatten, 1);
  assert.equal(summary.flattened, 0);
  assert.deepEqual(await c().findOne({ _id: doc._id }), doc);
});

test('a malformed nested object stops the run before anything is written', async () => {
  const good = nestedFood(80);
  const bad = nestedFood(81, { nutrition: { calories: 1, fibre: 2 } });
  await c().insertMany([good, bad]);

  await assert.rejects(flattenFoods({ dryRun: false }), /1 malformed food document\(s\); nothing written/);
  assert.deepEqual(await c().findOne({ _id: good._id }), good);
  assert.deepEqual(await c().findOne({ _id: bad._id }), bad);
});

test('verification names the _id of a document that does not match', async () => {
  const doc = nestedFood(90);
  await c().insertOne(doc);
  const run = await flattenFoods({ dryRun: false });

  // Simulate an unrelated field being damaged.
  await c().updateOne({ _id: doc._id }, { $set: { name: 'changed' } });
  const verify = await verifyFlattened(run.docs, run.baseline.indexes);

  assert.equal(verify.ok, false);
  assert.deepEqual(verify.mismatches, [{ id: String(doc._id), fields: ['name'] }]);
});

test('the legacy mapping and its unique index survive the migration', async () => {
  await Food.syncIndexes();
  await c().insertMany([nestedFood(100), nestedFood(101)]);

  const { verify } = await apply();

  assert.equal(verify.indexesUnchanged, true);
  assert.deepEqual(verify.duplicateLegacy, []);
  const ids = (await c().find({}).toArray()).map((d) => d.legacy.foodId).sort();
  assert.deepEqual(ids, [100, 101]);
});

test('the script refuses anything but an explicit development target', () => {
  assert.throws(() => assertDevelopmentTarget({ NODE_ENV: 'production' }), /not "development"/);
  assert.throws(() => assertDevelopmentTarget({ NODE_ENV: 'test' }), /not "development"/);
  assert.throws(() => assertDevelopmentTarget({}), /not "development"/);

  const dev = 'mongodb+srv://u:p@gogetfit-dev.qpq15dg.mongodb.net/gogetfit?retryWrites=true';
  assert.throws(
    () => assertDevelopmentConnection({ uri: 'mongodb+srv://u:p@gogetfit-prod.abc.mongodb.net/gogetfit', name: 'gogetfit' }),
    /Refusing to flatten foods/,
  );
  assert.throws(() => assertDevelopmentConnection({ uri: dev, name: 'gogetfit_test' }), /Refusing to flatten foods/);
  // Credentials never satisfy the host check.
  assert.throws(
    () => assertDevelopmentConnection({ uri: 'mongodb+srv://gogetfit-dev.:p@prod.abc.mongodb.net/gogetfit', name: 'gogetfit' }),
    /Refusing to flatten foods/,
  );
  assert.deepEqual(assertDevelopmentConnection({ uri: dev, name: 'gogetfit' }), {
    host: 'gogetfit-dev.qpq15dg.mongodb.net',
    database: 'gogetfit',
  });
});
