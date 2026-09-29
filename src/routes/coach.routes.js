import { Router } from 'express';

import { getCoachByIdForMember, getCoachesForMember } from '../controllers/coach-member.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

/**
 * Member-facing coach discovery. Read-only and authenticated; no role needed.
 * Every write (create, edit, pictures, status) stays on /api/admin/coaches
 * behind requireRole('admin'). There is deliberately no write route here.
 */
router.get('/', requireAuth, getCoachesForMember);
router.get('/:id', requireAuth, getCoachByIdForMember);

export default router;
