import { migrationEnv } from '../config/migration.env.js';
import { transformLegacyPhone } from './phone.transformer.js';
import { calculateAge, parseDateOfBirth } from '../../src/utils/age.js';

/**
 * Explicit business rule for the new single-name field, selected by
 * MIGRATION_NAME_STRATEGY. There is no implicit fallback: if the configured
 * source is empty the name stays null and onboarding collects it.
 *   first_name (default) - profile.name = m_user.first_name
 *   concat               - profile.name = trim(first_name + ' ' + last_name)
 *   ignore               - profile.name = null
 */
export const resolveProfileName = (row, strategy = migrationEnv.nameStrategy) => {
  const first = row.first_name === null || row.first_name === undefined ? '' : String(row.first_name).trim();
  const last = row.last_name === null || row.last_name === undefined ? '' : String(row.last_name).trim();

  if (strategy === 'ignore') return null;
  if (strategy === 'concat') {
    const combined = `${first} ${last}`.trim();
    return combined === '' ? null : combined;
  }

  return first === '' ? null : first;
};

/** Legacy gender values are only accepted when they map cleanly; anything else
 *  becomes null and is collected during onboarding. */
export const resolveGender = (value) => {
  if (value === null || value === undefined) return null;

  const normalized = String(value).trim().toLowerCase();
  if (['male', 'm', '1'].includes(normalized)) return 'male';
  if (['female', 'f', '2'].includes(normalized)) return 'female';
  return null;
};

/** A legacy DOB is used when it parses; it is never invented when missing. */
export const resolveDateOfBirth = (value) => {
  if (value === null || value === undefined || value === '') return null;

  const text = String(value).trim();
  if (text.startsWith('0000-00-00')) return null;

  return parseDateOfBirth(text.slice(0, 10));
};

export const resolveCity = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
};

const profileIsComplete = (profile) =>
  Boolean(
    profile.name &&
      profile.dateOfBirth instanceof Date &&
      (profile.gender === 'male' || profile.gender === 'female') &&
      profile.city,
  );

/**
 * Maps one legacy row onto the new user shape. Legacy authentication fields are
 * never read, so they cannot appear here. The legacy age column is ignored -
 * age is always recomputed from DOB.
 */
export const transformLegacyUser = (row, options = {}) => {
  const now = options.now || new Date();
  const source = options.source || migrationEnv.source;
  const strategy = options.nameStrategy || migrationEnv.nameStrategy;

  const legacyUserId = Number(row.user_id);
  const phone = transformLegacyPhone(row.phone_number);

  const dateOfBirth = resolveDateOfBirth(row.dob);
  const profile = {
    name: resolveProfileName(row, strategy),
    dateOfBirth,
    age: calculateAge(dateOfBirth, now),
    gender: resolveGender(row.gender),
    city: resolveCity(row.city_name),
  };

  return {
    legacyUserId,
    phone,
    document: {
      phone: phone.ok ? { raw: phone.raw, normalized: phone.normalized } : null,
      legacy: { source, userId: legacyUserId },
      profile,
      profileCompleted: profileIsComplete(profile),
      roles: ['user'],
      status: 'active',
    },
  };
};

export default transformLegacyUser;
