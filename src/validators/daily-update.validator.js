import { ERROR_CODES, badRequest } from '../utils/errors.js';

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The most any one Calorie Out part can be, in kcal - far past any real day. */
const MAX_PART_KCAL = 20000;
export const CALORIE_OUT_PARTS = ['bmr', 'tef', 'eat', 'neat'];

const ranged = (body, key, min, max, { whole = false } = {}) => {
  const v = body[key];
  if (!finite(v)) fail(`${key} must be a number`);
  if (whole && !Number.isInteger(v)) fail(`${key} must be a whole number`);
  if (v < min || v > max) fail(`${key} must be ${min}-${max}`);
  return v;
};

/**
 * PUT /api/users/me/daily-updates/:date body - what the member entered and
 * the Calorie Out the app worked out from it:
 *
 *   { weightKg, workoutMinutes, steps,
 *     calorieOut: { bmr, tef, eat, neat },   // each kcal, or null if unavailable
 *     submissionId? }                         // one per Submit; a retry repeats it
 *
 * The ranges are the app's own. Only these are accepted: Calorie In comes from
 * the day's food log, the Calorie Out total and the energy balance are summed
 * by the server, and the member, coach, plan and day are never the body's -
 * any such field is ignored.
 */
export const validateDailyUpdateSubmission = (body = {}) => {
  if (!isPlainObject(body)) fail('Body must be an object');
  const weightKg = ranged(body, 'weightKg', 30, 250);
  const workoutMinutes = ranged(body, 'workoutMinutes', 0, 1440, { whole: true });
  const steps = ranged(body, 'steps', 0, 200000, { whole: true });

  const out = body.calorieOut;
  if (!isPlainObject(out)) fail('calorieOut must be an object');
  const calorieOut = {};
  for (const part of CALORIE_OUT_PARTS) {
    const v = out[part];
    if (v === null || v === undefined) {
      calorieOut[part] = null;
      continue;
    }
    if (!finite(v) || v < 0 || v > MAX_PART_KCAL) fail(`calorieOut.${part} must be 0-${MAX_PART_KCAL} kcal or null`);
    // Whole kcal, as the app shows them.
    calorieOut[part] = Math.round(v);
  }
  // The app's id for this submission (one per tap of Submit): a retry sends
  // the same id and is not counted as another of the day's submissions.
  let submissionId = null;
  if (body.submissionId !== undefined && body.submissionId !== null) {
    if (typeof body.submissionId !== 'string' || body.submissionId.trim() === '' || body.submissionId.length > 100) {
      fail('submissionId must be a short string');
    }
    submissionId = body.submissionId;
  }
  return { weightKg, workoutMinutes, steps, calorieOut, submissionId };
};

export default { validateDailyUpdateSubmission };
