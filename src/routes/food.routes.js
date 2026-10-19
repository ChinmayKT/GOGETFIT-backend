import { Router } from 'express';

import { getActiveFoods } from '../controllers/food.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

/**
 * The canonical Food database, read-only, for any signed-in user (the coach's
 * Add to Meal and the member's Add Food): the admin list's own query and rows,
 * active foods only. Every write stays on /api/admin/foods behind the admin
 * role; there is deliberately no write route here.
 */
const router = Router();

router.get('/', requireAuth, getActiveFoods);

export default router;
