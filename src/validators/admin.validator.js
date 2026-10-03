import { ROLES } from '../constants/roles.js';
import { calculateAge, parseDateOfBirth } from '../utils/age.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';
import { ACTIVITY_LEVELS, FITNESS_GOALS, FOOD_TYPES, GENDERS } from '../utils/fitness-calculations.js';
import { normalizePhone } from '../utils/phone.js';

export const validateAdminLogin = (body = {}) => {
  if (typeof body.email !== 'string' || body.email.trim() === '') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'email is required');
  }
  if (typeof body.password !== 'string' || body.password === '') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'password is required');
  }
  // No length/format rule on the way in: rejecting a short password here would
  // only tell an attacker their guess was the wrong shape. Verification decides.
  return { email: body.email.trim(), password: body.password };
};

const STATUSES = ['active', 'inactive', 'blocked'];

export const validateUserListQuery = (query = {}) => {
  const out = {};

  if (query.page !== undefined) {
    const page = Number.parseInt(query.page, 10);
    if (Number.isNaN(page) || page < 1) {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'page must be a positive integer');
    }
    out.page = page;
  }

  if (query.pageSize !== undefined) {
    const pageSize = Number.parseInt(query.pageSize, 10);
    if (Number.isNaN(pageSize) || pageSize < 1) {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'pageSize must be a positive integer');
    }
    // Not an error when too large - the service clamps it to MAX_PAGE_SIZE.
    out.pageSize = pageSize;
  }

  if (query.role !== undefined && query.role !== '') {
    if (!ROLES.includes(query.role)) {
      throw badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        `role must be one of: ${ROLES.join(', ')}`,
      );
    }
    out.role = query.role;
  }

  if (query.status !== undefined && query.status !== '') {
    if (!STATUSES.includes(query.status)) {
      throw badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        `status must be one of: ${STATUSES.join(', ')}`,
      );
    }
    out.status = query.status;
  }

  if (query.search !== undefined) out.search = String(query.search);
  if (query.sortKey !== undefined) out.sortKey = String(query.sortKey);
  if (query.sortDir !== undefined) out.sortDir = query.sortDir === 'asc' ? 'asc' : 'desc';

  return out;
};

// --- POST /api/admin/users - an admin onboards a normal user --------------------------------

/**
 * The same onboarding the Flutter app does (name, DOB, gender, city at sign-up;
 * height, weight, activity level, food type and goal in Edit Profile), in one
 * request. Values and bounds are the app's own:
 *   - DOB: yyyy-mm-dd, age 13-100 (dob_picker_sheet.dart kMin/kMaxSignupAgeYears)
 *   - height: cm, 121.9-243.8 (the 4.0-8.0 ft wheel), weight: kg, 30-250
 *   - activityLevel / foodType / goal: the app's enum names
 * Age, body fat %, BMR and TDEE are calculated by the server and may not be sent;
 * nor may roles - this endpoint only ever creates a normal user.
 */
const CREATE_USER_FIELDS = ['phone', 'name', 'email', 'dateOfBirth', 'gender', 'city', 'fitnessProfile'];
/** The app's own rule (GoGetFit 2.0/lib/core/utils/validators.dart _emailRegex). Optional, as in Edit Profile. */
const APP_EMAIL_PATTERN = /^[\w.+-]+@[\w-]+\.[\w.-]+$/;
const MAX_EMAIL = 254;
const CREATE_FITNESS_FIELDS = ['height', 'weight', 'activityLevel', 'foodType', 'goal'];
export const ADMIN_USER_LIMITS = {
  minAge: 13,
  maxAge: 100,
  height: { min: 121.9, max: 243.8 },
  weight: { min: 30, max: 250 },
  maxCity: 100,
  maxName: 100,
};

const createFail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const measurement = (value, field, { min, max }, unit, round = true) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) createFail(`fitnessProfile.${field} is required (${unit})`);
  if (value < min || value > max) createFail(`fitnessProfile.${field} must be between ${min} and ${max} ${unit}`);
  // The app's wheels move in 0.1 steps. An edit keeps an existing value exactly as stored.
  return round ? Math.round(value * 10) / 10 : value;
};

/**
 * On EDIT, height/weight may be an existing (e.g. migrated) value the admin did
 * not touch, so the ranges are the ones the app's own profile save accepts
 * (profile.validator.js), and the value is kept as sent.
 */
