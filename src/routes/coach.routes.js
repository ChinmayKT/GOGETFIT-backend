import { Router } from 'express';

import {
  getCoachByIdForMember,
  getCoachesForMember,
  getCoachPlansForMember,
  getMyCoachRecord,
} from '../controllers/coach-member.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

/**
 * Member-facing coach discovery. Read-only and authenticated; no role needed.
 * Every write (create, edit, pictures, status) stays on /api/admin/coaches
 * behind requireRole('admin'). There is deliberately no write route here.
 */
router.get('/', requireAuth, getCoachesForMember);
// The caller's own coach record, for the Coach Workspace. Declared before
// '/:id' so "me" is never read as an object id.
router.get('/me', requireAuth, getMyCoachRecord);
router.get('/:id', requireAuth, getCoachByIdForMember);
// The plans this coach offers: every active GoGetFit Plan of the coach's level.
router.get('/:id/plans', requireAuth, getCoachPlansForMember);

export default router;
