import { Router } from 'express';

import {
  deleteProfilePicture,
  getMe,
  patchProfile,
  putProfilePicture,
} from '../controllers/user.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { rawImageBody } from '../middleware/upload.middleware.js';

const router = Router();

router.get('/me', requireAuth, getMe);
router.patch('/me/profile', requireAuth, patchProfile);

// The avatar is always editable by its owner, independent of the email lock.
router.put('/me/profile-picture', requireAuth, rawImageBody, putProfilePicture);
router.delete('/me/profile-picture', requireAuth, deleteProfilePicture);

export default router;
