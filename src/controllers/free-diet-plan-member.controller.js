import { getPlanForMember } from '../services/free-diet-plan.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';

/**
 * GET /api/free-diet-plans/:id - one template, for the member it belongs to.
 *
 * Authenticated but not admin: this is the route the app uses after reading
 * `profile.freeDietPlanId` from /users/me. It serves a member-safe projection,
 * so the administrative fields (status, legacy metadata, migration stamp, the
 * audit trail) stay on the admin route.
 *
 * Only active templates are served: an archived plan is not something a member
 * should still be shown.
 */
export const getFreeDietPlanForMember = async (req, res, next) => {
  try {
    const plan = await getPlanForMember(req.params.id);
    if (!plan) throw notFound(ERROR_CODES.PLAN_NOT_FOUND, 'Free diet plan not found');

    res.status(200).json({ success: true, data: { plan } });
  } catch (error) {
    next(error);
  }
};
