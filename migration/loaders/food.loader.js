import Food from '../../src/models/food.model.js';
import { migrationEnv } from '../config/migration.env.js';
import { transformLegacyFood } from '../transformers/food.transformer.js';

/**
 * m_food + r_food_energy -> foods.
 *
 * Identity is (legacy.source, legacy.foodId) - never the name, which legacy
 * legitimately repeats for the same food at a different brand, unit or
 * quantity. Each eligible legacy food_id becomes exactly one Food document.
 *
 * Rules, all of them deliberate:
 *   - a food the legacy inner join excludes is not here at all (the extractor
 *     already joined), so it cannot be migrated;
 *   - delete_flg = 1 is skipped and reported by id;
 *   - a row that does not map cleanly is skipped and reported by id with the
 *     reason - never repaired, never partially written;
 *   - an already-migrated food is left exactly as it is. This loader creates;
 *     it never updates and never deletes.
 */

/** The migrated fields as plain comparable values, for verification. */
export const comparable = (f) => ({
  name: f.name ?? null,
  foodType: f.foodType ?? null,
  brand: f.brand ?? null,
  unit: f.serving?.unit ?? null,
  quantity: f.serving?.quantity ?? null,
  calories: f.nutrition?.calories ?? null,
  fat: f.nutrition?.fat ?? null,
  carbs: f.nutrition?.carbs ?? null,
  protein: f.nutrition?.protein ?? null,
  notes: f.notes ?? null,
});

export const diffFields = (a, b) => {
  const left = comparable(a);
  const right = comparable(b);
  return Object.keys(left).filter((k) => left[k] !== right[k]);
};

export const loadFoods = async (
  rows,
  { dryRun = true, source = migrationEnv.source, runId = null, version = migrationEnv.version } = {},
) => {
  const summary = {
    legacyRows: rows.length,
    eligible: 0,
    toCreate: 0,
    created: 0,
    alreadyMigrated: 0,
    /** Skipped with a reason, by legacy food_id. */
    deleted: [],
    invalid: [],
    duplicateSourceIds: [],
    errors: [],
    /** Data-quality notes about rows that ARE migrated. */
    unitNormalised: [],
    zeroNutrition: [],
    withLegacyImageFileName: 0,
    counts: { Vegetarian: 0, 'Non-Vegetarian': 0 },
    unitCounts: {},
    idMap: [],
  };

  const seen = new Set();

  for (const row of rows) {
    const t = transformLegacyFood(row, { source });
    const ref = { foodId: t.foodId ?? row.food_id, name: t.name ?? row.food_name ?? null };

    // Deleted first: a deleted row is not "invalid", it is simply out of scope.
    if (t.deleted) {
      summary.deleted.push({ ...ref, reason: 'delete_flg = 1 in the legacy database' });
      continue;
    }

    if (t.foodId !== null && seen.has(t.foodId)) {
      summary.duplicateSourceIds.push({ ...ref, reason: 'duplicate food_id in the source rows' });
      continue;
    }
    if (t.foodId !== null) seen.add(t.foodId);

    if (t.problems.length > 0) {
      summary.invalid.push({ ...ref, reason: t.problems.join('; ') });
      continue;
    }

    summary.eligible += 1;
    if (t.unitNormalised) summary.unitNormalised.push({ ...ref, from: t.rawUnit, to: t.food.serving.unit });
    if (t.zeroNutrition) summary.zeroNutrition.push({ ...ref, reason: 'calories, fat, carbs and protein are all 0' });
    if (t.legacyImageFileName) summary.withLegacyImageFileName += 1;
    summary.counts[t.food.foodType] += 1;
    summary.unitCounts[t.food.serving.unit] = (summary.unitCounts[t.food.serving.unit] ?? 0) + 1;

    try {
      const existing = await Food.findOne(
        { 'legacy.source': source, 'legacy.foodId': t.foodId },
        { _id: 1 },
      ).lean();

      if (existing) {
        // Never overwritten: a food edited in the portal since migration stays
        // exactly as the admin left it. Differences are reported by verifyFoods.
        summary.alreadyMigrated += 1;
        summary.idMap.push({ foodId: t.foodId, name: t.food.name, mongoId: String(existing._id), action: 'already migrated' });
        continue;
      }

      summary.toCreate += 1;
      let id = null;
      if (!dryRun) {
        const created = await Food.create({
          ...t.food,
          // Legacy audit columns are login ids, not Mongo users: nothing to map.
          createdBy: null,
          updatedBy: null,
          migration: { runId, migratedAt: new Date(), version },
        });
        await Food.collection.updateOne(
          { _id: created._id },
          { $set: { 'migration.migratedAt': created.updatedAt } },
        );
        summary.created += 1;
        id = String(created._id);
      }
      summary.idMap.push({ foodId: t.foodId, name: t.food.name, mongoId: id, action: dryRun ? 'would create' : 'created' });
    } catch (error) {
      if (error?.code === 11000) {
        summary.errors.push({ ...ref, reason: `legacy food_id ${t.foodId} already exists (unique index)` });
      } else {
        summary.errors.push({ ...ref, reason: error.message });
      }
    }
  }

  return summary;
};

