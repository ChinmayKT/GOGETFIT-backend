import {
  getFoodLogForDay,
  getFoodLogForDayForCoach,
  getFoodLogHistory,
  getFoodLogHistoryForCoach,
  submitFoodLog,
  uploadFoodLogMealImage,
} from '../services/food-log.service.js';
import { validateFoodLogSubmission } from '../validators/food-log.validator.js';

/**
 * The signed-in member's Intake food log. The member is always the token's;
 * there is no user, client, coach or plan id to pass.
 */

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

/** GET /api/users/me/food-log?date=YYYY-MM-DD - that day's log (default today), or null. */
export const getMyFoodLog = handle(async (req, res) => {
  const date = typeof req.query.date === 'string' && req.query.date !== '' ? req.query.date : undefined;
  res.status(200).json({ success: true, data: await getFoodLogForDay(req.user._id, { date }) });
});

/**
 * GET /api/users/me/food-log/history?from=&to=&limit=&cursor= - the days the
 * member submitted a log, newest first, totals only; nextCursor pages on.
 */
export const getMyFoodLogHistory = handle(async (req, res) => {
  const q = (k) => (typeof req.query[k] === 'string' && req.query[k] !== '' ? req.query[k] : undefined);
  res.status(200).json({
    success: true,
    data: await getFoodLogHistory(req.user._id, { from: q('from'), to: q('to'), limit: q('limit'), cursor: q('cursor') }),
  });
});

const query = (req, k) => (typeof req.query[k] === 'string' && req.query[k] !== '' ? req.query[k] : undefined);

/**
 * GET /api/coach/enrollments/:enrollmentId/food-log/history?from=&to=&limit=&cursor=
 * - the submitted days of the client of one of the coach's own enrollments.
 */
export const getCoachClientFoodLogHistory = handle(async (req, res) => {
  res.status(200).json({
    success: true,
    data: await getFoodLogHistoryForCoach(req.user._id, req.params.enrollmentId, {
      from: query(req, 'from'),
      to: query(req, 'to'),
      limit: query(req, 'limit'),
      cursor: query(req, 'cursor'),
    }),
  });
});

/** GET /api/coach/enrollments/:enrollmentId/food-log?date=YYYY-MM-DD - that client's day (required). */
export const getCoachClientFoodLog = handle(async (req, res) => {
  res.status(200).json({
    success: true,
    data: await getFoodLogForDayForCoach(req.user._id, req.params.enrollmentId, { date: query(req, 'date') }),
  });
});

/** PUT /api/users/me/food-log - submit today's whole meal state; returns the saved log. */
export const putMyFoodLog = handle(async (req, res) => {
  const input = validateFoodLogSubmission(req.body);
  res.status(200).json({ success: true, data: await submitFoodLog(req.user._id, input) });
});

/**
 * PUT /api/users/me/food-log/meals/:meal/image - one photo of a meal, as raw
 * image bytes; returns its reference for the next submission.
 */
export const putMyFoodLogMealImage = handle(async (req, res) => {
  res.status(200).json({ success: true, data: await uploadFoodLogMealImage(req.user._id, req.params.meal, req.body) });
});
