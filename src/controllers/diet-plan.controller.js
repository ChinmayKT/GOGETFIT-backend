import {
  createDietPlanForAdmin,
  createDietPlanForCoach,
  getDietPlanForDay,
  getDietPlanForDayForCoach,
  getDietPlanHistoryForCoach,
  getDietPlanHistoryForUser,
  listDietPlansForAdmin,
  setCoachTargetsForCoach,
  getDietPlanLibraryItemForCoach,
  listDietPlanLibraryForCoach,
} from '../services/diet-plan.service.js';
import { ACTOR_ADMIN, getDietPlanCreateData } from '../services/diet-plan-create-data.service.js';
import { validateCoachTargets, validateCreateDietPlan } from '../validators/diet-plan.validator.js';

/**
 * Coach-assigned diet plans. Reads, and one write - a NEW plan for an
 * enrollment (never an update) - reached two ways: a coach for their own
 * enrollment, an admin for any. Both go through the same service; the member
 * and the coach come from the enrollment, and no client, enrollment or coach
 * id from the request body is trusted.
 */

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/users/:id/diet-plans - every plan of one member, with the day schedule they see. */
export const getUserDietPlansForAdmin = handle(async (req, res) => {
  const result = await listDietPlansForAdmin(req.params.id);
  res.status(200).json({ success: true, data: result });
});

/**
 * GET /api/users/me/diet-plan?date=YYYY-MM-DD - the plan the signed-in member
 * sees on that day (default today), or null. Scoped to the token's user; there
 * is no user id parameter to tamper with.
 */
export const getMyDietPlan = handle(async (req, res) => {
  const date = typeof req.query.date === 'string' && req.query.date !== '' ? req.query.date : undefined;
  const result = await getDietPlanForDay(req.user._id, { date });
  res.status(200).json({ success: true, data: result });
});

/**
 * GET /api/users/me/diet-plans/history - the signed-in member's previous plans,
 * one per logical plan, newest first. No meals or foods: open one with
 * GET /api/users/me/diet-plan?date=<openDate>.
 */
export const getMyDietPlanHistory = handle(async (req, res) => {
  const result = await getDietPlanHistoryForUser(req.user._id);
  res.status(200).json({ success: true, data: result });
});

/**
 * GET /api/coach/enrollments/:enrollmentId/diet-plans - the diet plans of the
 * client in one of the coach's own coaching cycles: the client's History items
 * plus current and upcoming plans. No meals: open one with the day endpoint.
 */
/**
 * GET /api/coach/diet-plans?scope=you|all&page=&pageSize=&search= - the Diet
 * Plan library (the signed-in coach's own plans, or every coach's), newest
 * first, optionally narrowed to names containing `search`.
 */
export const getCoachDietPlanLibrary = handle(async (req, res) => {
  const q = (k) => (typeof req.query[k] === 'string' && req.query[k] !== '' ? req.query[k] : undefined);
  res.status(200).json({
    success: true,
    data: await listDietPlanLibraryForCoach(req.user._id, {
      scope: q('scope') ?? 'you',
      page: q('page'),
      pageSize: q('pageSize'),
      search: q('search'),
    }),
  });
});

/** GET /api/coach/diet-plans/:planId - one library plan's meals, for its preview. */
export const getCoachDietPlanLibraryItem = handle(async (req, res) => {
  res.status(200).json({ success: true, data: await getDietPlanLibraryItemForCoach(req.user._id, req.params.planId) });
});

export const getCoachClientDietPlans = handle(async (req, res) => {
  const result = await getDietPlanHistoryForCoach(req.user._id, req.params.enrollmentId);
  res.status(200).json({ success: true, data: result });
});

/**
 * GET /api/coach/enrollments/:enrollmentId/diet-plan?date=YYYY-MM-DD - the plan
 * that client sees on that day, resolved exactly as for the member.
 */
export const getCoachClientDietPlanForDay = handle(async (req, res) => {
  const date = typeof req.query.date === 'string' && req.query.date !== '' ? req.query.date : undefined;
  const result = await getDietPlanForDayForCoach(req.user._id, req.params.enrollmentId, { date });
  res.status(200).json({ success: true, data: result });
});

/**
 * POST /api/coach/enrollments/:enrollmentId/diet-plans - a NEW diet plan for
 * one of the signed-in coach's own enrollments (201). Never updates one.
 */
export const postCoachClientDietPlan = handle(async (req, res) => {
  const input = validateCreateDietPlan(req.body);
  const dietPlan = await createDietPlanForCoach(req.user._id, req.params.enrollmentId, input);
  res.status(201).json({ success: true, data: { dietPlan } });
});

/**
 * PUT /api/coach/enrollments/:enrollmentId/diet-plans/:dietPlanId/coach-targets
 * - Set Calorie Intake: the daily calories, protein, carbs and fat the client
 * is measured against on that plan. Updates the plan; never creates one.
 */
export const putCoachClientDietPlanTargets = handle(async (req, res) => {
  const input = validateCoachTargets(req.body);
  const targets = await setCoachTargetsForCoach(req.user._id, req.params.enrollmentId, req.params.dietPlanId, input);
  res.status(200).json({ success: true, data: { targets } });
});

/**
 * GET /api/admin/enrollments/:enrollmentId/diet-plan/create-data - the six
 * profile values the Admin Portal's Add Diet Plan opens with (the coach's
 * create-data, for any live enrollment). Profile only; null when unknown.
 */
export const getAdminEnrollmentDietPlanCreateData = handle(async (req, res) => {
  const data = await getDietPlanCreateData({ userId: req.user._id, role: ACTOR_ADMIN }, req.params.enrollmentId);
  res.status(200).json({ success: true, data });
});

/**
 * POST /api/admin/enrollments/:enrollmentId/diet-plans - a NEW diet plan for
 * any live enrollment (201), built exactly as a coach's: the enrollment's
 * client and coach, createdBy = the admin. Never updates one.
 */
export const postAdminEnrollmentDietPlan = handle(async (req, res) => {
  const input = validateCreateDietPlan(req.body);
  const dietPlan = await createDietPlanForAdmin(req.user._id, req.params.enrollmentId, input);
  res.status(201).json({ success: true, data: { dietPlan } });
});
