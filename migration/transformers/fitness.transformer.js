import { roundBodyFat } from '../../src/utils/round.js';

/**
 * Maps the legacy m_user fitness columns onto profile.fitnessProfile.
 *
 * Legacy types: height int(3), weight float(6,3), fat float(6,3), bmr int(4),
 * tdee int(4) - all nullable. Values are carried across as numbers; nothing is
 * invented and no energy figure is ever calculated here.
 */

/**
 * Converts one legacy measurement.
 *
 * NULL stays null. A zero is also treated as missing: a height, weight or body
 * fat of 0 is not a real measurement, it is how the legacy system recorded
 * "never filled in". Storing it would be exactly the `height: 0` stand-in for
 * missing data that the new model forbids. Every other number is preserved as
 * it is, including unusual but physically possible ones.
 */
export const transformMeasurement = (value) => {
  if (value === null || value === undefined || value === '') return null;

  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  if (number <= 0) return null;

  return number;
};

/** Builds the fitnessProfile for one legacy row. */
export const transformLegacyFitness = (row) => ({
  height: transformMeasurement(row.height),
  weight: transformMeasurement(row.weight),
  // Legacy fat is float(6,3); two decimals is the stored precision.
  bodyFatPercentage: roundBodyFat(transformMeasurement(row.fat)),
  // No confirmed legacy source for these three - never guessed, never derived
  // from unrelated columns. The member supplies them from Edit Profile.
  activityLevel: null,
  foodType: null,
  goal: null,
  // Legacy bmr/tdee are int(4) and use 0 (and, in one staging row, a negative
  // number) for "never computed", which transformMeasurement maps to null.
  // The stored figure is copied as-is; no formula runs here.
  bmr: transformMeasurement(row.bmr),
  // Same name on both sides (legacy m_user.tdee -> fitnessProfile.tdee); the
  // value is copied untouched.
  tdee: transformMeasurement(row.tdee),
});

export default transformLegacyFitness;
