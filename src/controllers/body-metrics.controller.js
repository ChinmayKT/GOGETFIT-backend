import {
  getMemberBodyMetrics,
  getSubmittedBodyMetricsForCoach,
  listBodyMetricsForAdmin,
  listMemberBodyMetrics,
  removeMemberBodyMetricsMedia,
  saveMemberBodyMetrics,
  setMemberBodyMetricsMedia,
} from '../services/body-metrics.service.js';
import { validateBodyMetricsStatus } from '../validators/body-metrics.validator.js';

/**
 * Body Metrics, one per enrollment. The member is always `req.user._id` and the
 * coach always the token's coach; the only client-chosen value is the
 * enrollment id, resolved against the caller's own enrollments.
 */

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

/** GET /api/users/me/enrollments/:enrollmentId/body-metrics */
export const getMyBodyMetrics = handle(async (req, res) => {
  const bodyMetrics = await getMemberBodyMetrics(req.user._id, req.params.enrollmentId);
  res.status(200).json({ success: true, data: { bodyMetrics } });
});

/** POST /api/users/me/enrollments/:enrollmentId/body-metrics - save the draft, or submit. */
export const postMyBodyMetrics = handle(async (req, res) => {
  const { bodyMetrics, created } = await saveMemberBodyMetrics(req.user._id, req.params.enrollmentId, req.body);
  res.status(created ? 201 : 200).json({
    success: true,
    message: bodyMetrics.status === 'submitted' ? 'Body Metrics submitted' : 'Body Metrics saved',
    data: { bodyMetrics },
  });
});

/** PUT /api/users/me/enrollments/:enrollmentId/body-metrics/media/:slot - raw image or MP4 bytes. */
export const putMyBodyMetricsMedia = handle(async (req, res) => {
  const result = await setMemberBodyMetricsMedia(req.user._id, req.params.enrollmentId, req.params.slot, req.body);
  res.status(200).json({ success: true, data: result });
});

/** DELETE /api/users/me/enrollments/:enrollmentId/body-metrics/media/:slot */
export const deleteMyBodyMetricsMedia = handle(async (req, res) => {
  const result = await removeMemberBodyMetricsMedia(req.user._id, req.params.enrollmentId, req.params.slot);
  res.status(200).json({ success: true, data: result });
});

/** GET /api/users/me/body-metrics?status=submitted - the member's own history. */
export const getMyBodyMetricsList = handle(async (req, res) => {
  const { status } = req.query;
  const result = await listMemberBodyMetrics(req.user._id, {
    status: status === undefined ? undefined : validateBodyMetricsStatus(status),
  });
  res.status(200).json({ success: true, data: result });
});

/** GET /api/coach/enrollments/:enrollmentId/body-metrics - submitted only, null otherwise. */
export const getEnrollmentBodyMetricsForCoach = handle(async (req, res) => {
  const bodyMetrics = await getSubmittedBodyMetricsForCoach(req.user._id, req.params.enrollmentId);
  res.status(200).json({ success: true, data: { bodyMetrics } });
});

/** GET /api/admin/users/:id/body-metrics - a member's submitted Body Metrics (admin). */
export const getUserBodyMetricsForAdmin = handle(async (req, res) => {
  const result = await listBodyMetricsForAdmin(req.params.id);
  res.status(200).json({ success: true, data: result });
});
