import { Router } from 'express';

import { ROLE_COACH } from '../constants/roles.js';
import {
  getClientEnrollments,
  getClients,
  getDashboard,
  getEnrollmentDietPlanCreateData,
  getEnrollmentQuestionnaire,
} from '../controllers/coach-workspace.controller.js';
import { getEnrollmentBodyMetricsForCoach } from '../controllers/body-metrics.controller.js';
import {
  getCoachClientDietPlanForDay,
  getCoachClientDietPlans,
  postCoachClientDietPlan,
  putCoachClientDietPlanTargets,
} from '../controllers/diet-plan.controller.js';
import { getCoachClientFoodLog, getCoachClientFoodLogHistory } from '../controllers/food-log.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

/**
 * The Coach Workspace API: /api/coach/*. Only signed-in users holding the
 * "coach" role, and every handler works on the coach of the signed-in user -
 * never on a coach id sent by the client. (Member-facing coach browsing lives
 * at /api/coaches.)
 */
const router = Router();

router.use(requireAuth, requireRole(ROLE_COACH));

router.get('/dashboard', getDashboard);
// The coach's own clients, one row per member (their current/latest cycle).
router.get('/clients', getClients);
// One client's coaching cycles with this coach, current/latest first.
router.get('/clients/:userId/enrollments', getClientEnrollments);
// The submitted questionnaire of one of the coach's own enrollments.
router.get('/enrollments/:enrollmentId/questionnaire', getEnrollmentQuestionnaire);
// The submitted Body Metrics of one of the coach's own enrollments.
router.get('/enrollments/:enrollmentId/body-metrics', getEnrollmentBodyMetricsForCoach);
// The diet plans of the client in one of the coach's own enrollments (read-only).
router.get('/enrollments/:enrollmentId/diet-plans', getCoachClientDietPlans);
// A NEW diet plan for one of the coach's own enrollments (never an update).
router.post('/enrollments/:enrollmentId/diet-plans', postCoachClientDietPlan);
// Set Calorie Intake: the coach's daily targets on one of that client's plans.
router.put('/enrollments/:enrollmentId/diet-plans/:dietPlanId/coach-targets', putCoachClientDietPlanTargets);
// The plan that client sees on a day (?date=YYYY-MM-DD, default today).
router.get('/enrollments/:enrollmentId/diet-plan', getCoachClientDietPlanForDay);
// What the Create Diet Plan screen opens with: six values from the profile only (read-only).
router.get('/enrollments/:enrollmentId/diet-plan/create-data', getEnrollmentDietPlanCreateData);
// The client's submitted food logs, read-only: the dates, and one day.
router.get('/enrollments/:enrollmentId/food-log/history', getCoachClientFoodLogHistory);
router.get('/enrollments/:enrollmentId/food-log', getCoachClientFoodLog);

export default router;
