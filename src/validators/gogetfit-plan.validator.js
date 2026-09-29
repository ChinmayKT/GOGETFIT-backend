import { PLAN_LEVELS, PLAN_STATUSES, PLAN_TYPES } from '../models/gogetfit-plan.model.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * Backend-owned validation for GoGetFit Plans.
 *
 * The legacy form required level, type, name, duration, persons and base price,
 * and required a reward for a Challenge. Those rules are kept; the numeric
 * ranges and text limits are new (legacy accepted any int and any text) - see
 * docs/gogetfit-plans-legacy.md.
 */

const MAX_NAME = 45; // legacy m_package.package_name varchar(45)
const MAX_TEXT = 20000;
const MAX_WEEKS = 520;
const MAX_PERSONS = 20;
const MAX_PRICE = 10_000_000;

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const integerIn = (value, { min, max, label }) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a number`);
  if (!Number.isInteger(value)) fail(`${label} must be a whole number`);
  if (value < min || value > max) fail(`${label} must be between ${min} and ${max}`);
  return value;
};

const validateName = (value) => {
  if (typeof value !== 'string' || value.trim() === '') fail('name is required');
  const name = value.trim();
  if (name.length > MAX_NAME) fail(`name must be at most ${MAX_NAME} characters`);
  return name;
};

const validateEnum = (value, allowed, label) => {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
};

/** Text is stored verbatim (line breaks and all); only blank becomes null. */
const optionalText = (value, label) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be a string`);
  if (value.length > MAX_TEXT) fail(`${label} must be at most ${MAX_TEXT} characters`);
  return value.trim() === '' ? null : value;
};

const CONTENT_FIELDS = ['description', 'inclusions', 'whatNext', 'termsAndConditions', 'eligibility'];

const validateContent = (value) => {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail('content must be an object');
  const unknown = Object.keys(value).filter((key) => !CONTENT_FIELDS.includes(key));
  if (unknown.length > 0) fail(`Unknown content field(s): ${unknown.join(', ')}`);

  const out = {};
  for (const key of CONTENT_FIELDS) {
    const text = optionalText(value[key], `content.${key}`);
    if (text !== undefined) out[key] = text;
  }
  return out;
};

const validatePricing = (value, { partial }) => {
  if (value === undefined && partial) return undefined;
  if (!isPlainObject(value)) fail('pricing must be an object with basePrice');
  const unknown = Object.keys(value).filter((key) => !['basePrice', 'reward'].includes(key));
  if (unknown.length > 0) fail(`Unknown pricing field(s): ${unknown.join(', ')}`);

  const out = {};
  if (value.basePrice !== undefined || !partial) {
    out.basePrice = integerIn(value.basePrice, { min: 0, max: MAX_PRICE, label: 'pricing.basePrice' });
  }
  if (value.reward !== undefined) {
    out.reward = value.reward === null ? null : integerIn(value.reward, { min: 0, max: MAX_PRICE, label: 'pricing.reward' });
  }
  return out;
};

/**
 * Fields a client may never set. Rejected loudly rather than dropped silently,
 * so a portal bug surfaces instead of appearing to work.
 */
const FORBIDDEN_FIELDS = [
  'id',
  '_id',
  'legacy',
  'migration',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deletedBy',
  // The cover image has its own upload/remove endpoints; never part of a plan write.
  'image',
];

const ALLOWED_FIELDS = ['name', 'planType', 'coachLevel', 'durationWeeks', 'personsAllowed', 'pricing', 'content', 'status'];

const assertShape = (body) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  const forbidden = FORBIDDEN_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (forbidden.length > 0) fail(`Field(s) not accepted from the client: ${forbidden.join(', ')}`);
  const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.includes(key) && !FORBIDDEN_FIELDS.includes(key));
  if (unknown.length > 0) fail(`Unknown field(s): ${unknown.join(', ')}`);
};

