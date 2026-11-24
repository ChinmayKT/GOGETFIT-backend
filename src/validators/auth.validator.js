import { ERROR_CODES, badRequest } from '../utils/errors.js';

/** Optional ISO country of the number ("AU"); checked against the number later. */
const countryIsoOf = (body) => {
  const value = body.countryIso;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value.trim())) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'countryIso must be a 2-letter country code');
  }
  return value.trim().toUpperCase();
};

export const validateRequestOtp = (body = {}) => {
  if (typeof body.phone !== 'string' || body.phone.trim() === '') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'phone is required');
  }
  return { phone: body.phone.trim(), countryIso: countryIsoOf(body) };
};

export const validateVerifyOtp = (body = {}) => {
  if (typeof body.phone !== 'string' || body.phone.trim() === '') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'phone is required');
  }

  const otp = body.otp === undefined ? body.code : body.otp;
  if (otp === undefined || otp === null || !/^\d{4}$/.test(String(otp))) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'otp must be a 4-digit code');
  }

  return { phone: body.phone.trim(), otp: String(otp), countryIso: countryIsoOf(body) };
};
