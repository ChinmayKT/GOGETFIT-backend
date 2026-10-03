import { getMemberCoach, listMemberEnrollments } from '../services/member-enrollment.service.js';

/**
 * The member's own enrollments and coach.
 *
 * The owner is `req.user._id`, which `requireAuth` took from the verified
 * token. No handler here reads a userId from the query or the body, so there is
 * no parameter with which one member could ask for another's purchases.
 */

/** GET /api/users/me/enrollments - every plan the member has bought, newest first. */
export const getMyEnrollments = async (req, res, next) => {
  try {
    const result = await listMemberEnrollments(req.user._id);
    res.status(200).json({
      success: true,
      data: {
        enrollments: result.enrollments,
        total: result.total,
        current: result.current,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/users/me/coach - the coach on the member's active enrollment.
 *
 * 200 with `coach: null` when there is no active plan: having no coach is a
 * normal state, not a missing resource.
 */
export const getMyCoach = async (req, res, next) => {
  try {
    const result = await getMemberCoach(req.user._id);
    res.status(200).json({
      success: true,
      data: { coach: result?.coach ?? null, enrollment: result?.enrollment ?? null },
    });
  } catch (error) {
    next(error);
  }
};
