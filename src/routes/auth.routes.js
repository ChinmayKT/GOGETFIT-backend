import { Router } from 'express';

import env from '../config/env.js';
import { postAdminLogin } from '../controllers/admin.controller.js';
import { postRequestOtp, postVerifyOtp } from '../controllers/auth.controller.js';
import { rateLimit } from '../middleware/rate-limit.middleware.js';

const router = Router();

router.post('/request-otp', postRequestOtp);
router.post('/verify-otp', postVerifyOtp);

/**
 * Admin Portal password login. Throttled on two independent keys - the client
 * IP and the submitted email - so neither spraying many accounts from one
 * address nor grinding one account from many addresses stays cheap.
 *
 * Per-account lockout is enforced separately, and durably, in the service.
 */
router.post(
  '/admin/login',
  rateLimit({
    limit: env.adminAuth.rateLimit.limit,
    windowMs: env.adminAuth.rateLimit.windowMs,
    keys: (req) => [
      `admin-login:ip:${req.ip}`,
      `admin-login:email:${String(req.body?.email ?? '').trim().toLowerCase()}`,
    ],
  }),
  postAdminLogin,
);

export default router;
