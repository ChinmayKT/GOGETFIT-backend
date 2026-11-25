import mongoose from 'mongoose';

import { TALK_EVENT_KINDS, TALK_LIMITS as L } from '../models/talks.models.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/** Backend-owned validation for TALKS (admin writes, member reads and engagement). */

export const TALK_ADMIN_FILTERS = ['all', 'draft', 'published', 'unpublished', 'archived', 'attention'];
export const TALK_SORT_KEYS = ['displayOrder', 'title', 'createdAt', 'updatedAt', 'listedAt'];
const MAX_PAGE_SIZE = 50;
const MAX_SEARCH = 100;
const MAX_URL = 500;

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value, label, { max, required }) => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') fail(`${label} must be text`);
  const t = value.trim();
  if (required && t === '') fail(`${label} is required`);
  if (t.length > max) fail(`${label} must be at most ${max} characters`);
  return t;
};

const integer = (value, label, { min, max }) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number from ${min} to ${max}`);
  return n;
};

const bool = (value, label) => {
  if (typeof value !== 'boolean') fail(`${label} must be true or false`);
  return value;
};

/** null clears; a date string sets. */
const optionalDate = (value, label) => {
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) fail(`${label} must be a date`);
  return d;
};

const optionalDuration = (value) =>
  value === null || value === '' ? null : integer(value, 'Duration (seconds)', { min: 1, max: L.maxDurationSeconds });

export const assertObjectId = (id, label = 'id') => {
  if (!mongoose.isValidObjectId(id)) fail(`${label} is not valid`);
  return String(id);
};

const page = (query) => ({
  page: query.page === undefined ? 1 : integer(query.page, 'page', { min: 1, max: 100000 }),
  pageSize: query.pageSize === undefined ? 20 : integer(query.pageSize, 'pageSize', { min: 1, max: MAX_PAGE_SIZE }),
});

const youtubeUrl = (value) => text(value, 'YouTube URL', { max: MAX_URL, required: true });

/** POST /admin/talks/preview */
export const validatePreview = (body) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  return { youtubeUrl: youtubeUrl(body.youtubeUrl) };
};

/** The editable fields, shared by create and update. */
const editable = (body, out) => {
  if (body.title !== undefined) out.title = text(body.title, 'Title', { max: L.title, required: false });
  if (body.description !== undefined) out.description = text(body.description, 'Description', { max: L.description, required: false });
  if (body.channelName !== undefined) out.channelName = text(body.channelName, 'Channel name', { max: L.channelName, required: false }) || null;
  if (body.isFeatured !== undefined) out.isFeatured = bool(body.isFeatured, 'Featured');
  if (body.displayOrder !== undefined) out.displayOrder = integer(body.displayOrder, 'Display order', { min: 0, max: L.maxDisplayOrder });
  if (body.durationSeconds !== undefined) out.durationSeconds = optionalDuration(body.durationSeconds);
  if (body.publishedAt !== undefined) out.publishedAt = optionalDate(body.publishedAt, 'Published date');
  return out;
};

/** POST /admin/talks - a YouTube link; the rest is optional. */
export const validateCreateTalk = (body) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  const out = editable(body, { youtubeUrl: youtubeUrl(body.youtubeUrl) });
  if (body.status !== undefined && !['draft', 'published'].includes(body.status)) fail('status must be draft or published');
  out.status = body.status ?? 'draft';
  return out;
};

const FORBIDDEN_UPDATE = ['youtubeUrl', 'youtubeVideoId', 'status', 'viewCount', 'thumbnailUrl'];

/** PUT /admin/talks/:id - only the fields sent change. The video (link) never does. */
export const validateUpdateTalk = (body) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  for (const key of FORBIDDEN_UPDATE) if (body[key] !== undefined) fail(`${key} cannot be changed here`);
  const out = editable(body, {});
  if (Object.keys(out).length === 0) fail('Nothing to update');
  return out;
};

/** GET /admin/talks */
export const validateAdminListQuery = (query = {}) => {
  const status = query.status ?? 'all';
  if (!TALK_ADMIN_FILTERS.includes(status)) fail(`status must be one of: ${TALK_ADMIN_FILTERS.join(', ')}`);
  const sortKey = query.sortKey ?? 'createdAt';
  if (!TALK_SORT_KEYS.includes(sortKey)) fail(`sortKey must be one of: ${TALK_SORT_KEYS.join(', ')}`);
  const sortDir = query.sortDir ?? 'desc';
  if (!['asc', 'desc'].includes(sortDir)) fail('sortDir must be asc or desc');
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, MAX_SEARCH) : '';
  return { status, sortKey, sortDir, search, ...page(query) };
};

/** GET /talks?page&pageSize */
export const validateMemberListQuery = (query = {}) => page(query);

/** GET /talks/saved */
export const validatePageQuery = (query = {}) => page(query);

/** POST /talks/:id/events */
export const validateEvent = (body) => {
  if (!isPlainObject(body) || !TALK_EVENT_KINDS.includes(body.kind)) {
    fail(`kind must be one of: ${TALK_EVENT_KINDS.join(', ')}`);
  }
  return { kind: body.kind };
};
