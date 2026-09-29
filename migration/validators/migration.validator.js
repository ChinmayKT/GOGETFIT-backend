import { CONFLICT_TYPES } from '../../src/models/migration-conflict.model.js';

/** Legacy authentication fields must never reach a Mongo user document. */
const FORBIDDEN_KEYS = [
  'password',
  'login_token',
  'loginToken',
  'otp',
  'otp_expiry',
  'otpExpiry',
  'registration_otp',
  'registrationOtp',
  'token',
];

const collectKeys = (value, keys = new Set()) => {
  if (value === null || typeof value !== 'object' || value instanceof Date) return keys;

  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    collectKeys(nested, keys);
  }
  return keys;
};

/**
 * Validates one transformed user before it is written. Anything that fails here
 * is reported, never silently corrected.
 */
export const validateTransformedUser = (transformed, options = {}) => {
  const errors = [];
  const source = options.source;
  const document = transformed.document;

  if (!Number.isInteger(transformed.legacyUserId) || transformed.legacyUserId <= 0) {
    errors.push('legacyUserId must be a positive integer');
  }

  if (!document.phone || !document.phone.normalized) {
    errors.push('phone.normalized is required');
  } else if (!/^\d{10,15}$/.test(document.phone.normalized)) {
    errors.push(`phone.normalized has an invalid format: ${document.phone.normalized}`);
  }

  if (!document.legacy || document.legacy.userId !== transformed.legacyUserId) {
    errors.push('legacy.userId must match the extracted legacy row');
  }

  if (source && document.legacy?.source !== source) {
    errors.push(`legacy.source must be "${source}"`);
  }

  if (document.profile?.gender !== null && !['male', 'female'].includes(document.profile?.gender)) {
    errors.push(`profile.gender must be male, female or null`);
  }

  if (document.profile?.dateOfBirth && Number.isNaN(document.profile.dateOfBirth.getTime())) {
    errors.push('profile.dateOfBirth is not a valid date');
  }

  const keys = collectKeys(document);
  const leaked = FORBIDDEN_KEYS.filter((key) => keys.has(key));
  if (leaked.length > 0) {
    errors.push(`legacy authentication field(s) present: ${leaked.join(', ')}`);
  }

  return { valid: errors.length === 0, errors, legacyUserId: transformed.legacyUserId };
};

/** Validates a whole batch and guarantees the batch itself has unique phones. */
export const validateBatch = (transformedUsers, options = {}) => {
  const results = transformedUsers.map((user) => validateTransformedUser(user, options));
  const invalid = results.filter((result) => !result.valid);

  const seen = new Map();
  const duplicateWithinBatch = [];

  for (const user of transformedUsers) {
    const phone = user.document.phone?.normalized;
    if (!phone) continue;
    if (seen.has(phone)) {
      duplicateWithinBatch.push({
        type: CONFLICT_TYPES.DUPLICATE_LEGACY_PHONE,
        phone,
        legacyUserIds: [seen.get(phone), user.legacyUserId],
      });
    } else {
      seen.set(phone, user.legacyUserId);
    }
  }

  return {
    valid: invalid.length === 0 && duplicateWithinBatch.length === 0,
    invalid,
    duplicateWithinBatch,
  };
};

export default validateBatch;
