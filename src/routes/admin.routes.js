import { Router } from 'express';

import { ROLE_ADMIN } from '../constants/roles.js';
import {
  getAdminMe,
  getAdminUserById,
  getAdminUsers,
  patchAdminUser,
  postAdminUser,
} from '../controllers/admin.controller.js';
import {
  deleteCoachImage,
  getCoach,
  getCoachClientsForAdmin,
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
import { getCoupon, getCoupons, patchCoupon, postCoupon } from '../controllers/coupon.controller.js';
import {
  deleteFood,
  deleteFoodImage,
  getFood,
  getFoods,
  postFood,
  putFood,
  putFoodImage,
} from '../controllers/food.controller.js';
import {
  getEnrolledClient,
  getEnrolledClients,
  postEnrolledClient,
} from '../controllers/enrolled-client.controller.js';
import {
  deleteWorkout,
  deleteWorkoutMedia,
  getWorkout,
  getWorkouts,
  postWorkout,
  postWorkoutRestore,
  putWorkout,
  putWorkoutMedia,
} from '../controllers/workout.controller.js';
import { getAdminCartItems } from '../controllers/admin-cart.controller.js';
import { getUserQuestionnairesForAdmin } from '../controllers/questionnaire.controller.js';
import { getUserBodyMetricsForAdmin } from '../controllers/body-metrics.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { rawImageBody, rawVideoBody } from '../middleware/upload.middleware.js';

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
// Onboard a normal user (role "user" only) - the admin entry point into the app's onboarding.
router.post('/users', postAdminUser);
// Registered before /users/:id so "search" is never read as an id.
router.get('/users/search', searchUserByPhone);
router.get('/users/:id', getAdminUserById);
router.get('/users/:id/questionnaires', getUserQuestionnairesForAdmin);
router.get('/users/:id/body-metrics', getUserBodyMetricsForAdmin);
router.patch('/users/:id', patchAdminUser);

// Coach profiles. A coach is an existing user plus a Coach document; there is
// no DELETE - deactivation is PATCH { status: "inactive" }.
router.get('/coaches', getCoaches);
router.post('/coaches', postCoach);
router.get('/coaches/:id', getCoach);
// The coach's clients: statistics + every non-deleted enrollment with them.
router.get('/coaches/:id/clients', getCoachClientsForAdmin);
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
// Enrolled clients: one document per purchase. Related User / Coach / Plan /
// Coupon documents are joined for display, never copied onto the enrollment.
// POST is the admin manual enrollment (Add Client).
// "In cart": members who added a plan and have not bought it. Purchased items
// leave this list on their own - the purchase flips the cart item's status in
// the same transaction that creates the enrollment.
router.get('/cart-items', getAdminCartItems);

router.get('/enrolled-clients', getEnrolledClients);
router.post('/enrolled-clients', postEnrolledClient);
router.get('/enrolled-clients/:id', getEnrolledClient);

router.get('/gogetfit-plans', getGogetfitPlans);
router.post('/gogetfit-plans', postGogetfitPlan);
router.get('/gogetfit-plans/:id', getGogetfitPlan);
router.patch('/gogetfit-plans/:id', patchGogetfitPlan);
router.delete('/gogetfit-plans/:id', deleteGogetfitPlan);
// The plan's 3:1 cover image - its own lifecycle, never part of the plan PATCH.
router.put('/gogetfit-plans/:id/image', rawImageBody, putGogetfitPlanImage);
router.delete('/gogetfit-plans/:id/image', deleteGogetfitPlanImage);

// Food Database (legacy m_food + r_food_energy, now one document per food).
// DELETE archives; PUT/PATCH { status: "active" } restores. A migrated food's
// legacy block is immutable - the validator refuses it in a write body.
router.get('/foods', getFoods);
router.post('/foods', postFood);
router.get('/foods/:id', getFood);
router.put('/foods/:id', putFood);
router.patch('/foods/:id', putFood);
router.delete('/foods/:id', deleteFood);
// The food picture - its own lifecycle, never part of the food write body.
router.put('/foods/:id/image', rawImageBody, putFoodImage);
router.delete('/foods/:id/image', deleteFoodImage);

// Workouts (legacy m_workout). DELETE archives and POST /restore brings it
// back: 175 of the migrated workouts are referenced by legacy workout plans, so
// a document is never removed. Video and thumbnail have their own endpoints, so
// a text-only edit never touches a file - the legacy rule, kept.
router.get('/workouts', getWorkouts);
router.post('/workouts', postWorkout);
router.get('/workouts/:id', getWorkout);
router.put('/workouts/:id', putWorkout);
router.patch('/workouts/:id', putWorkout);
router.delete('/workouts/:id', deleteWorkout);
router.post('/workouts/:id/restore', postWorkoutRestore);
router.put('/workouts/:id/video', rawVideoBody, putWorkoutMedia('video'));
router.delete('/workouts/:id/video', deleteWorkoutMedia('video'));
router.put('/workouts/:id/thumbnail', rawImageBody, putWorkoutMedia('thumbnail'));
router.delete('/workouts/:id/thumbnail', deleteWorkoutMedia('thumbnail'));

// Coupons. No delete/archive: status comes from the validity dates alone.
router.get('/coupons', getCoupons);
router.post('/coupons', postCoupon);
router.get('/coupons/:id', getCoupon);
router.patch('/coupons/:id', patchCoupon);

export default router;
