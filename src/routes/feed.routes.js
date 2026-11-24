import { Router } from 'express';

import { deleteLike, deleteSave, getFeed, getFeedPost, getHomePreview, putLike, putSave } from '../controllers/feed.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

/** The Feed as every signed-in account reads it. Authoring lives under /coach/feed. */
const router = Router();

/**
 * The one listing a guest (no account) may read: the Results listing's image
 * posts - `GET /feed?type=transformation&mediaType=images`, nothing narrower or
 * wider - for the Continuous Guest's Transformation tab. Same query, same
 * response shape, with no viewer state. A request that carries a token, or
 * asks for anything else, needs a valid sign-in as before.
 */
const guestTransformationImages = (req) =>
  !req.get('authorization') &&
  req.query.type === 'transformation' &&
  req.query.mediaType === 'images' &&
  req.query.coachId === undefined;

router.get('/', (req, res, next) => (guestTransformationImages(req) ? next() : requireAuth(req, res, next)), getFeed);

router.use(requireAuth);

router.get('/home-preview', getHomePreview);
router.get('/posts/:id', getFeedPost);
router.put('/posts/:id/like', putLike);
router.delete('/posts/:id/like', deleteLike);
router.put('/posts/:id/save', putSave);
router.delete('/posts/:id/save', deleteSave);

export default router;
