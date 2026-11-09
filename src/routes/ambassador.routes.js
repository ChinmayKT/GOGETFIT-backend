import { Router } from 'express';

import { getMe, postRegister } from '../controllers/brand-ambassador.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

/**
 * The signed-in user's own Brand Ambassador profile. Neither route takes a
 * user id: the owner is the token's user, so one account can never read or
 * register another. Individual referrals are admin-only (under /admin).
 */
const router = Router();

router.get('/me', requireAuth, getMe);
router.post('/register', requireAuth, postRegister);

export default router;
