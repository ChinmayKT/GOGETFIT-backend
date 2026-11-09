import {
  createDraft,
  deletePost,
  editPost,
  getPost,
  likePost,
  listFeed,
  listOwnPosts,
  listSavedPosts,
  publishPost,
  savePost,
  unlikePost,
  unsavePost,
  uploadPostMedia,
} from '../services/feed.service.js';

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

const pageQuery = (req) => ({ type: req.query.type, limit: req.query.limit, cursor: req.query.cursor });

// --- member and coach: reading, likes, saves ---------------------------------

/** GET /api/feed?type=all|article|transformation&limit=&cursor= */
export const getFeed = handle(async (req, res) => {
  res.status(200).json({ success: true, data: await listFeed(req.user, pageQuery(req)) });
});

/** GET /api/feed/posts/:id */
export const getFeedPost = handle(async (req, res) => {
  res.status(200).json({ success: true, data: { post: await getPost(req.user, req.params.id) } });
});

/** PUT|DELETE /api/feed/posts/:id/like */
export const putLike = handle(async (req, res) => {
  res.status(200).json({ success: true, data: { like: await likePost(req.user, req.params.id) } });
});
export const deleteLike = handle(async (req, res) => {
  res.status(200).json({ success: true, data: { like: await unlikePost(req.user, req.params.id) } });
});

/** PUT|DELETE /api/feed/posts/:id/save */
export const putSave = handle(async (req, res) => {
  res.status(200).json({ success: true, data: { save: await savePost(req.user, req.params.id) } });
});
export const deleteSave = handle(async (req, res) => {
  res.status(200).json({ success: true, data: { save: await unsavePost(req.user, req.params.id) } });
});

/** GET /api/users/me/saved-posts?limit=&cursor= */
export const getMySavedPosts = handle(async (req, res) => {
  res.status(200).json({ success: true, data: await listSavedPosts(req.user, pageQuery(req)) });
});

// --- coach: authoring ----------------------------------------------------------

/** GET /api/coach/feed/posts?type=&limit=&cursor= */
export const getMyPosts = handle(async (req, res) => {
  res.status(200).json({ success: true, data: await listOwnPosts(req.user, pageQuery(req)) });
});

/** POST /api/coach/feed/posts - { type, title, text, mediaType, mediaCount, aspectRatio?, crops?, clientRequestId? } */
export const postDraft = handle(async (req, res) => {
  res.status(201).json({ success: true, data: { post: await createDraft(req.user, req.body) } });
});

/** PUT /api/coach/feed/posts/:id/media/:index?width=&height=&durationMs= - raw bytes. */
export const putPostMedia = handle(async (req, res) => {
  const post = await uploadPostMedia(req.user, req.params.id, req.params.index, req.body, {
    width: req.query.width,
    height: req.query.height,
    durationMs: req.query.durationMs,
  });
  res.status(200).json({ success: true, data: { post } });
});

/** PUT /api/coach/feed/posts/:id/media/:index/thumbnail - raw image bytes. */
export const putPostThumbnail = handle(async (req, res) => {
  const post = await uploadPostMedia(req.user, req.params.id, req.params.index, req.body, { slot: 'thumbnail' });
  res.status(200).json({ success: true, data: { post } });
});

/** POST /api/coach/feed/posts/:id/publish */
export const postPublish = handle(async (req, res) => {
  res.status(200).json({ success: true, data: { post: await publishPost(req.user, req.params.id) } });
});

/** PATCH /api/coach/feed/posts/:id - { title?, text? } */
export const patchPost = handle(async (req, res) => {
  res.status(200).json({ success: true, data: { post: await editPost(req.user, req.params.id, req.body) } });
});

/** DELETE /api/coach/feed/posts/:id */
export const removePost = handle(async (req, res) => {
  res.status(200).json({ success: true, data: { post: await deletePost(req.user, req.params.id) } });
});
