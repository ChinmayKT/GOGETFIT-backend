export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_PHONE: 'INVALID_PHONE',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  REGISTRATION_DISABLED: 'REGISTRATION_DISABLED',
  OTP_NOT_FOUND: 'OTP_NOT_FOUND',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_INVALID: 'OTP_INVALID',
  OTP_ALREADY_USED: 'OTP_ALREADY_USED',
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  PHONE_ALREADY_REGISTERED: 'PHONE_ALREADY_REGISTERED',
  // A free diet plan already covers this diet type and calorie band. Mirrors the
  // legacy IsPlanExist refusal ("Same Plan parameters already exists").
  PLAN_ALREADY_EXISTS: 'PLAN_ALREADY_EXISTS',
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  // No pre-authored template covers this member's target calories for their diet
  // preference. The legacy data has real gaps, so this is a normal outcome.
  FREE_DIET_PLAN_NOT_FOUND: 'FREE_DIET_PLAN_NOT_FOUND',
  // The stored profile is missing an input the plan lookup needs.
  PROFILE_INCOMPLETE: 'PROFILE_INCOMPLETE',
  // One user can hold exactly one coach profile.
  COACH_ALREADY_EXISTS: 'COACH_ALREADY_EXISTS',
  COACH_NOT_FOUND: 'COACH_NOT_FOUND',
  GOGETFIT_PLAN_NOT_FOUND: 'GOGETFIT_PLAN_NOT_FOUND',
  EMAIL_ALREADY_VERIFIED: 'EMAIL_ALREADY_VERIFIED',
  UNSUPPORTED_IMAGE_TYPE: 'UNSUPPORTED_IMAGE_TYPE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

export class AppError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, AppError);
  }
}

export const badRequest = (code, message, details) => new AppError(400, code, message, details);
export const unauthorized = (code, message) => new AppError(401, code, message);
/** Authenticated, but not allowed to perform this action. */
export const forbidden = (code, message) => new AppError(403, code, message);
/**
 * `details` is optional and exists for the cases where "not found" needs to say
 * what was looked for - a member whose calorie target falls in a gap between
 * free diet plans has to be told the diet type and the target, not just "404".
 */
export const notFound = (code, message, details) => new AppError(404, code, message, details);
export const conflict = (code, message) => new AppError(409, code, message);
export const tooManyRequests = (code, message, details) =>
  new AppError(429, code, message, details);