/**
 * Independent re-read of MongoDB after a run. Re-derives what should be there
 * from the legacy rows rather than trusting the loader's own counters:
 *   - every eligible legacy food_id present exactly once;
 *   - no migrated food with a food_id that was not eligible;
 *   - the new model's invariants hold on every migrated document;
 *   - field-by-field equality against the legacy source, nutrition compared
 *     against r_food_energy only;
 *   - foods created in the portal still carry no legacy block.
 */
export const verifyFoods = async (rows, { source = migrationEnv.source } = {}) => {
  const eligible = new Map();
  for (const row of rows) {
    const t = transformLegacyFood(row, { source });
    if (t.deleted || t.problems.length > 0 || t.foodId === null) continue;
    if (!eligible.has(t.foodId)) eligible.set(t.foodId, t.food);
  }

  const docs = await Food.find({ 'legacy.source': source }).lean();

  const byLegacy = new Map();
  const duplicateLegacyIds = [];
  for (const d of docs) {
    const id = d.legacy?.foodId;
    if (byLegacy.has(id)) duplicateLegacyIds.push(id);
    else byLegacy.set(id, d);
  }

  const missing = [...eligible.keys()].filter((id) => !byLegacy.has(id));
  const notEligible = [...byLegacy.keys()].filter((id) => !eligible.has(id));

  const problems = [];
  for (const d of docs) {
    const where = `legacy ${d.legacy?.foodId} (mongo ${d._id})`;
    if (typeof d.legacy?.foodId !== 'number') problems.push(`${where}: legacy.foodId missing`);
    if (!d.name || !String(d.name).trim()) problems.push(`${where}: name is empty`);
    if (!['Vegetarian', 'Non-Vegetarian'].includes(d.foodType)) problems.push(`${where}: foodType "${d.foodType}" invalid`);
    if (!d.serving?.unit) problems.push(`${where}: serving.unit missing`);
    if (typeof d.serving?.quantity !== 'number') problems.push(`${where}: serving.quantity missing`);
    for (const field of ['calories', 'fat', 'carbs', 'protein']) {
      if (typeof d.nutrition?.[field] !== 'number') problems.push(`${where}: nutrition.${field} missing`);
    }
    // Nothing of the legacy system may have come along except the id.
    const extraLegacy = Object.keys(d.legacy ?? {}).filter((k) => !['source', 'foodId'].includes(k));
    if (extraLegacy.length > 0) problems.push(`${where}: legacy carries extra fields: ${extraLegacy.join(', ')}`);
  }

  const mismatches = [];
  for (const [foodId, expected] of eligible) {
    const doc = byLegacy.get(foodId);
    if (!doc) continue;
    const fields = diffFields(doc, expected);
    if (fields.length > 0) mismatches.push({ foodId, fields });
  }

  const portalFoodsWithLegacy = await Food.countDocuments({
    legacy: { $exists: true },
    'legacy.source': { $ne: source },
  });

  return {
    eligibleCount: eligible.size,
    migratedInMongo: docs.length,
    duplicateLegacyIds,
    missing,
    notEligible,
    problems,
    mismatches,
    portalFoodsWithLegacy,
    withoutImage: docs.filter((d) => !d.image).length,
  };
};
