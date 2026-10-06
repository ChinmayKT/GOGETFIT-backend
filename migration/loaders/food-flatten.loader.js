import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import Food from '../../src/models/food.model.js';

/**
 * foods: nested serving / nutrition -> flat root fields, in place.
 *
 *   serving.unit        -> servingUnit
 *   serving.quantity    -> servingQuantity
 *   nutrition.calories  -> calories
 *   nutrition.fat       -> fat
 *   nutrition.carbs     -> carbs
 *   nutrition.protein   -> protein
 *
 * Rules, all of them deliberate:
 *   - a root value that already exists is never overwritten: an admin may have
 *     edited the food through the flat API while the nested objects were still
 *     there, and that edit is the newer value;
 *   - a nested value that is missing stays missing - nothing is defaulted to 0,
 *     '' or anything else; a nested null is carried over as null;
 *   - `serving` and `nutrition` are then removed;
 *   - nothing else is written: no timestamps, no migration metadata, no _id
 *     change, no delete/reinsert. Writes go through the raw collection, so
 *     Mongoose never stamps updatedAt;
 *   - a document with neither nested object is already flat and is skipped,
 *     which makes the run idempotent;
 *   - a malformed nested object (not a plain object, or carrying keys this
 *     mapping does not know) stops the run before anything is written.
 */

export const FLATTEN_MAP = [
  ['serving', 'unit', 'servingUnit'],
  ['serving', 'quantity', 'servingQuantity'],
  ['nutrition', 'calories', 'calories'],
  ['nutrition', 'fat', 'fat'],
  ['nutrition', 'carbs', 'carbs'],
  ['nutrition', 'protein', 'protein'],
];

export const NESTED_FIELDS = ['serving', 'nutrition'];
export const FLAT_FIELDS = FLATTEN_MAP.map(([, , flat]) => flat);

const KNOWN_NESTED_KEYS = {
  serving: ['unit', 'quantity'],
  nutrition: ['calories', 'fat', 'carbs', 'protein'],
};

const has = (object, key) => object != null && Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/** Why a document cannot be flattened safely, or [] when it can. */
export const malformedReasons = (doc) => {
  const reasons = [];
  for (const nested of NESTED_FIELDS) {
    if (!has(doc, nested)) continue;
    const value = doc[nested];
    if (!isPlainObject(value)) {
      reasons.push(`${nested} is not an object`);
      continue;
    }
    const unknown = Object.keys(value).filter((key) => !KNOWN_NESTED_KEYS[nested].includes(key));
    if (unknown.length > 0) reasons.push(`${nested} has unknown key(s): ${unknown.join(', ')}`);
  }
  return reasons;
};

export const isNested = (doc) => NESTED_FIELDS.some((nested) => has(doc, nested));

/**
 * The update for one document, or null when it is already flat. `guard` lists
 * the root fields that must still be absent when the write lands, so a value an
 * admin saves between this read and the write is never overwritten.
 */
export const planFlatten = (doc) => {
  if (!isNested(doc)) return null;

  const set = {};
  for (const [nested, key, flat] of FLATTEN_MAP) {
    if (has(doc, flat)) continue; // the root value wins
    if (has(doc[nested], key)) set[flat] = doc[nested][key]; // missing stays missing
  }
  const unset = Object.fromEntries(NESTED_FIELDS.filter((nested) => has(doc, nested)).map((n) => [n, '']));
  return { set, unset, guard: Object.keys(set) };
};

/** The document as it must look after flattening - what verification compares against. */
export const expectedAfter = (doc) => {
  const plan = planFlatten(doc);
  if (!plan) return doc;
  const out = { ...doc, ...plan.set };
  for (const nested of Object.keys(plan.unset)) delete out[nested];
  return out;
};

/** The same whole-collection hash used to verify the 960 foods before Step 1. */
export const hashDocs = (docs) => crypto.createHash('sha256').update(JSON.stringify(docs)).digest('hex');

const maxUpdatedAt = (docs) =>
  docs.reduce((max, d) => (d.updatedAt instanceof Date && d.updatedAt > max ? d.updatedAt : max), new Date(0));

