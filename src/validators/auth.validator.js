import { ERROR_CODES, badRequest } from '../utils/errors.js';

export const validateRequestOtp = (body = {}) => {
  if (typeof body.phone !== 'string' || body.phone.trim() === '') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'phone is required');
  }
  return { phone: body.phone.trim() };
};

export const validateVerifyOtp = (body = {}) => {
  if (typeof body.phone !== 'string' || body.phone.trim() === '') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'phone is required');
  }

  const otp = body.otp === undefined ? body.code : body.otp;
  if (otp === undefined || otp === null || !/^\d{4}$/.test(String(otp))) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'otp must be a 4-digit code');
  }

  return { phone: body.phone.trim(), otp: String(otp) };
};
