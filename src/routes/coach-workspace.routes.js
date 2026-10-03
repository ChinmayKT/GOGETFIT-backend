import { Router } from 'express';

import { ROLE_COACH } from '../constants/roles.js';
import { getClients, getDashboard, getEnrollmentQuestionnaire } from '../controllers/coach-workspace.controller.js';
import { getEnrollmentBodyMetricsForCoach } from '../controllers/body-metrics.controller.js';
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
// The coach's own clients, one row per coaching cycle.
router.get('/clients', getClients);
// The submitted questionnaire of one of the coach's own enrollments.
router.get('/enrollments/:enrollmentId/questionnaire', getEnrollmentQuestionnaire);
// The submitted Body Metrics of one of the coach's own enrollments.
router.get('/enrollments/:enrollmentId/body-metrics', getEnrollmentBodyMetricsForCoach);

export default router;
