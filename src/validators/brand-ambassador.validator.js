import mongoose from 'mongoose';

import { isCalendarDay } from '../utils/business-date.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * Brand Ambassador request validation. Registration takes no body at all: the
 * owner is the token's user and every term comes from the server.
 */

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const optionalString = (value, label, max = 120) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(`${label} must be at most ${max} characters`);
  return trimmed || undefined;
};

const oneOf = (value, label, allowed) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (!allowed.includes(value)) fail(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
};

const positiveInt = (value, label, max) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) fail(`${label} must be a whole number from 1 to ${max}`);
  return n;
};

const day = (value, label) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isCalendarDay(value)) fail(`${label} must be a date written yyyy-mm-dd`);
  return value;
};

/** POST /ambassadors/register - nothing is accepted from the client. */
export const validateRegister = (body) => {
  if (body !== undefined && body !== null && isPlainObject(body) && Object.keys(body).length > 0) {
    fail(`Field(s) not accepted from the client: ${Object.keys(body).join(', ')}`);
  }
};

export const validateAmbassadorListQuery = (q = {}) => ({
  search: optionalString(q.search ?? q.query, 'search'),
  status: { Active: 'active', Inactive: 'inactive', active: 'active', inactive: 'inactive' }[q.status] ??
    oneOf(q.status, 'status', ['Active', 'Inactive']),
  joinedWithinDays: positiveInt(q.joinedWithinDays, 'joinedWithinDays', 3650),
  sortKey: optionalString(q.sortKey, 'sortKey', 40),
  sortDir: oneOf(q.sortDir, 'sortDir', ['asc', 'desc']),
  page: positiveInt(q.page, 'page', 100000),
  pageSize: positiveInt(q.pageSize, 'pageSize', 1000),
});

export const validateReferralListQuery = (q = {}) => {
  const from = day(q.from, 'from');
  const to = day(q.to, 'to');
  if (from && to && from > to) fail('from must not be after to');
  if (q.planId && !mongoose.isValidObjectId(q.planId)) fail('planId must be a valid id');
  return {
    search: optionalString(q.search ?? q.query, 'search'),
    planId: q.planId || undefined,
    paymentStatus: optionalString(q.paymentStatus, 'paymentStatus', 40),
    referralStatus: oneOf(q.referralStatus, 'referralStatus', ['Pending', 'Successful']),
    from,
    to,
    page: positiveInt(q.page, 'page', 100000),
    pageSize: positiveInt(q.pageSize, 'pageSize', 1000),
  };
};

export const validateStatusChange = (body = {}) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  const unknown = Object.keys(body).filter((k) => !['status', 'reason'].includes(k));
  if (unknown.length) fail(`Unknown field(s): ${unknown.join(', ')}`);
  const status = { Active: 'active', Inactive: 'inactive', active: 'active', inactive: 'inactive' }[body.status];
  if (!status) fail('status must be Active or Inactive');
  return { status, reason: optionalString(body.reason, 'reason', 500) ?? null };
};

export const validateCommission = (body = {}) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  const unknown = Object.keys(body).filter((k) => !['commissionPercent', 'reason'].includes(k));
  if (unknown.length) fail(`Unknown field(s): ${unknown.join(', ')}`);
  if (typeof body.commissionPercent !== 'number') fail('commissionPercent must be a number');
  return { commissionPercent: body.commissionPercent, reason: optionalString(body.reason, 'reason', 500) ?? null };
};

export const validatePayout = (body = {}) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  const allowed = ['period', 'amount', 'paidAt', 'reference', 'status'];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) fail(`Unknown field(s): ${unknown.join(', ')}`);
  if (typeof body.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.period)) fail('period must be written yyyy-mm');
  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount < 0) fail('amount must be a positive number');
  const paidDay = day(body.paidAt, 'paidAt');
  if (!paidDay) fail('paidAt is required');
  const reference = optionalString(body.reference, 'reference', 120);
  if (!reference) fail('reference is required');
  const status = { Paid: 'paid', Processing: 'processing', paid: 'paid', processing: 'processing' }[body.status];
  if (!status) fail('status must be Paid or Processing');
  return { period: body.period, amount: body.amount, paidAt: new Date(`${paidDay}T00:00:00.000Z`), reference, status };
};
