import mongoose from 'mongoose';

import { COACH_LEVELS, COACH_STATUSES } from '../models/coach.model.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * Backend-owned validation for the Coach admin API. Only the level is required;
 * everything else is optional, with length limits so free text stays bounded.
 */

const MAX_SPECIALIZATION = 200;
const MAX_DESCRIPTION = 2000;
const MAX_LANGUAGES = 20;
const MAX_LANGUAGE = 50;
const MAX_URL = 500;
const MAX_COUNTER = 100000;

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const optionalText = (value, label, max) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const text = value.trim();
  if (text.length > max) fail(`${label} must be at most ${max} characters`);
  return text === '' ? null : text;
};

const optionalUrl = (value, label) => {
  const text = optionalText(value, label, MAX_URL);
  if (text === undefined || text === null) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(`${label} must be a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(`${label} must be an http(s) URL`);
  return text;
};

const optionalCounter = (value, label) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(`${label} must be a whole number`);
  if (value < 0 || value > MAX_COUNTER) fail(`${label} must be between 0 and ${MAX_COUNTER}`);
  return value;
};

const validateLevel = (value) => {
  if (!COACH_LEVELS.includes(value)) fail(`profile.level must be one of: ${COACH_LEVELS.join(', ')}`);
  return value;
};

const validateLanguages = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) fail('profile.languages must be an array of strings');
  if (value.length > MAX_LANGUAGES) fail(`profile.languages may contain at most ${MAX_LANGUAGES} entries`);

  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') fail('profile.languages must be an array of strings');
    const language = entry.trim();
    if (language === '') continue;
    if (language.length > MAX_LANGUAGE) {
      fail(`each language must be at most ${MAX_LANGUAGE} characters`);
    }
    const key = language.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(language);
    }
  }
  return out;
};

const PROFILE_FIELDS = [
  'level',
  'specialization',
  'description',
  'languages',
  'facebook',
  'instagram',
  'linkedin',
  'transformations',
  'availableSlots',
];

/**
 * Only fields that are actually supplied come back, so the same function serves
 * a full create and a partial edit. Unknown keys are rejected rather than dropped
 * - an unknown key usually means the portal is sending a User field (name, email)
 * that must not be copied onto the coach.
 */
const validateProfile = (value, { requireLevel }) => {
  if (!isPlainObject(value)) fail('profile must be an object');

  const unknown = Object.keys(value).filter((key) => !PROFILE_FIELDS.includes(key));
  if (unknown.length > 0) fail(`Unknown profile field(s): ${unknown.join(', ')}`);

  const out = {};
  if (value.level !== undefined || requireLevel) {
    if (value.level === undefined || value.level === null || value.level === '') {
      fail('profile.level is required');
    }
    out.level = validateLevel(value.level);
  }

  const entries = {
    specialization: optionalText(value.specialization, 'profile.specialization', MAX_SPECIALIZATION),
    description: optionalText(value.description, 'profile.description', MAX_DESCRIPTION),
    languages: validateLanguages(value.languages),
    facebook: optionalUrl(value.facebook, 'profile.facebook'),
    instagram: optionalUrl(value.instagram, 'profile.instagram'),
    linkedin: optionalUrl(value.linkedin, 'profile.linkedin'),
    transformations: optionalCounter(value.transformations, 'profile.transformations'),
    availableSlots: optionalCounter(value.availableSlots, 'profile.availableSlots'),
  };
  for (const [key, entry] of Object.entries(entries)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
};

const validateStatus = (value) => {
  if (!COACH_STATUSES.includes(value)) fail(`status must be one of: ${COACH_STATUSES.join(', ')}`);
  return value;
};

/**
 * Fields a client may never set. Rejected loudly rather than dropped silently,
 * so a portal bug surfaces instead of appearing to work. roles in particular:
 * the "coach" role is granted by creating the profile, never by the request.
 */
const FORBIDDEN_FIELDS = [
  'id',
  '_id',
  'user',
  'roles',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
];

const assertNoForbiddenFields = (body, extra = []) => {
  const present = [...FORBIDDEN_FIELDS, ...extra].filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  if (present.length > 0) fail(`Field(s) not accepted from the client: ${present.join(', ')}`);
};

export const validateCreateCoach = (body = {}) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  assertNoForbiddenFields(body);

  if (typeof body.userId !== 'string' || !mongoose.isValidObjectId(body.userId)) {
    fail('userId must be a valid id');
  }

  return {
    userId: body.userId,
    profile: validateProfile(body.profile, { requireLevel: true }),
    status: body.status === undefined ? 'active' : validateStatus(body.status),
  };
};

/**
 * PATCH: only the supplied fields change. userId is refused outright - the
 * User <-> Coach link is fixed at creation and is never silently reassigned.
 */
export const validateUpdateCoach = (body = {}) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  assertNoForbiddenFields(body, ['userId']);

  const patch = {};
  if (body.profile !== undefined) patch.profile = validateProfile(body.profile, { requireLevel: false });
  if (body.status !== undefined) patch.status = validateStatus(body.status);

  const profileChanges = patch.profile ? Object.keys(patch.profile).length : 0;
  if (profileChanges === 0 && patch.status === undefined) fail('No editable fields supplied');
  if (profileChanges === 0) delete patch.profile;
  return patch;
};

const SORT_KEYS = ['createdAt', 'updatedAt', 'level', 'status'];

export const validateCoachListQuery = (query = {}) => {
  const out = {};

  if (query.page !== undefined) {
    const page = Number.parseInt(query.page, 10);
    if (Number.isNaN(page) || page < 1) fail('page must be a positive integer');
    out.page = page;
  }

  if (query.pageSize !== undefined) {
    const pageSize = Number.parseInt(query.pageSize, 10);
    if (Number.isNaN(pageSize) || pageSize < 1) fail('pageSize must be a positive integer');
    out.pageSize = pageSize;
  }

  if (query.status !== undefined && query.status !== '') out.status = validateStatus(query.status);
  if (query.level !== undefined && query.level !== '') out.level = validateLevel(query.level);
  if (query.search !== undefined) out.search = String(query.search);

  if (query.sortKey !== undefined && query.sortKey !== '') {
    if (!SORT_KEYS.includes(query.sortKey)) fail(`sortKey must be one of: ${SORT_KEYS.join(', ')}`);
    out.sortKey = query.sortKey;
  }
  if (query.sortDir !== undefined) out.sortDir = query.sortDir === 'asc' ? 'asc' : 'desc';

  return out;
};

/**
 * GET /api/coaches/:id/plans - paging only. Anything else in the query (a
 * `coachLevel`, `level`, `planType`...) is ignored on purpose: the level is
 * the coach's, read from MongoDB, and is not something a client can choose.
 */
export const validateCoachPlansQuery = (query = {}) => {
  const out = {};
  if (query.page !== undefined) {
    const page = Number.parseInt(query.page, 10);
    if (Number.isNaN(page) || page < 1) fail('page must be a positive integer');
    out.page = page;
  }
  if (query.pageSize !== undefined) {
    const pageSize = Number.parseInt(query.pageSize, 10);
    if (Number.isNaN(pageSize) || pageSize < 1) fail('pageSize must be a positive integer');
    out.pageSize = pageSize;
  }
  return out;
};

/** GET /admin/users/search - the phone is the only search key. */
export const validateUserPhoneSearch = (query = {}) => {
  if (typeof query.phone !== 'string' || query.phone.trim() === '') fail('phone is required');
  return { phone: query.phone };
};

/** GET /api/coaches - paging and a free-text search. No filters or sorting. */
export const validateMemberCoachListQuery = (query = {}) => {
  const out = {};
  if (query.page !== undefined) {
    const page = Number.parseInt(query.page, 10);
    if (Number.isNaN(page) || page < 1) fail('page must be a positive integer');
    out.page = page;
  }
  if (query.pageSize !== undefined) {
    const pageSize = Number.parseInt(query.pageSize, 10);
    if (Number.isNaN(pageSize) || pageSize < 1) fail('pageSize must be a positive integer');
    out.pageSize = pageSize;
  }
  if (query.search !== undefined) {
    const search = String(query.search);
    if (search.length > 100) fail('search must be at most 100 characters');
    out.search = search;
  }
  return out;
};
