import { Router } from 'express';

import { ROLE_ADMIN } from '../constants/roles.js';
import {
  getAdminMe,
  getAdminUserById,
  getAdminUsers,
} from '../controllers/admin.controller.js';
import {
  deleteCoachImage,
  getCoach,
  getCoaches,
  patchCoach,
  postCoach,
  putCoachImage,
  searchUserByPhone,
} from '../controllers/coach.controller.js';
import {
  deleteFreeDietPlan,
  getFreeDietPlan,
  getFreeDietPlans,
  patchFreeDietPlan,
  postFreeDietPlan,
} from '../controllers/free-diet-plan.controller.js';
import {
  deleteGogetfitPlan,
  deleteGogetfitPlanImage,
  getGogetfitPlan,
  getGogetfitPlans,
  patchGogetfitPlan,
  postGogetfitPlan,
  putGogetfitPlanImage,
} from '../controllers/gogetfit-plan.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { rawImageBody } from '../middleware/upload.middleware.js';

const router = Router();

/**
 * Every route below is gated twice, on the server, on every request:
 *   requireAuth          - valid token, user still exists, status === 'active'
 *   requireRole('admin') - stored roles array contains "admin"
 *
 * Applied with router.use so a route added later cannot accidentally be left
 * unprotected by forgetting to list the middleware.
 */
router.use(requireAuth, requireRole(ROLE_ADMIN));

router.get('/me', getAdminMe);
router.get('/users', getAdminUsers);
// Registered before /users/:id so "search" is never read as an id.
router.get('/users/search', searchUserByPhone);
router.get('/users/:id', getAdminUserById);

// Coach profiles. A coach is an existing user plus a Coach document; there is
// no DELETE - deactivation is PATCH { status: "inactive" }.
router.get('/coaches', getCoaches);
router.post('/coaches', postCoach);
router.get('/coaches/:id', getCoach);
router.patch('/coaches/:id', patchCoach);
// The coach's own pictures - separate from the user's avatar and from each other.
router.put('/coaches/:id/profile-picture', rawImageBody, putCoachImage('profilePicture'));
router.delete('/coaches/:id/profile-picture', deleteCoachImage('profilePicture'));
router.put('/coaches/:id/cover-picture', rawImageBody, putCoachImage('coverPicture'));
router.delete('/coaches/:id/cover-picture', deleteCoachImage('coverPicture'));

// Free Diet Plan templates (legacy Diet/PlanList).
router.get('/free-diet-plans', getFreeDietPlans);
router.post('/free-diet-plans', postFreeDietPlan);
router.get('/free-diet-plans/:id', getFreeDietPlan);
router.patch('/free-diet-plans/:id', patchFreeDietPlan);
router.delete('/free-diet-plans/:id', deleteFreeDietPlan);

// GoGetFit Plans (legacy m_package). DELETE archives; PATCH { status } restores.
router.get('/gogetfit-plans', getGogetfitPlans);
router.post('/gogetfit-plans', postGogetfitPlan);
router.get('/gogetfit-plans/:id', getGogetfitPlan);
router.patch('/gogetfit-plans/:id', patchGogetfitPlan);
router.delete('/gogetfit-plans/:id', deleteGogetfitPlan);
// The plan's 3:1 cover image - its own lifecycle, never part of the plan PATCH.
router.put('/gogetfit-plans/:id/image', rawImageBody, putGogetfitPlanImage);
router.delete('/gogetfit-plans/:id/image', deleteGogetfitPlanImage);

export default router;
