import { Router } from 'express';

import {
  deleteAdminTalk,
  deleteThumbnail,
  getAdminTalkById,
  getAdminTalks,
  getAdminTalksStats,
  patchArchive,
  patchPublish,
  patchRestore,
  patchUnpublish,
  postAdminTalk,
  postPreview,
  postRefreshMetadata,
  putAdminTalk,
  putThumbnail,
} from '../controllers/talks.controller.js';
import { rawImageBody } from '../middleware/upload.middleware.js';

/**
 * /api/admin/talks - TALKS management (YouTube links). Mounted inside the
 * admin router, so every route is behind requireAuth + requireRole('admin').
 */
const router = Router();

router.get('/', getAdminTalks);
router.get('/stats', getAdminTalksStats);
router.post('/preview', postPreview);
router.post('/', postAdminTalk);
router.get('/:id', getAdminTalkById);
router.put('/:id', putAdminTalk);
router.delete('/:id', deleteAdminTalk);
router.patch('/:id/publish', patchPublish);
router.patch('/:id/unpublish', patchUnpublish);
router.patch('/:id/archive', patchArchive);
router.patch('/:id/restore', patchRestore);
router.post('/:id/refresh-metadata', postRefreshMetadata);
router.put('/:id/thumbnail', rawImageBody, putThumbnail);
router.delete('/:id/thumbnail', deleteThumbnail);

export default router;