/**
 * The legacy rule, verbatim in intent: a Challenge must say how much it refunds.
 * Checked against the plan as it will be stored, so it also holds on edit.
 */
export const assertChallengeReward = ({ planType, reward, basePrice }) => {
  if (planType === 'Challenge' && (reward === null || reward === undefined)) {
    fail('Reward (Refund Amount) is mandatory when challenge is selected');
  }
  if (reward !== null && reward !== undefined && basePrice !== undefined && reward > basePrice) {
    fail('pricing.reward cannot be more than pricing.basePrice');
  }
};

export const validateCreatePlan = (body = {}) => {
  assertShape(body);

  const plan = {
    name: validateName(body.name),
    planType: validateEnum(body.planType, PLAN_TYPES, 'planType'),
    coachLevel: validateEnum(body.coachLevel, PLAN_LEVELS, 'coachLevel'),
    durationWeeks: integerIn(body.durationWeeks, { min: 1, max: MAX_WEEKS, label: 'durationWeeks' }),
    personsAllowed: integerIn(body.personsAllowed, { min: 1, max: MAX_PERSONS, label: 'personsAllowed' }),
    pricing: validatePricing(body.pricing, { partial: false }),
    content: validateContent(body.content) ?? {},
    status: body.status === undefined ? 'active' : validateEnum(body.status, PLAN_STATUSES, 'status'),
  };
  if (plan.pricing.reward === undefined) plan.pricing.reward = null;

  assertChallengeReward({ planType: plan.planType, reward: plan.pricing.reward, basePrice: plan.pricing.basePrice });
  return plan;
};

/** PATCH: only supplied fields change; the Challenge rule is checked by the service against the merged plan. */
export const validateUpdatePlan = (body = {}) => {
  assertShape(body);

  const patch = {};
  if (body.name !== undefined) patch.name = validateName(body.name);
  if (body.planType !== undefined) patch.planType = validateEnum(body.planType, PLAN_TYPES, 'planType');
  if (body.coachLevel !== undefined) patch.coachLevel = validateEnum(body.coachLevel, PLAN_LEVELS, 'coachLevel');
  if (body.durationWeeks !== undefined) {
    patch.durationWeeks = integerIn(body.durationWeeks, { min: 1, max: MAX_WEEKS, label: 'durationWeeks' });
  }
  if (body.personsAllowed !== undefined) {
    patch.personsAllowed = integerIn(body.personsAllowed, { min: 1, max: MAX_PERSONS, label: 'personsAllowed' });
  }
  if (body.pricing !== undefined) patch.pricing = validatePricing(body.pricing, { partial: true });
  if (body.content !== undefined) patch.content = validateContent(body.content);
  if (body.status !== undefined) patch.status = validateEnum(body.status, PLAN_STATUSES, 'status');

  if (Object.keys(patch).length === 0) fail('No editable fields supplied');
  return patch;
};

const SORT_KEYS = ['name', 'basePrice', 'durationWeeks', 'personsAllowed', 'createdAt', 'updatedAt', 'legacyPackageId'];

export const validatePlanListQuery = (query = {}) => {
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
  if (query.planType !== undefined && query.planType !== '') out.planType = validateEnum(query.planType, PLAN_TYPES, 'planType');
  if (query.coachLevel !== undefined && query.coachLevel !== '') out.coachLevel = validateEnum(query.coachLevel, PLAN_LEVELS, 'coachLevel');
  if (query.status !== undefined && query.status !== '') out.status = validateEnum(query.status, PLAN_STATUSES, 'status');

  if (query.sortKey !== undefined && query.sortKey !== '') {
    if (!SORT_KEYS.includes(query.sortKey)) fail(`sortKey must be one of: ${SORT_KEYS.join(', ')}`);
    out.sortKey = query.sortKey;
  }
  if (query.sortDir !== undefined) out.sortDir = query.sortDir === 'desc' ? 'desc' : 'asc';

  return out;
};
