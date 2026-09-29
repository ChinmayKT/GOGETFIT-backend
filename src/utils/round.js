/**
 * Rounds a measurement to [decimals] places for storage.
 *
 * Note this is a numeric rounding, not a formatting: 15.9 rounded to two
 * places is the number 15.9, because 15.90 and 15.9 are the same value. A
 * trailing zero is a display concern (`toFixed(2)`), not a stored one.
 *
 * Returns null unchanged, so "not filled in" never becomes 0.
 */
export const roundTo = (value, decimals = 2) => {
  if (value === null || value === undefined) return null;

  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return null;

  const factor = 10 ** decimals;
  // Rounds half away from zero, and Number() drops any float artefact.
  return Number((Math.round(number * factor) / factor).toFixed(decimals));
};

/** Body fat is stored to two decimal places. */
export const roundBodyFat = (value) => roundTo(value, 2);
