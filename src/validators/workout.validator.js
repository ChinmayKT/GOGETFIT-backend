import {
  WORKOUT_EQUIPMENT,
  WORKOUT_LEVELS,
  WORKOUT_STATUSES,
  WORKOUT_TYPES,
} from '../models/workout.model.js';
import { SORT_KEYS } from '../services/workout.service.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * Backend-owned validation for workouts.
 *
 * Legacy required only three fields on the server (name, primary muscle,
 * description) even though the form marked type and equipment with a `*`, and
 * it accepted any text in any length. The required set here matches what the
 * form has always actually sent, and the limits are wide enough that all 188
 * migrated workouts stay editable (longest name 45, longest description 2679).
 */

const MAX_NAME = 120;
const MAX_MUSCLE = 80;
const MAX_DESCRIPTION = 20_000;
const MAX_URL = 500;

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const validateEnum = (value, allowed, label) => {
  if (!allowed.includes(value)) fail(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
};

const requiredText = (value, { label, max }) => {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  const text = value.trim();
  if (text.length > max) fail(`${label} must be at most ${max} characters`);
  return text;
};

const optionalText = (value, { label, max }) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const text = value.trim();
  if (text.length > max) fail(`${label} must be at most ${max} characters`);
  return text === '' ? null : text;
};

const validateLevel = (value) => {
  const level = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(level) || !WORKOUT_LEVELS.includes(level)) {
    fail(`level must be one of: ${WORKOUT_LEVELS.join(', ')}`);
  }
  return level;
};

/**
 * A YouTube link, when one is given. Legacy accepted any text at all - one row
 * holds "https://Test/link/update" - so this is checked for new input only, and
 * migrated rows keep whatever they already have unless an admin edits the field.
 */
const validateYoutubeUrl = (value) => {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (text.length > MAX_URL) fail(`youtubeUrl must be at most ${MAX_URL} characters`);

  let url;
  try {
    url = new URL(text);
  } catch {
    fail('youtubeUrl must be a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail('youtubeUrl must be an http(s) URL');

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (!['youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) {
    fail('youtubeUrl must be a YouTube link');
  }
  return text;
};

/**
 * Fields a client may never set. Rejected loudly rather than dropped silently.
 * Media is here because video and thumbnail have their own upload endpoints -
 * the same separation the legacy update had, where a text edit never touched a file.
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
  'archivedAt',
  'archivedBy',
  'video',
  'thumbnail',
];

const ALLOWED_FIELDS = [
  'name',
  'type',
  'equipment',
  'primaryMuscle',
  'secondaryMuscle',
  'level',
  'description',
  'youtubeUrl',
  'status',
];

const assertShape = (body) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  const forbidden = FORBIDDEN_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (forbidden.length > 0) fail(`Field(s) not accepted from the client: ${forbidden.join(', ')}`);
  const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.includes(key));
  if (unknown.length > 0) fail(`Unknown field(s): ${unknown.join(', ')}`);
};

export const validateCreateWorkout = (body = {}) => {
  assertShape(body);

  return {
    name: requiredText(body.name, { label: 'name', max: MAX_NAME }),
    type: validateEnum(body.type, WORKOUT_TYPES, 'type'),
    equipment: validateEnum(body.equipment, WORKOUT_EQUIPMENT, 'equipment'),
    primaryMuscle: requiredText(body.primaryMuscle, { label: 'primaryMuscle', max: MAX_MUSCLE }),
    secondaryMuscle: optionalText(body.secondaryMuscle, { label: 'secondaryMuscle', max: MAX_MUSCLE }) ?? null,
    level: validateLevel(body.level),
    description: requiredText(body.description, { label: 'description', max: MAX_DESCRIPTION }),
    youtubeUrl: validateYoutubeUrl(body.youtubeUrl) ?? null,
    status: body.status === undefined ? 'active' : validateEnum(body.status, WORKOUT_STATUSES, 'status'),
  };

  // Deliberately NOT checked: whether another workout has this name. Legacy has
  // no unique constraint on it and never checked either.
};

/** Partial update: only the supplied fields change. */
export const validateUpdateWorkout = (body = {}) => {
  assertShape(body);

  const patch = {};
  if (body.name !== undefined) patch.name = requiredText(body.name, { label: 'name', max: MAX_NAME });
  if (body.type !== undefined) patch.type = validateEnum(body.type, WORKOUT_TYPES, 'type');
  if (body.equipment !== undefined) patch.equipment = validateEnum(body.equipment, WORKOUT_EQUIPMENT, 'equipment');
  if (body.primaryMuscle !== undefined) {
    patch.primaryMuscle = requiredText(body.primaryMuscle, { label: 'primaryMuscle', max: MAX_MUSCLE });
  }
  if (body.secondaryMuscle !== undefined) {
    patch.secondaryMuscle = optionalText(body.secondaryMuscle, { label: 'secondaryMuscle', max: MAX_MUSCLE });
  }
  if (body.level !== undefined) patch.level = validateLevel(body.level);
  if (body.description !== undefined) {
    patch.description = requiredText(body.description, { label: 'description', max: MAX_DESCRIPTION });
  }
  if (body.youtubeUrl !== undefined) patch.youtubeUrl = validateYoutubeUrl(body.youtubeUrl);
  if (body.status !== undefined) patch.status = validateEnum(body.status, WORKOUT_STATUSES, 'status');

  if (Object.keys(patch).length === 0) fail('No editable fields supplied');
  return patch;
};

/**
 * List query. `limit`, `sortBy` and `sortOrder` are accepted as aliases of the
 * portal-wide `pageSize`, `sortKey` and `sortDir`.
 */
export const validateWorkoutListQuery = (query = {}) => {
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
  if (query.type !== undefined && query.type !== '') out.type = validateEnum(query.type, WORKOUT_TYPES, 'type');
  if (query.equipment !== undefined && query.equipment !== '') {
    out.equipment = validateEnum(query.equipment, WORKOUT_EQUIPMENT, 'equipment');
  }
  if (query.level !== undefined && query.level !== '') out.level = validateLevel(query.level);
  if (query.status !== undefined && query.status !== '') {
    out.status = validateEnum(query.status, WORKOUT_STATUSES, 'status');
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
