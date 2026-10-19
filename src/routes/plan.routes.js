import { Router } from 'express';

import { getPublicPlans } from '../controllers/gogetfit-plan.controller.js';

/**
 * The public plans catalogue: GET /api/plans/public, no authentication - so a
 * guest can browse the real plans. Read-only; every write stays on
 * /api/admin/gogetfit-plans behind the admin role.
 */
const router = Router();

router.get('/public', getPublicPlans);

export default router;
