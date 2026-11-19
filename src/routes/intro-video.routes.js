import { Router } from 'express';

import { getMemberIntroVideos } from '../controllers/intro-video.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

/**
 * GET /api/intro-videos - the Introductory Videos the app lists (any signed-in
 * user). Read-only; managing them stays on /api/admin/intro-videos.
 */
const router = Router();

router.get('/', requireAuth, getMemberIntroVideos);

export default router;
