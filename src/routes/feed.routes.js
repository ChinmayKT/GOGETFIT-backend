import { Router } from 'express';

import { deleteLike, deleteSave, getFeed, getFeedPost, putLike, putSave } from '../controllers/feed.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

/** The Feed as every signed-in account reads it. Authoring lives under /coach/feed. */
const router = Router();

router.use(requireAuth);

router.get('/', getFeed);
router.get('/posts/:id', getFeedPost);
router.put('/posts/:id/like', putLike);
router.delete('/posts/:id/like', deleteLike);
router.put('/posts/:id/save', putSave);
router.delete('/posts/:id/save', deleteSave);

export default router;
