import { INTRO_VIDEO_LIMITS as L, INTRO_VIDEO_STATUSES } from '../models/intro-video.model.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/** Backend-owned validation for Introductory Videos (the workout rules' shape). */

export const INTRO_VIDEO_SORT_KEYS = ['position', 'title', 'createdAt', 'updatedAt'];
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH = 100;

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const requiredText = (value, label, max) => {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  const text = value.trim();
  if (text.length > max) fail(`${label} must be at most ${max} characters`);
  return text;
};

const optionalText = (value, label, max) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const text = value.trim();
  if (text.length > max) fail(`${label} must be at most ${max} characters`);
  return text === '' ? null : text;
};

const integer = (value, label, { min, max }) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number from ${min} to ${max}`);
  return n;
};

/** The checklist: up to 12 non-blank items; blanks are dropped. */
const learnList = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) fail('whatYoullLearn must be a list');
  const items = value.map((item) => {
    if (typeof item !== 'string') fail('whatYoullLearn items must be text');
    const text = item.trim();
    if (text.length > L.learnItem) fail(`Each whatYoullLearn item must be at most ${L.learnItem} characters`);
    return text;
  }).filter(Boolean);
  if (items.length > L.learnItems) fail(`whatYoullLearn can have at most ${L.learnItems} items`);
  return items;
};

/** Fields a client may never set; media has its own upload endpoints. */
const FORBIDDEN = ['id', '_id', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'archivedAt', 'archivedBy', 'video', 'thumbnail'];
const ALLOWED = ['title', 'subtitle', 'description', 'whatYoullLearn', 'notes', 'tips', 'position', 'durationSeconds', 'status'];

const assertShape = (body) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  const forbidden = FORBIDDEN.filter((f) => Object.prototype.hasOwnProperty.call(body, f));
  if (forbidden.length) fail(`Field(s) not accepted from the client: ${forbidden.join(', ')}`);
  const unknown = Object.keys(body).filter((k) => !ALLOWED.includes(k));
  if (unknown.length) fail(`Unknown field(s): ${unknown.join(', ')}`);
};

const status = (value) => {
  if (!INTRO_VIDEO_STATUSES.includes(value)) fail(`status must be one of: ${INTRO_VIDEO_STATUSES.join(', ')}`);
  return value;
};

const duration = (value) =>
  value === undefined ? undefined : value === null || value === '' ? null : integer(value, 'durationSeconds', { min: 0, max: L.maxDurationSeconds });

export const validateCreateIntroVideo = (body = {}) => {
  assertShape(body);
  return {
    title: requiredText(body.title, 'title', L.title),
    subtitle: optionalText(body.subtitle, 'subtitle', L.subtitle) ?? null,
    description: requiredText(body.description, 'description', L.description),
    whatYoullLearn: learnList(body.whatYoullLearn) ?? [],
    notes: optionalText(body.notes, 'notes', L.note) ?? null,
    tips: optionalText(body.tips, 'tips', L.note) ?? null,
    // Omitted: placed after the last one (the service decides).
    position: body.position === undefined ? undefined : integer(body.position, 'position', { min: 1, max: L.maxPosition }),
    durationSeconds: duration(body.durationSeconds) ?? null,
    status: body.status === undefined ? 'active' : status(body.status),
  };
};

/** Partial update: only the supplied fields change. */
export const validateUpdateIntroVideo = (body = {}) => {
  assertShape(body);
  const patch = {};
  if (body.title !== undefined) patch.title = requiredText(body.title, 'title', L.title);
  if (body.subtitle !== undefined) patch.subtitle = optionalText(body.subtitle, 'subtitle', L.subtitle);
  if (body.description !== undefined) patch.description = requiredText(body.description, 'description', L.description);
  if (body.whatYoullLearn !== undefined) patch.whatYoullLearn = learnList(body.whatYoullLearn);
  if (body.notes !== undefined) patch.notes = optionalText(body.notes, 'notes', L.note);
  if (body.tips !== undefined) patch.tips = optionalText(body.tips, 'tips', L.note);
  if (body.position !== undefined) patch.position = integer(body.position, 'position', { min: 1, max: L.maxPosition });
  if (body.durationSeconds !== undefined) patch.durationSeconds = duration(body.durationSeconds);
  if (body.status !== undefined) patch.status = status(body.status);
  if (Object.keys(patch).length === 0) fail('No editable fields supplied');
  return patch;
};

/** Admin list query: page, pageSize, search, status, sortKey, sortDir. */
export const validateIntroVideoListQuery = (query = {}) => {
  const out = {};
  if (query.page !== undefined) out.page = integer(query.page, 'page', { min: 1, max: 100000 });
  if (query.pageSize !== undefined) out.pageSize = integer(query.pageSize, 'pageSize', { min: 1, max: MAX_PAGE_SIZE });
  if (query.search !== undefined) {
    if (typeof query.search !== 'string') fail('search must be text');
    const search = query.search.trim();
    if (search.length > MAX_SEARCH) fail(`search must be at most ${MAX_SEARCH} characters`);
    out.search = search;
  }
  if (query.status !== undefined && query.status !== '') out.status = status(query.status);
  if (query.sortKey !== undefined && query.sortKey !== '') {
    if (!INTRO_VIDEO_SORT_KEYS.includes(query.sortKey)) fail(`sortKey must be one of: ${INTRO_VIDEO_SORT_KEYS.join(', ')}`);
    out.sortKey = query.sortKey;
  }
  if (query.sortDir !== undefined && query.sortDir !== '') {
    if (!['asc', 'desc'].includes(query.sortDir)) fail('sortDir must be asc or desc');
    out.sortDir = query.sortDir;
  }
  return out;
};
