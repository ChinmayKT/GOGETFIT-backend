import {
  getMemberWeeklyUpdate,
  getWeeklyUpdateForCoach,
  listClientWeeklyUpdatesForCoach,
  listMemberWeeklyUpdates,
  listWeeklyUpdatesForCoach,
  removeMemberWeeklyUpdateMedia,
  setMemberWeeklyUpdateMedia,
  submitMemberWeeklyUpdate,
} from '../services/weekly-update.service.js';

/**
 * Weekly Updates. The member is always `req.user._id` and the coach always the
 * token's coach; the enrollment, coach and plan are resolved server-side.
 */

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

/** GET /api/users/me/weekly-updates - submitted history (?limit, ?cursor). */
export const getMyWeeklyUpdates = handle(async (req, res) => {
  const data = await listMemberWeeklyUpdates(req.user._id, { limit: req.query.limit, cursor: req.query.cursor });
  res.status(200).json({ success: true, data });
});

/** GET /api/users/me/weekly-updates/:date - one day (today's may be a draft). */
export const getMyWeeklyUpdate = handle(async (req, res) => {
  const data = await getMemberWeeklyUpdate(req.user._id, req.params.date);
  res.status(200).json({ success: true, data });
});

/** POST /api/users/me/weekly-updates - submit today's. */
export const postMyWeeklyUpdate = handle(async (req, res) => {
  const { weeklyUpdate, created } = await submitMemberWeeklyUpdate(req.user._id, req.body);
  res.status(created ? 201 : 200).json({ success: true, message: 'Weekly Update submitted', data: { weeklyUpdate } });
});

/** PUT /api/users/me/weekly-updates/:date/media/:slot - raw image or MP4 bytes. */
export const putMyWeeklyUpdateMedia = handle(async (req, res) => {
  const data = await setMemberWeeklyUpdateMedia(req.user._id, req.params.date, req.params.slot, req.body);
  res.status(200).json({ success: true, data });
});

/** DELETE /api/users/me/weekly-updates/:date/media/:slot */
export const deleteMyWeeklyUpdateMedia = handle(async (req, res) => {
  const data = await removeMemberWeeklyUpdateMedia(req.user._id, req.params.date, req.params.slot);
  res.status(200).json({ success: true, data });
});

/** GET /api/coach/enrollments/:enrollmentId/weekly-updates */
export const getCoachClientWeeklyUpdates = handle(async (req, res) => {
  const data = await listWeeklyUpdatesForCoach(req.user._id, req.params.enrollmentId, {
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  res.status(200).json({ success: true, data });
});

/** GET /api/coach/enrollments/:enrollmentId/weekly-updates/:date */
export const getCoachClientWeeklyUpdate = handle(async (req, res) => {
  const data = await getWeeklyUpdateForCoach(req.user._id, req.params.enrollmentId, req.params.date);
  res.status(200).json({ success: true, data });
});

/** GET /api/coach/clients/:userId/weekly-updates - every cycle with this coach. */
export const getCoachClientWeeklyUpdatesAll = handle(async (req, res) => {
  const data = await listClientWeeklyUpdatesForCoach(req.user._id, req.params.userId, {
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  res.status(200).json({ success: true, data });
});
