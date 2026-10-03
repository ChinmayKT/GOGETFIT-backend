import { Router } from 'express';

import adminRoutes from './admin.routes.js';
import authRoutes from './auth.routes.js';
import coachRoutes from './coach.routes.js';
import coachWorkspaceRoutes from './coach-workspace.routes.js';
import freeDietPlanRoutes from './free-diet-plan.routes.js';
import userRoutes from './user.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
// Member-facing template reads. The admin CRUD stays under /admin.
router.use('/free-diet-plans', freeDietPlanRoutes);
// Member-facing coach discovery (read-only). Coach management stays under /admin.
router.use('/coaches', coachRoutes);
// The signed-in coach's own workspace (coach role only).
router.use('/coach', coachWorkspaceRoutes);
// Admin Portal surface. Authentication and role checks live inside.
router.use('/admin', adminRoutes);

export default router;
