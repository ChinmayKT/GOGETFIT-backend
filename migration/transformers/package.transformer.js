/**
 * Pure transform: one legacy m_package row -> the GogetfitPlan fields.
 *
 * Faithful, not corrective: every value is carried exactly as stored (text
 * verbatim, including line breaks and stray quotes). The only normalisation is
 * that an empty string becomes null. Anything that cannot be represented is
 * returned as an error instead of being guessed.
 */

const toInt = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : Number.NaN;
};

const text = (value) => {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === '' ? null : s;
};

const date = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const transformLegacyPackage = (row, { source }) => {
  const errors = [];
  const packageId = toInt(row.package_id);
  if (packageId === null || Number.isNaN(packageId)) errors.push('package_id is not an integer');

  const name = text(row.package_name);
  if (name === null || name.trim() === '') errors.push('package_name is empty');
  const planType = text(row.package_type);
  if (planType === null) errors.push('package_type is empty');

  const numbers = {
    durationWeeks: toInt(row.duration),
    personsAllowed: toInt(row.person_allowed),
    basePrice: toInt(row.base_price),
    reward: toInt(row.reward),
  };
  for (const [key, value] of Object.entries(numbers)) {
    if (Number.isNaN(value)) errors.push(`${key} is not an integer`);
    if (key !== 'reward' && value === null) errors.push(`${key} is missing`);
  }

  return {
    errors,
    plan: {
      name: name?.trim() ?? null,
      planType,
      coachLevel: text(row.coach_level),
      durationWeeks: numbers.durationWeeks,
      personsAllowed: numbers.personsAllowed,
      pricing: { basePrice: numbers.basePrice, reward: numbers.reward },
      content: {
        description: text(row.description),
        inclusions: text(row.inclusions),
        whatNext: text(row.what_next),
        termsAndConditions: text(row.tandc),
        eligibility: text(row.eligibility),
      },
      status: 'active',
      legacy: {
        source,
        packageId,
        createdBy: text(row.created_by),
        updatedAt: date(row.last_update_date),
        updatedBy: text(row.last_update_by),
      },
    },
  };
};

export default transformLegacyPackage;
