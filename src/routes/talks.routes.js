import { Router } from 'express';

import env from '../config/env.js';
import {
  deleteHifi,
  deleteSave,
  getFeatured,
  getSavedTalks,
  getTalk,
  getTalks,
  postEvent,
  postHifi,
  postSave,
} from '../controllers/talks.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { rateLimit } from '../middleware/rate-limit.middleware.js';

/**
 * /api/talks - what members read and do: published talks only (YouTube
 * links; the video plays on YouTube), the caller's own Hi-Fi / Save, and
 * once-a-day open / share events. Nothing here can create, edit or publish a
 * talk (that is /api/admin/talks), and nothing here calls YouTube.
 */
const router = Router();

router.use(requireAuth);

const engagementLimit = rateLimit({
  limit: env.talks.engagementRateLimit,
  windowMs: 60 * 1000,
  keys: (req) => [`talks-engagement:${req.user._id}`],
});

router.get('/', getTalks);
router.get('/featured', getFeatured);
router.get('/saved', getSavedTalks);
router.get('/:id', getTalk);
router.post('/:id/hifi', engagementLimit, postHifi);
router.delete('/:id/hifi', engagementLimit, deleteHifi);
router.post('/:id/save', engagementLimit, postSave);
router.delete('/:id/save', engagementLimit, deleteSave);
router.post('/:id/events', engagementLimit, postEvent);

export default router;
