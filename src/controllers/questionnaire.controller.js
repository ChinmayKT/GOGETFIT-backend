import {
  getMemberQuestionnaire,
  listMemberQuestionnaires,
  listQuestionnairesForAdmin,
  saveMemberQuestionnaire,
} from '../services/questionnaire.service.js';
import { validateStatus } from '../validators/questionnaire.validator.js';

/**
 * The member's own questionnaire, for one of their own enrollments.
 *
 * The owner is `req.user._id`, which `requireAuth` took from the verified token.
 * Neither handler reads a userId or a coachId from the body, the query or the
 * path - the only client-supplied value is the enrollment id, and the service
 * resolves that against the caller's own enrollments.
 */

/** POST /api/users/me/enrollments/:enrollmentId/questionnaire */
export const postMyQuestionnaire = async (req, res, next) => {
  try {
    const { questionnaire, created } = await saveMemberQuestionnaire(
      req.user._id,
      req.params.enrollmentId,
      req.body,
    );

    res.status(created ? 201 : 200).json({
      success: true,
      message: created ? 'Questionnaire saved' : 'Questionnaire updated',
      data: { questionnaire },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/users/me/enrollments/:enrollmentId/questionnaire */
export const getMyQuestionnaire = async (req, res, next) => {
  try {
    const questionnaire = await getMemberQuestionnaire(req.user._id, req.params.enrollmentId);
    res.status(200).json({ success: true, data: { questionnaire } });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/users/me/questionnaires?status=submitted
 *
 * The member's own questionnaire history, newest submission first. The owner is
 * the token's subject; `status` is the only input, and it is validated against
 * the stored statuses rather than passed into the query as given.
 */
export const getMyQuestionnaires = async (req, res, next) => {
  try {
    const { status } = req.query;
    const result = await listMemberQuestionnaires(req.user._id, {
      // Omitted means "all of mine"; anything else must be a real status.
      status: status === undefined ? undefined : validateStatus(status),
    });

    res.status(200).json({
      success: true,
      data: { questionnaires: result.questionnaires, total: result.total },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/users/:id/questionnaires - a member's submitted questionnaires (admin). */
export const getUserQuestionnairesForAdmin = async (req, res, next) => {
  try {
    const result = await listQuestionnairesForAdmin(req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
