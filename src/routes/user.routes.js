import { Router } from 'express';

import {
  deleteProfilePicture,
  getMe,
  patchProfile,
  putProfilePicture,
} from '../controllers/user.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { rawImageBody, rawVideoBody } from '../middleware/upload.middleware.js';
import {
  deleteMyBodyMetricsMedia,
  getMyBodyMetrics,
  getMyBodyMetricsList,
  postMyBodyMetrics,
  putMyBodyMetricsMedia,
} from '../controllers/body-metrics.controller.js';
import {
  deleteCartItem,
  getCart,
  getMemberCoupons,
  postCartItem,
  postCartPurchase,
  postCartQuote,
} from '../controllers/cart.controller.js';
import { getMyCoach, getMyEnrollments } from '../controllers/member-enrollment.controller.js';
import {
  getMyQuestionnaire,
  getMyQuestionnaires,
  postMyQuestionnaire,
} from '../controllers/questionnaire.controller.js';

const router = Router();

router.get('/me', requireAuth, getMe);
router.patch('/me/profile', requireAuth, patchProfile);

// The avatar is always editable by its owner, independent of the email lock.
router.put('/me/profile-picture', requireAuth, rawImageBody, putProfilePicture);
router.delete('/me/profile-picture', requireAuth, deleteProfilePicture);

/**
 * The member's cart. The owner is always the authenticated user: there is no
 * route that takes a userId, so one member can never read or change another's
 * cart. Purchase creates the enrollment and empties the item from the cart in
 * one transaction.
 */
router.get('/me/cart', requireAuth, getCart);
router.post('/me/cart', requireAuth, postCartItem);
router.delete('/me/cart/:cartItemId', requireAuth, deleteCartItem);
// Authoritative totals - the app never computes a discount of its own.
router.post('/me/cart/:cartItemId/quote', requireAuth, postCartQuote);
router.post('/me/cart/:cartItemId/purchase', requireAuth, postCartPurchase);
// Coupons a member may choose at checkout: public and valid today.
router.get('/me/coupons', requireAuth, getMemberCoupons);

/**
 * The member's own coaching history. Scoped to the authenticated user: there is
 * no userId parameter, so one member cannot read another's purchases.
 */
router.get('/me/enrollments', requireAuth, getMyEnrollments);
// The coach on the member's active enrollment, or null when there is none.
router.get('/me/coach', requireAuth, getMyCoach);

/**
 * The onboarding questionnaire, scoped to one of the member's own enrollments.
 *
 * The enrollment id in the path is the only thing the client chooses, and it is
 * resolved against the authenticated user's own enrollments - so changing it
 * cannot reach another member's questionnaire. The coach is read off the
 * enrollment; neither route accepts a userId or a coachId.
 */
// The member's whole questionnaire history, newest submission first. Scoped to
// the authenticated user, so there is nothing to tamper with but the status.
router.get('/me/questionnaires', requireAuth, getMyQuestionnaires);
router.get('/me/enrollments/:enrollmentId/questionnaire', requireAuth, getMyQuestionnaire);
router.post('/me/enrollments/:enrollmentId/questionnaire', requireAuth, postMyQuestionnaire);

/**
 * Body Metrics, scoped to one of the member's own enrollments exactly like the
 * questionnaire. Media go through their own raw-bytes route per slot: the video
 * with the video size limit, the photos with the image limit.
 */
const bodyMetricsMediaBody = (req, res, next) =>
  (req.params.slot === 'video' ? rawVideoBody : rawImageBody)(req, res, next);

router.get('/me/body-metrics', requireAuth, getMyBodyMetricsList);
router.get('/me/enrollments/:enrollmentId/body-metrics', requireAuth, getMyBodyMetrics);
router.post('/me/enrollments/:enrollmentId/body-metrics', requireAuth, postMyBodyMetrics);
router.put('/me/enrollments/:enrollmentId/body-metrics/media/:slot', requireAuth, bodyMetricsMediaBody, putMyBodyMetricsMedia);
router.delete('/me/enrollments/:enrollmentId/body-metrics/media/:slot', requireAuth, deleteMyBodyMetricsMedia);

export default router;
