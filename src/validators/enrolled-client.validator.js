import mongoose from 'mongoose';

import { ENROLLMENT_STATUSES, PAYMENT_METHODS } from '../models/enrolled-client.model.js';
import { isCalendarDay, startOfBusinessDay } from '../utils/business-date.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * Validation for the admin enrollment endpoints: the list query, and the
 * manual-enrollment (Add Client) body.
 */

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const SORT_KEYS = ['enrollDate', 'startDate', 'endDate', 'amount', 'createdAt'];
const ID_FILTERS = ['userId', 'coachId', 'planId', 'couponId'];

export const validateEnrolledClientListQuery = (query = {}) => {
  const out = {};

  if (query.page !== undefined) {
    const page = Number.parseInt(query.page, 10);
    if (Number.isNaN(page) || page < 1) fail('page must be a positive integer');
    out.page = page;
  }

  if (query.pageSize !== undefined) {
    const pageSize = Number.parseInt(query.pageSize, 10);
    if (Number.isNaN(pageSize) || pageSize < 1) fail('pageSize must be a positive integer');
    // Clamped by the service rather than rejected, as the other admin lists do.
    out.pageSize = pageSize;
  }

  for (const field of ID_FILTERS) {
    if (query[field] === undefined || query[field] === '') continue;
    if (!mongoose.isValidObjectId(query[field])) fail(`${field} must be a valid id`);
    out[field] = String(query[field]);
  }

  if (query.status !== undefined && query.status !== '') {
    if (!ENROLLMENT_STATUSES.includes(query.status)) {
      fail(`status must be one of: ${ENROLLMENT_STATUSES.join(', ')}`);
    }
    out.status = query.status;
  }

  if (query.hasStarted !== undefined && query.hasStarted !== '') {
    if (!['true', 'false'].includes(String(query.hasStarted))) {
      fail('hasStarted must be true or false');
    }
    out.hasStarted = String(query.hasStarted) === 'true';
  }

  if (query.search !== undefined) out.search = String(query.search);

  if (query.sortKey !== undefined && query.sortKey !== '') {
    if (!SORT_KEYS.includes(query.sortKey)) fail(`sortKey must be one of: ${SORT_KEYS.join(', ')}`);
    out.sortKey = query.sortKey;
  }

  if (query.sortDir !== undefined) out.sortDir = query.sortDir === 'asc' ? 'asc' : 'desc';

  return out;
};

// --- POST /api/admin/enrolled-clients (admin manual enrollment) --------------------------

const BODY_FIELDS = ['userId', 'planId', 'coachId', 'couponId', 'enrollDate', 'startDate', 'endDate', 'payment'];
const PAYMENT_FIELDS = ['method', 'amount', 'paymentDate', 'referenceId', 'notes'];
/** Methods whose payment can only be traced by its reference. */
const REFERENCE_REQUIRED = ['upi', 'bank_transfer'];
const MAX_REFERENCE = 100;
const MAX_NOTES = 1000;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlank = (value) => value === undefined || value === null || value === '';

const requiredId = (value, field) => {
  if (isBlank(value)) fail(`${field} is required`);
  if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) fail(`${field} must be a valid id`);
  return value;
};

/** A business-timezone calendar day, or null when optional and absent. */
const calendarDay = (value, field, { required }) => {
  if (isBlank(value)) {
    if (required) fail(`${field} is required`);
    return null;
  }
  if (!isCalendarDay(value)) fail(`${field} must be a valid date (yyyy-mm-dd)`);
  return startOfBusinessDay(value);
};

const optionalText = (value, field, max) => {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') fail(`${field} must be a string`);
  const text = value.trim();
  if (text.length > max) fail(`${field} must be at most ${max} characters`);
  return text === '' ? null : text;
};

/**
 * The Add Client body. Only what the admin chose is accepted: prices, the
 * discount, the payment status, hasStarted and every audit field are worked out
 * by the server, so sending any of them is refused rather than ignored.
 */
export const validateManualEnrollment = (body = {}) => {
  if (!isPlainObject(body)) fail('Request body must be an object');
  const unknown = Object.keys(body).filter((k) => !BODY_FIELDS.includes(k));
  if (unknown.length) fail(`Field(s) not accepted: ${unknown.join(', ')}. Prices, discounts, status and audit fields are set by the server.`);

  const out = {
    userId: requiredId(body.userId, 'userId'),
    planId: requiredId(body.planId, 'planId'),
    coachId: requiredId(body.coachId, 'coachId'),
    couponId: isBlank(body.couponId) ? null : requiredId(body.couponId, 'couponId'),
    enrollDate: calendarDay(body.enrollDate, 'enrollDate', { required: true }),
    // Both optional: an enrollment may be recorded before the plan is scheduled.
    startDate: calendarDay(body.startDate, 'startDate', { required: false }),
    endDate: calendarDay(body.endDate, 'endDate', { required: false }),
  };
  if (out.startDate && out.endDate && out.endDate < out.startDate) fail('endDate must be on or after startDate');

  const payment = body.payment;
  if (!isPlainObject(payment)) fail('payment is required');
  const unknownPayment = Object.keys(payment).filter((k) => !PAYMENT_FIELDS.includes(k));
  if (unknownPayment.length) {
    fail(`payment field(s) not accepted: ${unknownPayment.join(', ')}. Plan price, discount and status are set by the server.`);
  }
  if (!PAYMENT_METHODS.includes(payment.method)) fail(`payment.method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  if (typeof payment.amount !== 'number' || !Number.isFinite(payment.amount)) fail('payment.amount must be a number');
  // Whole rupees, as every stored payment amount is.
  if (!Number.isInteger(payment.amount) || payment.amount < 0) fail('payment.amount must be a whole number of rupees, 0 or more');
  const referenceId = optionalText(payment.referenceId, 'payment.referenceId', MAX_REFERENCE);
  if (REFERENCE_REQUIRED.includes(payment.method) && !referenceId) {
    fail('payment.referenceId is required for UPI and bank transfer payments');
  }

  out.payment = {
    method: payment.method,
    amount: payment.amount,
    paidAt: calendarDay(payment.paymentDate, 'payment.paymentDate', { required: true }),
    referenceId,
    notes: optionalText(payment.notes, 'payment.notes', MAX_NOTES),
  };
  return out;
};

export default { validateEnrolledClientListQuery, validateManualEnrollment };
