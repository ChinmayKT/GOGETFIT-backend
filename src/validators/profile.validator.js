import { ERROR_CODES, badRequest } from '../utils/errors.js';
import { isFutureDate, parseDateOfBirth } from '../utils/age.js';
import { roundBodyFat } from '../utils/round.js';

const ALLOWED_FIELDS = ['name', 'dateOfBirth', 'gender', 'city', 'fitnessProfile'];

/**
 * Numeric fitness fields, with the range a real measurement can fall in.
 *
 * bmr and tdee are energy figures in kcal/day. The app owns the calculation -
 * it is the single implementation, shared with the screens that display these
 * numbers - so the backend stores what it is given and only guards the range.
 * The bounds are what that formula can produce from an accepted height, weight
 * and age; anything outside them is not a figure this system calculated.
 */
const FITNESS_NUMBERS = {
  height: { min: 50, max: 300, label: 'height in cm' },
  weight: { min: 10, max: 500, label: 'weight in kg' },
  bodyFatPercentage: { min: 1, max: 80, label: 'body fat percentage' },
  bmr: { min: 200, max: 10000, label: 'BMR in kcal/day' },
  tdee: { min: 200, max: 20000, label: 'TDEE in kcal/day' },
};

/** Free-form preference fields; the client owns their vocabulary. */
const FITNESS_STRINGS = ['activityLevel', 'foodType', 'goal'];

const FITNESS_FIELDS = [...Object.keys(FITNESS_NUMBERS), ...FITNESS_STRINGS];

/**
 * Validates a partial fitnessProfile. Every field is optional - a member may
 * fill these in over time - and an explicit null clears one.
 */
export const validateFitnessProfile = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'fitnessProfile must be an object');
  }

  const unknown = Object.keys(value).filter((key) => !FITNESS_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      `Unknown fitnessProfile field(s): ${unknown.join(', ')}`,
    );
  }

  const patch = {};

  for (const [field, range] of Object.entries(FITNESS_NUMBERS)) {
    if (value[field] === undefined) continue;
    if (value[field] === null) {
      patch[field] = null;
      continue;
    }

    const number = value[field];
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, `${field} must be a number or null`);
    }
    // Zero is rejected rather than stored: it is not a real measurement, and
    // null is how "not filled in" is represented.
    if (number < range.min || number > range.max) {
      throw badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        `${field} must be a realistic ${range.label} (${range.min}-${range.max})`,
      );
    }
    // Body fat is stored to two decimals; height and weight keep what was sent.
    patch[field] = field === 'bodyFatPercentage' ? roundBodyFat(number) : number;
  }

  for (const field of FITNESS_STRINGS) {
    if (value[field] === undefined) continue;
    if (value[field] === null) {
      patch[field] = null;
      continue;
    }

    if (typeof value[field] !== 'string' || value[field].trim() === '') {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, `${field} must be a non-empty string or null`);
    }
    if (value[field].length > 64) {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, `${field} is too long`);
    }
    patch[field] = value[field].trim();
  }

  if (Object.keys(patch).length === 0) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'No fitnessProfile fields supplied');
  }

  return patch;
};
// Rejected outright so a client can never drive backend-owned state.
const FORBIDDEN_FIELDS = [
  'age',
  'profileCompleted',
  'roles',
  'status',
  'legacy',
  'phone',
  'email',
  'isEmailVerified',
  'profilePicture',
];

export const validateProfilePatch = (body = {}, now = new Date()) => {
  const forbidden = FORBIDDEN_FIELDS.filter((field) => body[field] !== undefined);
  if (forbidden.length > 0) {
    throw badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      `These fields are managed by the backend and cannot be set: ${forbidden.join(', ')}`,
    );
  }

  const patch = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'name must be a non-empty string');
    }
    patch.name = body.name.trim();
  }

  if (body.dateOfBirth !== undefined) {
    const dob = parseDateOfBirth(body.dateOfBirth);
    if (!dob) {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'dateOfBirth must be a valid YYYY-MM-DD date');
    }
    if (isFutureDate(dob, now)) {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'dateOfBirth cannot be in the future');
    }
    patch.dateOfBirth = dob;
  }

  if (body.gender !== undefined) {
    if (body.gender !== 'male' && body.gender !== 'female') {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, "gender must be 'male' or 'female'");
    }
    patch.gender = body.gender;
  }

  if (body.fitnessProfile !== undefined) {
    patch.fitnessProfile = validateFitnessProfile(body.fitnessProfile);
  }

  if (body.city !== undefined) {
    if (typeof body.city !== 'string' || body.city.trim() === '') {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'city must be a non-empty string');
    }
    patch.city = body.city.trim();
  }

  const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `Unknown field(s): ${unknown.join(', ')}`);
  }

  if (Object.keys(patch).length === 0) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'No profile fields supplied');
  }

  return patch;
};
