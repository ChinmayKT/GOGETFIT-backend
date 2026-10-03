import { COUPON_VISIBILITIES, DISCOUNT_TYPES, normalizeCouponCode } from '../models/coupon.model.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

const MAX_CODE = 20; // legacy m_coupon.coupon_code varchar(20)
const MAX_DESCRIPTION = 1000;
const CODE_PATTERN = /^[A-Z0-9_-]+$/;

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const validateCode = (value) => {
  if (typeof value !== 'string') fail('code is required');
  const code = normalizeCouponCode(value);
  if (code === '') fail('code is required');
  if (code.length > MAX_CODE) fail(`code must be at most ${MAX_CODE} characters`);
  if (!CODE_PATTERN.test(code)) fail('code may contain only letters, numbers, "-" and "_"');
  return code;
};

const validateDescription = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') fail('description must be a string');
  const text = value.trim();
  if (text.length > MAX_DESCRIPTION) fail(`description must be at most ${MAX_DESCRIPTION} characters`);
  return text === '' ? null : text;
};

const validateDiscount = (value) => {
  if (!isPlainObject(value)) fail('discount must be an object with type and value');
  const unknown = Object.keys(value).filter((k) => !['type', 'value'].includes(k));
  if (unknown.length) fail(`Unknown discount field(s): ${unknown.join(', ')}`);
  if (!DISCOUNT_TYPES.includes(value.type)) fail(`discount.type must be one of: ${DISCOUNT_TYPES.join(', ')}`);
  if (typeof value.value !== 'number' || !Number.isFinite(value.value)) fail('discount.value must be a number');
  if (!Number.isInteger(value.value)) fail('discount.value must be a whole number');
  if (value.value < 1 || value.value > 100) fail('discount.value must be between 1 and 100');
  return { type: value.type, value: value.value };
};

/**
 * A calendar date, yyyy-mm-dd (what a date input sends), stored as that day at
 * UTC midnight. Full timestamps are refused: validity is by calendar day, and a
 * time-of-day would make "which day" ambiguous across timezones.
 */
const validateDate = (value, label) => {
  if (value === undefined || value === null || value === '') fail(`${label} is required`);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} must be a date (yyyy-mm-dd)`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(`${label} must be a valid date`);
  return date;
};

const validateVisibility = (value) => {
  if (!COUPON_VISIBILITIES.includes(value)) fail(`visibility must be one of: ${COUPON_VISIBILITIES.join(', ')}`);
  return value;
};

/**
 * Never from the client: audit fields, status (decided by the dates alone),
 * identity and legacy metadata.
 */
const FORBIDDEN = ['id', '_id', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'status', 'legacy'];
const EDITABLE = ['code', 'description', 'discount', 'validFrom', 'validTo', 'visibility'];

const assertShape = (body) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  const forbidden = FORBIDDEN.filter((f) => Object.prototype.hasOwnProperty.call(body, f));
  if (forbidden.length) fail(`Field(s) not accepted from the client: ${forbidden.join(', ')}`);
  const unknown = Object.keys(body).filter((k) => !EDITABLE.includes(k) && !FORBIDDEN.includes(k));
  if (unknown.length) fail(`Unknown field(s): ${unknown.join(', ')}`);
};

export const assertDateOrder = (validFrom, validTo) => {
  if (validFrom.getTime() > validTo.getTime()) fail('validFrom must be on or before validTo');
};

export const validateCreateCoupon = (body = {}) => {
  assertShape(body);
  const coupon = {
    code: validateCode(body.code),
    description: validateDescription(body.description) ?? null,
    discount: validateDiscount(body.discount),
    validFrom: validateDate(body.validFrom, 'validFrom'),
    validTo: validateDate(body.validTo, 'validTo'),
    visibility: body.visibility === undefined ? 'public' : validateVisibility(body.visibility),
  };
  assertDateOrder(coupon.validFrom, coupon.validTo);
  return coupon;
};

/** PATCH: only supplied fields; the date order is checked against the merged coupon by the service. */
export const validateUpdateCoupon = (body = {}) => {
  assertShape(body);
  const patch = {};
  if (body.code !== undefined) patch.code = validateCode(body.code);
  if (body.description !== undefined) patch.description = validateDescription(body.description);
  if (body.discount !== undefined) patch.discount = validateDiscount(body.discount);
  if (body.validFrom !== undefined) patch.validFrom = validateDate(body.validFrom, 'validFrom');
  if (body.validTo !== undefined) patch.validTo = validateDate(body.validTo, 'validTo');
  if (body.visibility !== undefined) patch.visibility = validateVisibility(body.visibility);
  if (Object.keys(patch).length === 0) fail('No editable fields supplied');
  return patch;
};

const SORT_KEYS = ['code', 'discount', 'validFrom', 'validTo', 'createdAt', 'updatedAt'];
const STATUS_FILTERS = ['active', 'inactive'];

export const validateCouponListQuery = (query = {}) => {
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
  if (query.search !== undefined) out.search = String(query.search);
  if (query.status !== undefined && query.status !== '') {
    // Effective (date-driven) status; empty = all.
    if (!STATUS_FILTERS.includes(query.status)) fail(`status must be one of: ${STATUS_FILTERS.join(', ')}`);
    out.status = query.status;
  }
  if (query.visibility !== undefined && query.visibility !== '') out.visibility = validateVisibility(query.visibility);
  if (query.sortKey !== undefined && query.sortKey !== '') {
    if (!SORT_KEYS.includes(query.sortKey)) fail(`sortKey must be one of: ${SORT_KEYS.join(', ')}`);
    out.sortKey = query.sortKey;
  }
  if (query.sortDir !== undefined) out.sortDir = query.sortDir === 'asc' ? 'asc' : 'desc';
  return out;
};
