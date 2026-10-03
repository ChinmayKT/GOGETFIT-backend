import mongoose from 'mongoose';

import Food from '../models/food.model.js';

/**
 * The Food master: reads and writes for the admin Food Database screens.
 *
 * Every list is paginated, filtered and sorted in MongoDB - the collection holds
 * ~1000 documents today and the browser never receives more than one page.
 *
 * A migrated food and one added in the portal are the same kind of document.
 * The only difference is the `legacy` block, which this service exposes as
 * read-only metadata and never writes, never edits and never removes.
 */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sort keys the portal may request, mapped to real document paths. A key that
 * is not in here never reaches MongoDB - the request parameter is matched
 * against this table, not interpolated into the sort.
 */
const SORTABLE = {
  name: 'name',
  foodType: 'foodType',
  brand: 'brand',
  calories: 'nutrition.calories',
  protein: 'nutrition.protein',
  carbs: 'nutrition.carbs',
  fat: 'nutrition.fat',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  legacyFoodId: 'legacy.foodId',
};

export const SORT_KEYS = Object.keys(SORTABLE);

const iso = (date) => (date ? new Date(date).toISOString() : null);

const toImageRef = (image) => (image?.url ? { url: image.url, storageKey: image.storageKey ?? null } : null);

/** Allow-listed list row: what the Food Database table shows, and nothing more. */
export const toFoodRow = (doc) => ({
  id: String(doc._id),
  name: doc.name ?? null,
  foodType: doc.foodType ?? null,
  brand: doc.brand ?? null,
  serving: {
    unit: doc.serving?.unit ?? null,
    quantity: doc.serving?.quantity ?? null,
  },
  nutrition: {
    calories: doc.nutrition?.calories ?? null,
    fat: doc.nutrition?.fat ?? null,
    carbs: doc.nutrition?.carbs ?? null,
    protein: doc.nutrition?.protein ?? null,
  },
  image: toImageRef(doc.image),
  status: doc.status ?? null,
  /** Secondary admin metadata; null for a food added in the portal. */
  legacyFoodId: doc.legacy?.foodId ?? null,
  createdAt: iso(doc.createdAt),
  updatedAt: iso(doc.updatedAt),
});

/** Full food for the detail / edit screen. */
export const toFoodDetail = (doc) => ({
  ...toFoodRow(doc),
  notes: doc.notes ?? null,
  deletedAt: iso(doc.deletedAt),
  legacy:
    doc.legacy?.foodId != null ? { source: doc.legacy.source ?? null, foodId: doc.legacy.foodId } : null,
  migration: doc.migration?.runId
    ? { runId: doc.migration.runId, migratedAt: iso(doc.migration.migratedAt), version: doc.migration.version ?? null }
    : null,
});

export const buildFoodFilter = ({ search, foodType, unit, status } = {}) => {
  // Archived foods stay out of the default list; diet plans and logs still
  // resolve them by id, which is why they are never deleted.
  const filter = { status: status ?? 'active' };
  if (foodType) filter.foodType = foodType;
  if (unit) filter['serving.unit'] = unit;

  const term = String(search ?? '').trim();
  if (term !== '') {
    // Name or brand, case-insensitive, matched in MongoDB across the whole
    // collection - never against the page already loaded in the browser.
    const pattern = new RegExp(escapeRegex(term), 'i');
    filter.$or = [{ name: pattern }, { brand: pattern }];
  }
  return filter;
};

/** One page of foods. Always paginated and capped. Default order is name A-Z. */
export const listFoods = async (params = {}) => {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);

  const sortField = SORTABLE[params.sortKey] ?? SORTABLE.name;
  const sortDir = params.sortDir === 'desc' ? -1 : 1;

  const filter = buildFoodFilter(params);
  const [docs, total] = await Promise.all([
    Food.find(filter)
      // _id breaks ties, so paging is stable even where the sort field repeats
      // (the 960 migrated foods share a migration timestamp).
      .sort({ [sortField]: sortDir, _id: sortDir })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Food.countDocuments(filter),
  ]);

  return {
    rows: docs.map(toFoodRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

export const getFoodById = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await Food.findById(id).lean();
  return doc ? toFoodDetail(doc) : null;
};

/**
 * A new food. It gets no legacy block: only a migrated food has one, and
 * inventing one would make a portal food indistinguishable from legacy data.
 */
export const createFood = async (input, adminId) => {
  const created = await Food.create({
    name: input.name,
    foodType: input.foodType,
    brand: input.brand ?? null,
    serving: input.serving,
    nutrition: input.nutrition,
    notes: input.notes ?? null,
    status: input.status ?? 'active',
    createdBy: adminId,
    updatedBy: adminId,
  });
  return toFoodDetail(created.toObject());
};

/**
 * Controlled update: each supplied field is $set by its own path, so `legacy`,
 * `migration`, `createdAt` and `createdBy` survive untouched. The validator
 * already refuses a body that mentions them; this is the second guarantee -
 * nothing outside this list can be written even if one slipped through.
 */
export const updateFood = async (id, patch, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const current = await Food.findById(id).lean();
  if (!current) return null;

  const update = { updatedBy: adminId };
  for (const key of ['name', 'foodType', 'brand', 'notes']) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }
  for (const [key, value] of Object.entries(patch.serving ?? {})) update[`serving.${key}`] = value;
  for (const [key, value] of Object.entries(patch.nutrition ?? {})) update[`nutrition.${key}`] = value;

  if (patch.status !== undefined) {
    update.status = patch.status;
    if (patch.status === 'active') {
      update.deletedAt = null;
      update.deletedBy = null;
    } else if (current.status !== 'archived') {
      update.deletedAt = new Date();
      update.deletedBy = adminId;
    }
  }

  const doc = await Food.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true }).lean();
  return doc ? toFoodDetail(doc) : null;
};

/**
 * "Delete" archives. Diet plans and food logs reference foods by id, and the
 * 960 migrated foods are verified legacy data - removing a document would
 * destroy history that cannot be recovered. Reversible with { status: "active" }.
 */
export const archiveFood = async (id, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await Food.findByIdAndUpdate(
    id,
    { $set: { status: 'archived', deletedAt: new Date(), deletedBy: adminId, updatedBy: adminId } },
    { new: true },
  ).lean();
  return doc ? toFoodDetail(doc) : null;
};
