import {
  getClientsForCoachUser,
  getCoachDashboard,
} from '../services/coach-dashboard.service.js';
import { getSubmittedQuestionnaireForCoach } from '../services/questionnaire.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { validateMemberCoachListQuery } from '../validators/coach.validator.js';

/** GET /api/coach/dashboard - the signed-in coach's own home numbers. */
export const getDashboard = async (req, res, next) => {
  try {
    // Identity from the token only; any coachId in the query or body is ignored.
    const dashboard = await getCoachDashboard(req.user._id);
    if (!dashboard) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'You do not have a coach profile');
    res.status(200).json({ success: true, data: dashboard });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/coach/clients - the signed-in coach's own clients.
 *
 * Every non-deleted enrollment assigned to them, newest first, with the counts
 * the Clients tab shows. The coach comes from the token; a coachId in the
 * query or body is ignored, so one coach can never read another's clients.
 */
export const getClients = async (req, res, next) => {
  try {
    // page/pageSize only; a coachId in the query is not among them and is
    // therefore ignored rather than honoured.
    const query = validateMemberCoachListQuery(req.query);
    const clients = await getClientsForCoachUser(req.user._id, query);
    if (!clients) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'You do not have a coach profile');
    res.status(200).json({ success: true, data: clients });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/coach/enrollments/:enrollmentId/questionnaire
 *
 * The submitted questionnaire of one of the signed-in coach's own enrollments.
 * `questionnaire: null` when the member has not submitted one (drafts are never
 * returned); 404 when the enrollment is not this coach's.
 */
export const getEnrollmentQuestionnaire = async (req, res, next) => {
  try {
    const questionnaire = await getSubmittedQuestionnaireForCoach(req.user._id, req.params.enrollmentId);
    res.status(200).json({ success: true, data: { questionnaire } });
  } catch (error) {
    next(error);
  }
};
