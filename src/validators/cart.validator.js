import mongoose from 'mongoose';

import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * Backend-owned validation for the member cart.
 *
 * Note what is NOT accepted anywhere here: userId, price, discount or total.
 * The owner comes from the token and every figure is computed by the server, so
 * there is nothing for a client to misreport.
 */

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const objectId = (value, label) => {
  if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) fail(`${label} must be a valid id`);
  return value;
};

const assertShape = (body, allowed) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  const forbidden = ['userId', 'price', 'amount', 'discount', 'discountAmount', 'total', 'finalAmount'].filter((f) =>
    Object.prototype.hasOwnProperty.call(body, f),
  );
  if (forbidden.length > 0) fail(`Field(s) not accepted from the client: ${forbidden.join(', ')}`);
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`Unknown field(s): ${unknown.join(', ')}`);
};

export const validateAddToCart = (body = {}) => {
  assertShape(body, ['coachId', 'planId']);
  return {
    coachId: objectId(body.coachId, 'coachId'),
    planId: objectId(body.planId, 'planId'),
  };
};

/** A coupon may be named by id or by code; neither is required. */
const validateCouponChoice = (body) => {
  const out = { couponId: null, couponCode: null };
  if (body.couponId !== undefined && body.couponId !== null && body.couponId !== '') {
    out.couponId = objectId(body.couponId, 'couponId');
  }
  if (body.couponCode !== undefined && body.couponCode !== null && body.couponCode !== '') {
    if (typeof body.couponCode !== 'string') fail('couponCode must be a string');
    const code = body.couponCode.trim();
    if (code.length > 40) fail('couponCode must be at most 40 characters');
    out.couponCode = code;
  }
  return out;
};

export const validateQuote = (body = {}) => {
  assertShape(body, ['couponId', 'couponCode']);
  return validateCouponChoice(body);
};

export const validatePurchase = (body = {}) => {
  assertShape(body, ['couponId', 'couponCode', 'paymentReference', 'paymentMethod']);

  /**
   * The payment gateway's own reference. It is what makes the purchase
   * idempotent, so it is required even while the gateway is not yet wired -
   * the client generates one per checkout attempt and reuses it on retry.
   */
  if (typeof body.paymentReference !== 'string' || body.paymentReference.trim() === '') {
    fail('paymentReference is required');
  }
  const paymentReference = body.paymentReference.trim();
  if (paymentReference.length > 120) fail('paymentReference must be at most 120 characters');

  let paymentMethod;
  if (body.paymentMethod !== undefined && body.paymentMethod !== null && body.paymentMethod !== '') {
    const allowed = ['cash', 'upi', 'bank_transfer', 'other'];
    if (!allowed.includes(body.paymentMethod)) fail(`paymentMethod must be one of: ${allowed.join(', ')}`);
    paymentMethod = body.paymentMethod;
  }

  return { ...validateCouponChoice(body), paymentReference, paymentMethod: paymentMethod ?? null };
};
