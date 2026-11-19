import {
  archiveIntroVideo,
  createIntroVideo,
  getIntroVideoById,
  listIntroVideos,
  listIntroVideosForMember,
  restoreIntroVideo,
  updateIntroVideo,
} from '../services/intro-video.service.js';
import { removeIntroVideoMedia, setIntroVideoMedia } from '../services/intro-video-media.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import {
  validateCreateIntroVideo,
  validateIntroVideoListQuery,
  validateUpdateIntroVideo,
} from '../validators/intro-video.validator.js';

const introVideoNotFound = () => notFound(ERROR_CODES.INTRO_VIDEO_NOT_FOUND, 'Introductory video not found');

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/intro-videos */
export const getIntroVideos = handle(async (req, res) => {
  const r = await listIntroVideos(validateIntroVideoListQuery(req.query));
  res.status(200).json({
    success: true,
    data: { introVideos: r.rows, pagination: { page: r.page, pageSize: r.pageSize, total: r.total, totalPages: r.totalPages } },
  });
});

/** GET /api/admin/intro-videos/:id */
export const getIntroVideo = handle(async (req, res) => {
  const introVideo = await getIntroVideoById(req.params.id);
  if (!introVideo) throw introVideoNotFound();
  res.status(200).json({ success: true, data: { introVideo } });
});

/** POST /api/admin/intro-videos */
export const postIntroVideo = handle(async (req, res) => {
  const introVideo = await createIntroVideo(validateCreateIntroVideo(req.body), req.user._id);
  res.status(201).json({ success: true, message: 'Introductory video created', data: { introVideo } });
});

/** PUT / PATCH /api/admin/intro-videos/:id - partial update (also restores with { status: "active" }). */
export const putIntroVideo = handle(async (req, res) => {
  const introVideo = await updateIntroVideo(req.params.id, validateUpdateIntroVideo(req.body), req.user._id);
  if (!introVideo) throw introVideoNotFound();
  res.status(200).json({ success: true, message: 'Introductory video updated', data: { introVideo } });
});

/** DELETE /api/admin/intro-videos/:id - archives (soft delete). */
export const deleteIntroVideo = handle(async (req, res) => {
  const introVideo = await archiveIntroVideo(req.params.id, req.user._id);
  if (!introVideo) throw introVideoNotFound();
  res.status(200).json({ success: true, message: 'Introductory video archived', data: { introVideo } });
});

/** POST /api/admin/intro-videos/:id/restore */
export const postIntroVideoRestore = handle(async (req, res) => {
  const introVideo = await restoreIntroVideo(req.params.id, req.user._id);
  if (!introVideo) throw introVideoNotFound();
  res.status(200).json({ success: true, message: 'Introductory video restored', data: { introVideo } });
});

/** PUT /api/admin/intro-videos/:id/{video,thumbnail} - the raw bytes as the body. */
export const putIntroVideoMedia = (slot) =>
  handle(async (req, res) => {
    const introVideo = await setIntroVideoMedia(slot, req.params.id, req.body, req.user._id);
    if (!introVideo) throw introVideoNotFound();
    res.status(200).json({ success: true, message: `Introductory video ${slot} updated`, data: { introVideo } });
  });

/** DELETE /api/admin/intro-videos/:id/{video,thumbnail} */
export const deleteIntroVideoMedia = (slot) =>
  handle(async (req, res) => {
    const introVideo = await removeIntroVideoMedia(slot, req.params.id, req.user._id);
    if (!introVideo) throw introVideoNotFound();
    res.status(200).json({ success: true, message: `Introductory video ${slot} removed`, data: { introVideo } });
  });

/** GET /api/intro-videos - the signed-in member's lesson list. */
export const getMemberIntroVideos = handle(async (_req, res) => {
  res.status(200).json({ success: true, data: { introVideos: await listIntroVideosForMember() } });
});
