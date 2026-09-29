import env from '../config/env.js';

export class PhoneNormalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PhoneNormalizationError';
  }
}

/**
 * Normalization rule (single source of truth for runtime auth AND migration):
 *   1. Trim, then strip every character that is not a digit (a leading "+" is
 *      dropped along with spaces, dashes, brackets and dots).
 *   2. Drop an international "00" prefix.
 *   3. A bare national number (default 10 digits) gets the default country code.
 *   4. A national number with a trunk "0" prefix (11 digits starting with 0)
 *      loses the 0 and gets the default country code.
 *   5. The result must be 10-15 digits (E.164 maximum) and must not start with 0.
 *
 * Returns digits only, without a "+", e.g. "919999999999".
 */
export const normalizePhone = (input, options = {}) => {
  const countryCode = options.defaultCountryCode || env.phone.defaultCountryCode;
  const nationalLength = options.nationalNumberLength || env.phone.nationalNumberLength;

  if (input === null || input === undefined) {
    throw new PhoneNormalizationError('Phone number is required');
  }

  const raw = String(input).trim();
  if (raw === '') {
    throw new PhoneNormalizationError('Phone number is required');
  }

  let digits = raw.replace(/\D/g, '');

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.length === nationalLength) {
    digits = `${countryCode}${digits}`;
  } else if (digits.length === nationalLength + 1 && digits.startsWith('0')) {
    digits = `${countryCode}${digits.slice(1)}`;
  }

  if (digits.length < 10 || digits.length > 15) {
    throw new PhoneNormalizationError(`Phone number has an unsupported length: "${raw}"`);
  }

  if (digits.startsWith('0')) {
    throw new PhoneNormalizationError(`Phone number could not be normalized: "${raw}"`);
  }

  return digits;
};

/** Non-throwing variant used by the migration pipeline, which must classify
 *  unusable rows instead of crashing the run. */
export const tryNormalizePhone = (input, options = {}) => {
  try {
    return { ok: true, normalized: normalizePhone(input, options), reason: null };
  } catch (error) {
    return { ok: false, normalized: null, reason: error.message };
  }
};

export const buildPhoneField = (input, options = {}) => ({
  raw: String(input).trim(),
  normalized: normalizePhone(input, options),
});
