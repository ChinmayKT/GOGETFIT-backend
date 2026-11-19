import { Router } from 'express';

import { getPublicFaqs } from '../controllers/faq.controller.js';

/**
 * GET /api/faqs?search= - the FAQs, no authentication (legacy GetFAQ was
 * public). Read-only; creating and editing stay on /api/admin/faqs behind
 * the admin role.
 */
const router = Router();

router.get('/', getPublicFaqs);

export default router;