const EDIT_LIMITS = { height: { min: 50, max: 300 }, weight: { min: 10, max: 500 } };

const oneOf = (value, field, allowed) => {
  if (!allowed.includes(value)) createFail(`fitnessProfile.${field} must be one of: ${allowed.join(', ')}`);
  return value;
};

/** The profile part shared by create and edit. */
const validateProfileBody = (body, now, { edit }) => {
  if (typeof body.name !== 'string' || body.name.trim().length < 2) createFail('name must be at least 2 characters');
  if (body.name.trim().length > ADMIN_USER_LIMITS.maxName) createFail(`name must be at most ${ADMIN_USER_LIMITS.maxName} characters`);

  const dob = parseDateOfBirth(body.dateOfBirth);
  if (!dob) createFail('dateOfBirth must be a valid YYYY-MM-DD date');
  const age = calculateAge(dob, now);
  if (age === null || age < ADMIN_USER_LIMITS.minAge || age > ADMIN_USER_LIMITS.maxAge) {
    createFail(`dateOfBirth must give an age between ${ADMIN_USER_LIMITS.minAge} and ${ADMIN_USER_LIMITS.maxAge}`);
  }

  // Optional and not unique - phone is the login identity. Stored unverified.
  let email = null;
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    if (typeof body.email !== 'string') createFail('email must be a string');
    email = body.email.trim();
    if (email !== '' && (email.length > MAX_EMAIL || !APP_EMAIL_PATTERN.test(email))) createFail('email must be a valid email address');
    if (email === '') email = null;
  }

  if (!GENDERS.includes(body.gender)) createFail("gender must be 'male' or 'female'");

  if (typeof body.city !== 'string' || body.city.trim() === '') createFail('city is required');
  if (body.city.trim().length > ADMIN_USER_LIMITS.maxCity) createFail(`city must be at most ${ADMIN_USER_LIMITS.maxCity} characters`);

  const fp = body.fitnessProfile;
  if (fp === null || typeof fp !== 'object' || Array.isArray(fp)) createFail('fitnessProfile is required');
  const unknownFp = Object.keys(fp).filter((k) => !CREATE_FITNESS_FIELDS.includes(k));
  if (unknownFp.length) {
    createFail(`fitnessProfile field(s) not accepted: ${unknownFp.join(', ')}. Body fat, BMR and TDEE are calculated by the server.`);
  }

  const limits = edit ? EDIT_LIMITS : ADMIN_USER_LIMITS;
  return {
    name: body.name.trim(),
    email,
    dateOfBirth: dob,
    gender: body.gender,
    city: body.city.trim(),
    fitnessProfile: {
      height: measurement(fp.height, 'height', limits.height, 'cm', !edit),
      weight: measurement(fp.weight, 'weight', limits.weight, 'kg', !edit),
      activityLevel: oneOf(fp.activityLevel, 'activityLevel', ACTIVITY_LEVELS.map((a) => a.value)),
      foodType: oneOf(fp.foodType, 'foodType', FOOD_TYPES),
      goal: oneOf(fp.goal, 'goal', FITNESS_GOALS),
    },
  };
};

const assertBody = (body, allowed) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) createFail('Request body must be an object');
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    createFail(`Field(s) not accepted: ${unknown.join(', ')}. Roles, age, body fat, BMR and TDEE are set by the server.`);
  }
};

export const validateCreateUser = (body = {}, now = new Date()) => {
  assertBody(body, CREATE_USER_FIELDS);
  // Phone: the login identity. normalizePhone throws PhoneNormalizationError -> 400 INVALID_PHONE.
  if (typeof body.phone !== 'string' || body.phone.trim() === '') createFail('phone is required');
  const normalized = normalizePhone(body.phone);
  return { phone: { raw: body.phone.trim(), normalized }, ...validateProfileBody(body, now, { edit: false }) };
};

/**
 * PATCH /api/admin/users/:id - the same form as create, minus the phone: the
 * login identity is not changed from here.
 */
const UPDATE_USER_FIELDS = CREATE_USER_FIELDS.filter((f) => f !== 'phone');
export const validateUpdateUser = (body = {}, now = new Date()) => {
  assertBody(body, UPDATE_USER_FIELDS);
  return validateProfileBody(body, now, { edit: true });
};
