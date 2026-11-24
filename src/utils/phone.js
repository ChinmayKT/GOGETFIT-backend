import {
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/max';

import env from '../config/env.js';

export class PhoneNormalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PhoneNormalizationError';
  }
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** "IN" -> "India", "US" -> "United States"; null for an unknown code. */
export const countryNameOf = (iso) => {
  if (!iso) return null;
  try {
    const name = regionNames.of(iso);
    return name && name !== iso ? name : null;
  } catch {
    return null;
  }
};

/** A supported ISO 3166 alpha-2 code ("AU"), upper-cased; null when absent. */
export const normalizeCountryIso = (countryIso) => {
  if (countryIso === null || countryIso === undefined || String(countryIso).trim() === '') return null;
  const iso = String(countryIso).trim().toUpperCase();
  if (!isSupportedCountry(iso)) {
    throw new PhoneNormalizationError(`Unsupported country: "${countryIso}"`);
  }
  return iso;
};

/**
 * International parsing and validation (libphonenumber-js, full metadata).
 *
 *   - "+61 412 345 678" / "0061 412 345 678": the number's own country code,
 *     never re-read as Indian.
 *   - With [countryIso]: a national number is read in that country, and a
 *     "+" number must carry that country's calling code.
 *   - Without [countryIso] (old app versions): 10 digits, or 11 starting with
 *     a trunk 0, are Indian (DEFAULT_COUNTRY_ISO); anything else is read as a
 *     full number with its country code ("919876543210", "61412345678").
 *   - The number must be valid under that country's numbering rules.
 *
 * Returns { normalized, e164, countryIso, countryName, countryCode, formatted }
 * where normalized is the E.164 digits without "+" (the login identity) and
 * e164 is always "+" + normalized. Throws PhoneNormalizationError (400
 * INVALID_PHONE) otherwise.
 */
export const parsePhone = (input, countryIso) => {
  const raw = requireRaw(input);
  const iso = normalizeCountryIso(countryIso);

  let digits = raw.replace(/\D/g, '');
  let international = raw.startsWith('+');
  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }

  const nationalLength = env.phone.nationalNumberLength;
  let parsed;
  if (international) {
    parsed = parsePhoneNumberFromString(`+${digits}`);
  } else if (iso) {
    parsed = parsePhoneNumberFromString(digits, iso);
  } else if (
    digits.length === nationalLength ||
    (digits.length === nationalLength + 1 && digits.startsWith('0'))
  ) {
    parsed = parsePhoneNumberFromString(digits, env.phone.defaultCountryIso);
  } else {
    parsed = parsePhoneNumberFromString(`+${digits}`);
  }

  if (!parsed || !parsed.isValid()) {
    throw new PhoneNormalizationError(`Phone number is not valid: "${raw}"`);
  }
  if (iso && parsed.countryCallingCode !== getCountryCallingCode(iso)) {
    throw new PhoneNormalizationError(`Phone number "${raw}" does not belong to ${iso}`);
  }

  // The number's own region (a +1 416 number is Canada even if "US" was
  // picked); a non-geographic number keeps no country.
  const resolvedIso = parsed.country ?? null;
  return {
    normalized: parsed.number.slice(1),
    e164: parsed.number,
    countryIso: resolvedIso,
    countryName: countryNameOf(resolvedIso),
    countryCode: parsed.countryCallingCode,
    formatted: parsed.formatInternational(),
  };
};

const requireRaw = (input) => {
  if (input === null || input === undefined) {
    throw new PhoneNormalizationError('Phone number is required');
  }
  const raw = String(input).trim();
  if (raw === '') {
    throw new PhoneNormalizationError('Phone number is required');
  }
  return raw;
};

/**
 * The login identity (E.164 digits, no "+") for [input].
 *
 * With options.countryIso: exactly parsePhone(input, countryIso).normalized.
 * Without: parsePhone when the number is valid, otherwise the original
 * digit rule below - so a legacy number that fails today's numbering rules
 * still resolves to the identity it was stored under (lookups, migration,
 * existing logins). For every valid number both give the same digits.
 */
export const normalizePhone = (input, options = {}) => {
  if (options.countryIso) return parsePhone(input, options.countryIso).normalized;
  try {
    return parsePhone(input).normalized;
  } catch (error) {
    if (!(error instanceof PhoneNormalizationError)) throw error;
    return legacyNormalizePhone(input, options);
  }
};

/**
 * Legacy normalization rule (kept for numbers that fail parsePhone):
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
const legacyNormalizePhone = (input, options = {}) => {
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

/** The full stored phone subdocument for a new user (strict: must parse). */
export const buildPhoneField = (input, countryIso) => ({
  raw: String(input).trim(),
  ...parsePhone(input, countryIso),
});