const indexSignature = (indexes) =>
  indexes
    .map(({ name, key, unique, partialFilterExpression }) => ({ name, key, unique: !!unique, partialFilterExpression }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** Read-only picture of the collection: counts, shapes, indexes, hash. */
export const describeFoods = async (collection = Food.collection) => {
  const docs = await collection.find({}).sort({ _id: 1 }).toArray();
  const count = (predicate) => docs.filter(predicate).length;

  return {
    docs,
    baseline: {
      total: docs.length,
      withServing: count((d) => has(d, 'serving')),
      withNutrition: count((d) => has(d, 'nutrition')),
      ...Object.fromEntries(FLAT_FIELDS.map((flat) => [`with_${flat}`, count((d) => has(d, flat))])),
      nestedAndFlat: count((d) => isNested(d) && FLAT_FIELDS.some((flat) => has(d, flat))),
      alreadyFlat: count((d) => !isNested(d)),
      malformed: docs
        .map((d) => ({ id: String(d._id), reasons: malformedReasons(d) }))
        .filter((m) => m.reasons.length > 0),
      maxUpdatedAt: maxUpdatedAt(docs).toISOString(),
      sha256: hashDocs(docs),
      indexes: indexSignature(await collection.indexes()),
    },
  };
};

/**
 * Field-by-field check of the collection after a run against the snapshot taken
 * before it. Every document is compared whole, so a changed unrelated field, a
 * leftover nested object, a lost value or an invented field all show up - by _id.
 */
export const verifyFlattened = async (beforeDocs, beforeIndexes, collection = Food.collection) => {
  const afterDocs = await collection.find({}).sort({ _id: 1 }).toArray();
  const afterById = new Map(afterDocs.map((d) => [String(d._id), d]));
  const beforeIds = new Set(beforeDocs.map((d) => String(d._id)));

  const missingIds = [...beforeIds].filter((id) => !afterById.has(id));
  const addedIds = afterDocs.map((d) => String(d._id)).filter((id) => !beforeIds.has(id));

  const mismatches = [];
  for (const before of beforeDocs) {
    const after = afterById.get(String(before._id));
    if (!after) continue;
    const expected = expectedAfter(before);
    const fields = [...new Set([...Object.keys(expected), ...Object.keys(after)])].filter(
      (key) => !isDeepStrictEqual(expected[key], after[key]),
    );
    if (fields.length > 0) mismatches.push({ id: String(before._id), fields });
  }

  const legacyKeys = afterDocs.filter((d) => d.legacy?.foodId != null).map((d) => `${d.legacy.source}:${d.legacy.foodId}`);
  const duplicateLegacy = legacyKeys.filter((key, i) => legacyKeys.indexOf(key) !== i);
  const afterIndexes = indexSignature(await collection.indexes());

  const result = {
    countBefore: beforeDocs.length,
    countAfter: afterDocs.length,
    missingIds,
    addedIds,
    stillWithServing: afterDocs.filter((d) => has(d, 'serving')).map((d) => String(d._id)),
    stillWithNutrition: afterDocs.filter((d) => has(d, 'nutrition')).map((d) => String(d._id)),
    mismatches,
    duplicateLegacy,
    indexesUnchanged: isDeepStrictEqual(beforeIndexes, afterIndexes),
    maxUpdatedAtBefore: maxUpdatedAt(beforeDocs).toISOString(),
    maxUpdatedAtAfter: maxUpdatedAt(afterDocs).toISOString(),
    sha256After: hashDocs(afterDocs),
  };
  result.ok =
    result.countBefore === result.countAfter &&
    missingIds.length === 0 &&
    addedIds.length === 0 &&
    result.stillWithServing.length === 0 &&
    result.stillWithNutrition.length === 0 &&
    mismatches.length === 0 &&
    duplicateLegacy.length === 0 &&
    result.indexesUnchanged &&
    result.maxUpdatedAtBefore === result.maxUpdatedAtAfter;
  return result;
};

/**
 * Plans (dry run) or applies the flattening. Returns the snapshot taken before
 * any write, so the caller can keep it as a backup and verify against it.
 */
export const flattenFoods = async ({
  dryRun = true,
  collection = Food.collection,
  batchSize = 500,
  /** Called with the pre-migration documents before the first write (the backup). */
  beforeWrite = async () => {},
} = {}) => {
  const { docs, baseline } = await describeFoods(collection);

  if (baseline.malformed.length > 0) {
    const sample = baseline.malformed.slice(0, 10).map((m) => `${m.id} (${m.reasons.join('; ')})`).join(', ');
    throw new Error(`${baseline.malformed.length} malformed food document(s); nothing written: ${sample}`);
  }

  const plans = docs.map((doc) => ({ doc, plan: planFlatten(doc) })).filter((p) => p.plan);
  const summary = {
    total: docs.length,
    toFlatten: plans.length,
    alreadyFlat: docs.length - plans.length,
    rootValuesKept: plans.reduce(
      (n, { doc }) => n + FLAT_FIELDS.filter((flat) => has(doc, flat)).length,
      0,
    ),
    missingNestedValues: plans.reduce(
      (n, { doc, plan }) => n + FLAT_FIELDS.filter((flat) => !has(doc, flat) && !(flat in plan.set)).length,
      0,
    ),
    flattened: 0,
    notMatched: [],
  };

  if (!dryRun && plans.length > 0) {
    await beforeWrite(docs);
    for (let i = 0; i < plans.length; i += batchSize) {
      const batch = plans.slice(i, i + batchSize);
      const result = await collection.bulkWrite(
        batch.map(({ doc, plan }) => ({
          updateOne: {
            filter: {
              _id: doc._id,
              // Still nested, and still without the root values about to be set.
              $or: NESTED_FIELDS.map((nested) => ({ [nested]: { $exists: true } })),
              ...Object.fromEntries(plan.guard.map((flat) => [flat, { $exists: false }])),
            },
            update: {
              ...(Object.keys(plan.set).length > 0 ? { $set: plan.set } : {}),
              $unset: plan.unset,
            },
          },
        })),
        { ordered: true },
      );
      summary.flattened += result.modifiedCount;
      if (result.matchedCount !== batch.length) {
        // Something changed between the read and the write; re-reading is the
        // only safe answer, so the run stops and verification reports by _id.
        const stillNested = await collection
          .find({ _id: { $in: batch.map(({ doc }) => doc._id) }, $or: NESTED_FIELDS.map((n) => ({ [n]: { $exists: true } })) })
          .project({ _id: 1 })
          .toArray();
        summary.notMatched.push(...stillNested.map((d) => String(d._id)));
        break;
      }
    }
  }

  return { docs, baseline, summary };
};
