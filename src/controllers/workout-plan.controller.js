import {
  createWorkoutPlanForCoach,
  getWorkoutPlanForDay,
  getWorkoutPlanLibraryItemForCoach,
  listMyWorkoutPlans,
  listWorkoutPlanLibraryForCoach,
  listWorkoutPlansForAdmin,
  listWorkoutPlansForCoach,
  validateCreateWorkoutPlan,
} from '../services/workout-plan.service.js';

/** GET /api/users/me/workout-plan?date=YYYY-MM-DD - the signed-in member's plan that day (default today), or null. */
export const getMyWorkoutPlan = async (req, res, next) => {
  try {
    const date = typeof req.query.date === 'string' && req.query.date !== '' ? req.query.date : undefined;
    res.status(200).json({ success: true, data: await getWorkoutPlanForDay(req.user._id, { date }) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/users/me/workout-plans - every workout plan of the signed-in member, latest assigned day first. Scoped to the token's user. */
export const getMyWorkoutPlans = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await listMyWorkoutPlans(req.user._id) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/users/:id/workout-plans - every workout plan of one member, in the member's precedence order. Admin only (admin.routes). */
export const getUserWorkoutPlansForAdmin = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await listWorkoutPlansForAdmin(req.params.id) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/coach/enrollments/:enrollmentId/workout-plans - the workout plans of the client in one of the signed-in coach's own enrollments. */
export const getCoachClientWorkoutPlans = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await listWorkoutPlansForCoach(req.user._id, req.params.enrollmentId) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/coach/workout-plans?scope=you|all&page=&pageSize=&search= - the workout-plan library, one tab a page at a time. */
export const getCoachWorkoutPlanLibrary = async (req, res, next) => {
  try {
    const q = (k) => (typeof req.query[k] === 'string' && req.query[k] !== '' ? req.query[k] : undefined);
    res.status(200).json({
      success: true,
      data: await listWorkoutPlanLibraryForCoach(req.user._id, {
        scope: q('scope') ?? 'you',
        page: q('page'),
        pageSize: q('pageSize'),
        search: q('search'),
      }),
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/coach/workout-plans/:planId - one library plan in full (blocks and exercises), for its preview. */
export const getCoachWorkoutPlanLibraryItem = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await getWorkoutPlanLibraryItemForCoach(req.user._id, req.params.planId) });
  } catch (error) {
    next(error);
  }
};

/** POST /api/coach/enrollments/:enrollmentId/workout-plans - a NEW workout plan for the client of one of the coach's own enrollments. */
export const postCoachClientWorkoutPlan = async (req, res, next) => {
  try {
    const input = validateCreateWorkoutPlan(req.body);
    const workoutPlan = await createWorkoutPlanForCoach(req.user._id, req.params.enrollmentId, input);
    res.status(201).json({ success: true, data: { workoutPlan } });
  } catch (error) {
    next(error);
  }
};
