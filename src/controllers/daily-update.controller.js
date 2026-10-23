import {
  getDailyUpdateForDay,
  getDailyUpdateForDayForCoach,
  getDailyUpdateHistory,
  getDailyUpdateHistoryForCoach,
  submitDailyUpdate,
} from '../services/daily-update.service.js';
import { getRewards } from '../services/rewards.service.js';
import { validateDailyUpdateSubmission } from '../validators/daily-update.validator.js';

/**
 * Daily Update. The member is always the token's - there is no user, client,
 * coach or plan id to pass; a coach names one of their own enrollments.
 */

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

const query = (req, k) => (typeof req.query[k] === 'string' && req.query[k] !== '' ? req.query[k] : undefined);

/** GET /api/users/me/daily-updates?limit=&cursor= - saved days, newest first, summaries only. */
export const getMyDailyUpdates = handle(async (req, res) => {
  res.status(200).json({
    success: true,
    data: await getDailyUpdateHistory(req.user._id, { limit: query(req, 'limit'), cursor: query(req, 'cursor') }),
  });
});

/** GET /api/users/me/daily-updates/:date - that day's saved Daily Update, or null. */
export const getMyDailyUpdate = handle(async (req, res) => {
  res.status(200).json({ success: true, data: await getDailyUpdateForDay(req.user._id, { date: req.params.date }) });
});

/** PUT /api/users/me/daily-updates/:date - creates or overwrites today's Daily Update. */
export const putMyDailyUpdate = handle(async (req, res) => {
  const input = validateDailyUpdateSubmission(req.body);
  res.status(200).json({ success: true, data: await submitDailyUpdate(req.user._id, req.params.date, input) });
});

/** GET /api/users/me/rewards - the member's GoGetFit Streak and Coins, as stored. */
export const getMyRewards = handle(async (req, res) => {
  res.status(200).json({ success: true, data: { rewards: await getRewards(req.user._id) } });
});

/** GET /api/coach/enrollments/:enrollmentId/daily-updates?limit=&cursor= - the client's saved days. */
export const getCoachClientDailyUpdates = handle(async (req, res) => {
  res.status(200).json({
    success: true,
    data: await getDailyUpdateHistoryForCoach(req.user._id, req.params.enrollmentId, {
      limit: query(req, 'limit'),
      cursor: query(req, 'cursor'),
    }),
  });
});

/** GET /api/coach/enrollments/:enrollmentId/daily-updates/:date - the client's day in full. */
export const getCoachClientDailyUpdate = handle(async (req, res) => {
  res.status(200).json({
    success: true,
    data: await getDailyUpdateForDayForCoach(req.user._id, req.params.enrollmentId, { date: req.params.date }),
  });
});
