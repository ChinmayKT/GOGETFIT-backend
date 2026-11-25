import {
  archiveTalk,
  createTalk,
  deleteTalk,
  getAdminTalk,
  listFeaturedTalks,
  getMemberTalk,
  hifiTalk,
  listAdminTalks,
  listMemberTalks,
  listSavedTalks,
  previewYouTubeTalk,
  publishTalk,
  recordTalkEvent,
  refreshTalkMetadata,
  removeTalkThumbnail,
  restoreTalk,
  saveTalk,
  setTalkThumbnail,
  talksStats,
  unhifiTalk,
  unpublishTalk,
  unsaveTalk,
  updateTalk,
} from '../services/talks.service.js';
import {
  validateAdminListQuery,
  validateCreateTalk,
  validateEvent,
  validateMemberListQuery,
  validatePageQuery,
  validatePreview,
  validateUpdateTalk,
} from '../validators/talks.validator.js';

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

const ok = (res, data, status = 200, message) =>
  res.status(status).json({ success: true, ...(message ? { message } : {}), data });
const one = (res, talk, message, status = 200) => ok(res, { talk }, status, message);

// --- Admin (mounted behind requireAuth + requireRole('admin')) ---------------

export const getAdminTalks = handle(async (req, res) => ok(res, await listAdminTalks(validateAdminListQuery(req.query))));
export const getAdminTalksStats = handle(async (_req, res) => ok(res, { stats: await talksStats() }));
export const postPreview = handle(async (req, res) => ok(res, { preview: await previewYouTubeTalk(validatePreview(req.body)) }));
export const getAdminTalkById = handle(async (req, res) => one(res, await getAdminTalk(req.params.id)));
export const postAdminTalk = handle(async (req, res) =>
  one(res, await createTalk(validateCreateTalk(req.body), req.user._id), 'Talk created', 201),
);
export const putAdminTalk = handle(async (req, res) =>
  one(res, await updateTalk(req.params.id, validateUpdateTalk(req.body), req.user._id), 'Talk updated'),
);
export const deleteAdminTalk = handle(async (req, res) =>
  ok(res, await deleteTalk(req.params.id, req.user._id), 200, 'Talk deleted'),
);
export const patchPublish = handle(async (req, res) => one(res, await publishTalk(req.params.id, req.user._id), 'Talk published'));
export const patchUnpublish = handle(async (req, res) => one(res, await unpublishTalk(req.params.id, req.user._id), 'Talk unpublished'));
export const patchArchive = handle(async (req, res) => one(res, await archiveTalk(req.params.id, req.user._id), 'Talk archived'));
export const patchRestore = handle(async (req, res) => one(res, await restoreTalk(req.params.id, req.user._id), 'Talk restored'));
export const postRefreshMetadata = handle(async (req, res) =>
  one(res, await refreshTalkMetadata(req.params.id, req.user._id), 'Metadata refreshed'),
);
export const putThumbnail = handle(async (req, res) =>
  one(res, await setTalkThumbnail(req.params.id, req.body, req.user._id), 'Thumbnail updated'),
);
export const deleteThumbnail = handle(async (req, res) =>
  one(res, await removeTalkThumbnail(req.params.id, req.user._id), 'Thumbnail removed'),
);

// --- Members ------------------------------------------------------------------

export const getTalks = handle(async (req, res) => ok(res, await listMemberTalks(req.user, validateMemberListQuery(req.query))));
export const getFeatured = handle(async (req, res) => ok(res, { talks: await listFeaturedTalks(req.user) }));
export const getSavedTalks = handle(async (req, res) => ok(res, await listSavedTalks(req.user, validatePageQuery(req.query))));
export const getTalk = handle(async (req, res) => one(res, await getMemberTalk(req.user, req.params.id)));
export const postHifi = handle(async (req, res) => one(res, await hifiTalk(req.user, req.params.id)));
export const deleteHifi = handle(async (req, res) => one(res, await unhifiTalk(req.user, req.params.id)));
export const postSave = handle(async (req, res) => one(res, await saveTalk(req.user, req.params.id)));
export const deleteSave = handle(async (req, res) => one(res, await unsaveTalk(req.user, req.params.id)));
export const postEvent = handle(async (req, res) => ok(res, await recordTalkEvent(req.user, req.params.id, validateEvent(req.body))));
