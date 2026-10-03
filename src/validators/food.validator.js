import { FOOD_STATUSES, FOOD_TYPES, FOOD_UNITS } from '../models/food.model.js';
import { SORT_KEYS } from '../services/food.service.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * Backend-owned validation for the Food Database. The portal validates too, but
 * nothing reaches MongoDB on its word.
 *
 * The legacy Add Food form validated almost nothing - its client-side rules
 * never ran at all, and it accepted negative and absurd numbers (see
 * docs/add-food-legacy.md). Those defects are deliberately not carried over.
 * The limits below are wide enough that every one of the 960 migrated foods
 * stays editable: the largest migrated values are name 38 chars, quantity 600,
 * calories 1190, fat 100, carbs 123, protein 100.
 */

const MAX_NAME = 120;
const MAX_BRAND = 80;
const MAX_NOTES = 500;
const MAX_QUANTITY = 10_000;
const MAX_CALORIES = 20_000;
const MAX_MACRO = 5_000;

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const numberIn = (value, { min, max, label, exclusiveMin = false }) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a number`);
  if (exclusiveMin ? value <= min : value < min) {
    fail(exclusiveMin ? `${label} must be greater than ${min}` : `${label} must be at least ${min}`);
  }
  if (value > max) fail(`${label} must be at most ${max}`);
  return value;
};

const validateEnum = (value, allowed, label) => {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
};

const requiredText = (value, { label, max }) => {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  const text = value.trim();
  if (text.length > max) fail(`${label} must be at most ${max} characters`);
  return text;
};

/** Optional text: absent stays absent, blank becomes null. */
const optionalText = (value, { label, max }) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const text = value.trim();
  if (text.length > max) fail(`${label} must be at most ${max} characters`);
  return text === '' ? null : text;
};

const SERVING_FIELDS = ['unit', 'quantity'];

const validateServing = (value, { partial }) => {
  if (value === undefined && partial) return undefined;
  if (!isPlainObject(value)) fail('serving must be an object with unit and quantity');
  const unknown = Object.keys(value).filter((key) => !SERVING_FIELDS.includes(key));
  if (unknown.length > 0) fail(`Unknown serving field(s): ${unknown.join(', ')}`);

  const out = {};
  if (value.unit !== undefined || !partial) out.unit = validateEnum(value.unit, FOOD_UNITS, 'serving.unit');
  if (value.quantity !== undefined || !partial) {
    // A portion of zero describes nothing, so nutrition attached to it cannot be read.
    out.quantity = numberIn(value.quantity, { min: 0, max: MAX_QUANTITY, label: 'serving.quantity', exclusiveMin: true });
  }
  return out;
};

const NUTRITION_FIELDS = ['calories', 'fat', 'carbs', 'protein'];

const validateNutrition = (value, { partial }) => {
  if (value === undefined && partial) return undefined;
  if (!isPlainObject(value)) fail(`nutrition must be an object with ${NUTRITION_FIELDS.join(', ')}`);
  const unknown = Object.keys(value).filter((key) => !NUTRITION_FIELDS.includes(key));
  if (unknown.length > 0) fail(`Unknown nutrition field(s): ${unknown.join(', ')}`);

  const out = {};
  for (const field of NUTRITION_FIELDS) {
    if (value[field] === undefined && partial) continue;
    // 0 is legitimate (water has no macros); negative never is.
    out[field] = numberIn(value[field], {
      min: 0,
      max: field === 'calories' ? MAX_CALORIES : MAX_MACRO,
      label: `nutrition.${field}`,
    });
  }
  return out;
};

/**
 * Fields a client may never set. Rejected loudly rather than dropped silently,
 * so a portal bug surfaces instead of appearing to work.
 *
 * `legacy` and `migration` are here because a migrated food's legacy identity is
 * immutable: it is how the migration recognises that food, and inventing one on
 * a portal food would disguise it as legacy data.
 */
const FORBIDDEN_FIELDS = [
  'id',
  '_id',
  'legacy',
  'migration',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deletedBy',
  // The picture has its own upload/remove endpoints; never part of a food write.
  'image',
];

const ALLOWED_FIELDS = ['name', 'foodType', 'brand', 'serving', 'nutrition', 'notes', 'status'];

const assertShape = (body) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  const forbidden = FORBIDDEN_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (forbidden.length > 0) fail(`Field(s) not accepted from the client: ${forbidden.join(', ')}`);
  const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.includes(key));
  if (unknown.length > 0) fail(`Unknown field(s): ${unknown.join(', ')}`);
};

export const validateCreateFood = (body = {}) => {
  assertShape(body);

  const food = {
    name: requiredText(body.name, { label: 'name', max: MAX_NAME }),
    foodType: validateEnum(body.foodType, FOOD_TYPES, 'foodType'),
    brand: optionalText(body.brand, { label: 'brand', max: MAX_BRAND }) ?? null,
    serving: validateServing(body.serving, { partial: false }),
    nutrition: validateNutrition(body.nutrition, { partial: false }),
    notes: optionalText(body.notes, { label: 'notes', max: MAX_NOTES }) ?? null,
    status: body.status === undefined ? 'active' : validateEnum(body.status, FOOD_STATUSES, 'status'),
  };

  // Deliberately NOT checked: whether another food has this name. Legacy holds
  // the same name many times with a different brand, unit or quantity, and each
  // is its own food. _id is the identity.
  return food;
};

/** Partial update: only the supplied fields change. */
export const validateUpdateFood = (body = {}) => {
  assertShape(body);

  const patch = {};
  if (body.name !== undefined) patch.name = requiredText(body.name, { label: 'name', max: MAX_NAME });
  if (body.foodType !== undefined) patch.foodType = validateEnum(body.foodType, FOOD_TYPES, 'foodType');
  if (body.brand !== undefined) patch.brand = optionalText(body.brand, { label: 'brand', max: MAX_BRAND });
  if (body.notes !== undefined) patch.notes = optionalText(body.notes, { label: 'notes', max: MAX_NOTES });
  if (body.serving !== undefined) patch.serving = validateServing(body.serving, { partial: true });
  if (body.nutrition !== undefined) patch.nutrition = validateNutrition(body.nutrition, { partial: true });
  if (body.status !== undefined) patch.status = validateEnum(body.status, FOOD_STATUSES, 'status');

  if (Object.keys(patch).length === 0) fail('No editable fields supplied');
  return patch;
};

/**
 * List query. Page size, filters and sort are all validated here, and the sort
 * key is matched against the service's allow-list rather than passed through.
 *
 * `limit`, `sortBy` and `sortOrder` are accepted as aliases of the portal-wide
 * `pageSize`, `sortKey` and `sortDir`, so both spellings work.
 */
export const validateFoodListQuery = (query = {}) => {
  const out = {};

  if (query.page !== undefined) {
    const page = Number.parseInt(query.page, 10);
    if (Number.isNaN(page) || page < 1) fail('page must be a positive integer');
    out.page = page;
  }

  const rawPageSize = query.pageSize ?? query.limit;
  if (rawPageSize !== undefined) {
    const pageSize = Number.parseInt(rawPageSize, 10);
    if (Number.isNaN(pageSize) || pageSize < 1) fail('pageSize must be a positive integer');
    out.pageSize = pageSize;
  }

  if (query.search !== undefined) out.search = String(query.search);
  if (query.foodType !== undefined && query.foodType !== '') {
    out.foodType = validateEnum(query.foodType, FOOD_TYPES, 'foodType');
  }
  if (query.unit !== undefined && query.unit !== '') out.unit = validateEnum(query.unit, FOOD_UNITS, 'unit');
  if (query.status !== undefined && query.status !== '') {
    out.status = validateEnum(query.status, FOOD_STATUSES, 'status');
  }

  const rawSortKey = query.sortKey ?? query.sortBy;
  if (rawSortKey !== undefined && rawSortKey !== '') {
    if (!SORT_KEYS.includes(rawSortKey)) fail(`sortKey must be one of: ${SORT_KEYS.join(', ')}`);
    out.sortKey = rawSortKey;
  }
  const rawSortDir = query.sortDir ?? query.sortOrder;
  if (rawSortDir !== undefined) out.sortDir = rawSortDir === 'desc' ? 'desc' : 'asc';

  return out;
};
