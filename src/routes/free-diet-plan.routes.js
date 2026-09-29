import { Router } from 'express';

import { getFreeDietPlanForMember } from '../controllers/free-diet-plan-member.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

/**
 * Member-facing Free Diet Plan reads. Authenticated, no role required: a member
 * fetches the template their own profile points at. Creating, editing, deleting
 * and listing templates stay on /api/admin/free-diet-plans behind
 * requireRole('admin').
 */
router.get('/:id', requireAuth, getFreeDietPlanForMember);

export default router;
