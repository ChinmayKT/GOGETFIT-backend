import mongoose from 'mongoose';

import env from '../config/env.js';
import logger from '../config/logger.js';
import { ROLE_COACH, hasRole } from '../constants/roles.js';
import Coach from '../models/coach.model.js';
import Post, {
  CROP_MAX_ZOOM,
  POST_ASPECT_RATIOS,
  POST_MAX_IMAGES,
  POST_TEXT_MAX,
  POST_TITLE_MAX,
  POST_TYPES,
} from '../models/post.model.js';
import PostLike from '../models/post-like.model.js';
import PostSave from '../models/post-save.model.js';
import User from '../models/user.model.js';
import { assertValidImage } from '../utils/image.js';
import { assertValidVideo } from '../utils/video.js';
import { ERROR_CODES, badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { postMediaExists, removePostMedia, savePostMedia } from './feed-media-storage.service.js';

/**
 * The Feed: one post system for every author. Coaches publish today; members
 * will publish through the same calls once `env.feed.memberPublishing` is on.
 *
 * Every identity comes from the authenticated account, never from the request.
 * Only published posts by active authors are shown, and nothing about a post's
 * author is stored on it: names and pictures are read when the post is shown.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
/** A draft whose upload never finished is deleted, with its files, after this. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DIMENSION = 20000;
const MAX_DURATION_MS = 60 * 60 * 1000;
const CLIENT_REQUEST_ID_MAX = 64;

const postNotFound = () => notFound(ERROR_CODES.POST_NOT_FOUND, 'Post not found');
const invalid = (message) => badRequest(ERROR_CODES.VALIDATION_ERROR, message);

// --- input -------------------------------------------------------------------

/** Optional on a draft: posts without one keep each item's own shape. */
const aspectRatioOf = (value) => {
  if (value === undefined || value === null) return null;
  if (!POST_ASPECT_RATIOS.includes(value)) throw invalid(`aspectRatio must be one of ${POST_ASPECT_RATIOS.join(', ')}`);
  return value;
};

/**
 * One entry per media slot (or none), in slot order: `{ aspectRatio?, x, y, zoom }`
 * or null. Returns each slot's own ratio and crop.
 */
const cropsOf = (value, count) => {
  if (value === undefined || value === null) return Array(count).fill({ aspectRatio: null, crop: null });
  if (!Array.isArray(value) || value.length !== count) throw invalid(`crops must have one entry per media item (${count})`);
  return value.map((entry, i) => {
    if (entry === null) return { aspectRatio: null, crop: null };
    if (typeof entry !== 'object') throw invalid(`crops[${i}] must be an object`);
    const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : NaN);
    const crop = { x: num(entry.x, -1, 1), y: num(entry.y, -1, 1), zoom: num(entry.zoom, 1, CROP_MAX_ZOOM) };
    if (Object.values(crop).some(Number.isNaN)) {
      throw invalid(`crops[${i}] needs x and y from -1 to 1 and zoom from 1 to ${CROP_MAX_ZOOM}`);
    }
    return { aspectRatio: aspectRatioOf(entry.aspectRatio), crop };
  });
};

const requiredText = (value, label, max) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw invalid(`${label} is required`);
  if (text.length > max) throw invalid(`${label} must be at most ${max} characters`);
  return text;
};

const postType = (value) => {
  if (!POST_TYPES.includes(value)) throw invalid(`type must be one of: ${POST_TYPES.join(', ')}`);
  return value;
};

const pageSize = (value) => {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw invalid('limit must be a positive integer');
  return Math.min(n, MAX_PAGE_SIZE);
};

const feedType = (value) => {
  if (value === undefined || value === 'all') return null;
  return postType(value);
};

/** An optional measured size: a whole number in range, or null. */
const measurement = (value, label, max) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw invalid(`${label} must be a whole number from 1 to ${max}`);
  return n;
};

const objectId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw postNotFound();
  return new mongoose.Types.ObjectId(String(id));
};

// --- cursors -----------------------------------------------------------------

/** Opaque to the app: the last item's sort time and id. */
const encodeCursor = (at, id) => Buffer.from(`${new Date(at).toISOString()}_${id}`).toString('base64url');

const decodeCursor = (cursor) => {
  const [iso, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('_');
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()) || !mongoose.isValidObjectId(id)) throw invalid('cursor is invalid');
  return { at, id: new mongoose.Types.ObjectId(id) };
};

/** Strictly after the cursor in (field desc, _id desc) order, so pages never overlap. */
const afterCursor = (field, cursor) => {
  if (cursor === undefined) return {};
  const { at, id } = decodeCursor(cursor);
  return { $or: [{ [field]: { $lt: at } }, { [field]: at, _id: { $lt: id } }] };
};

// --- who may publish, and whose posts are shown -------------------------------

/**
 * The author identity [user] publishes as. A coach publishes as their coach
 * profile. Anyone else is a member, refused until member publishing is on.
 */
export const publisherOf = async (user) => {
  if (hasRole(user, ROLE_COACH)) {
    const coach = await Coach.findOne({ userId: user._id }, { _id: 1, status: 1 }).lean();
    if (!coach) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'You do not have a coach profile');
    if (coach.status !== 'active') throw forbidden(ERROR_CODES.COACH_INACTIVE, 'Your coach profile is not active');
    return { authorType: 'coach', authorCoachId: coach._id };
  }
  if (!env.feed.memberPublishing) {
    throw forbidden(ERROR_CODES.POST_PUBLISHING_DISABLED, 'Posting is not available for your account');
  }
  return { authorType: 'member', authorCoachId: null };
};

/**
 * Coach profiles whose posts may be shown: the profile is active and so is the
 * account behind it.
 *
 * ponytail: reads every active coach id per Feed request - fine for the coach
 * roster (dozens); denormalise an author status onto posts if it grows large.
 */
const visibleCoachIds = async () => {
  const coaches = await Coach.find({ status: 'active' }, { _id: 1, userId: 1 }).lean();
  const active = await User.find({ _id: { $in: coaches.map((c) => c.userId) }, status: 'active' }, { _id: 1 }).lean();
  const activeIds = new Set(active.map((u) => String(u._id)));
  return coaches.filter((c) => activeIds.has(String(c.userId))).map((c) => c._id);
};

/**
 * The query every member-facing read starts from. Member posts are included
 * only once member publishing is on; their authors' account status is then
 * checked as the page is shown.
 */
const visibleQuery = async () => {
  const coachIds = await visibleCoachIds();
  if (!env.feed.memberPublishing) {
    return { status: 'published', authorType: 'coach', authorCoachId: { $in: coachIds } };
  }
  return {
    status: 'published',
    $or: [{ authorType: 'coach', authorCoachId: { $in: coachIds } }, { authorType: 'member' }],
  };
};

/** A post the viewer may see and act on, or 404. Hidden, removed and inactive authors look the same. */
const visiblePost = async (postId) => {
  const post = await Post.findOne({ ...(await visibleQuery()), _id: objectId(postId) }).lean();
  if (!post) throw postNotFound();
  if (post.authorType === 'member' && !(await User.exists({ _id: post.authorUserId, status: 'active' }))) {
    throw postNotFound();
  }
  return post;
};

// --- presentation ------------------------------------------------------------

const toMediaView = (m) => ({
  id: m.id,
  kind: m.kind,
  url: m.url,
  width: m.width ?? null,
  height: m.height ?? null,
  position: m.position,
  aspectRatio: m.aspectRatio ?? null,
  crop: m.crop ? { x: m.crop.x, y: m.crop.y, zoom: m.crop.zoom } : null,
  ...(m.kind === 'video' ? { thumbnailUrl: m.thumbnailUrl ?? null, durationMs: m.durationMs ?? null } : {}),
});

/**
 * Posts as the app shows them, in the order given, for [viewerId]. Authors and
 * the viewer's likes and saves are read once for the whole page. A post whose
 * author can no longer be shown (inactive, deleted) is dropped.
 */
const present = async (docs, viewerId, { requireActiveAuthor = true } = {}) => {
  if (docs.length === 0) return [];
  const ids = docs.map((d) => d._id);
  const coachIds = docs.filter((d) => d.authorCoachId).map((d) => d.authorCoachId);
  const [coaches, users, likes, saves] = await Promise.all([
    Coach.find({ _id: { $in: coachIds } }, { userId: 1, status: 1, 'profile.profilePicture': 1 }).lean(),
    User.find(
      { _id: { $in: docs.map((d) => d.authorUserId) } },
      { status: 1, 'profile.name': 1, 'profile.profilePicture': 1 },
    ).lean(),
    PostLike.find({ userId: viewerId, postId: { $in: ids } }, { postId: 1 }).lean(),
    PostSave.find({ userId: viewerId, postId: { $in: ids } }, { postId: 1 }).lean(),
  ]);
  const coachById = new Map(coaches.map((c) => [String(c._id), c]));
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const liked = new Set(likes.map((l) => String(l.postId)));
  const saved = new Set(saves.map((s) => String(s.postId)));

  return docs.flatMap((doc) => {
    const user = userById.get(String(doc.authorUserId));
    const coach = doc.authorCoachId ? coachById.get(String(doc.authorCoachId)) : null;
    if (requireActiveAuthor) {
      if (user?.status !== 'active') return [];
      if (doc.authorType === 'coach' && coach?.status !== 'active') return [];
    }
    const id = String(doc._id);
    return [
      {
        id,
        authorType: doc.authorType,
        type: doc.type,
        title: doc.title,
        text: doc.text,
        status: doc.status,
        publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
        editedAt: doc.editedAt ? doc.editedAt.toISOString() : null,
        author: {
          userId: String(doc.authorUserId),
          coachId: doc.authorCoachId ? String(doc.authorCoachId) : null,
          name: user?.profile?.name ?? null,
          role: doc.authorType,
          // Every coach profile is created by GOGETFIT; members are never badged.
          verified: doc.authorType === 'coach',
          // A coach is shown with their own professional photo, a member with
          // their avatar - the only public picture either has.
          avatarUrl:
            doc.authorType === 'coach' ? (coach?.profile?.profilePicture?.url ?? null) : (user?.profile?.profilePicture ?? null),
        },
        mediaType: doc.mediaType,
        aspectRatio: doc.aspectRatio ?? null,
        media: [...doc.media].sort((a, b) => a.position - b.position).map(toMediaView),
        likeCount: doc.likeCount ?? 0,
        likedByMe: liked.has(id),
        savedByMe: saved.has(id),
        canEdit: String(doc.authorUserId) === String(viewerId) && doc.status === 'published',
      },
    ];
  });
};

/** The author's view of a draft: which slots are filled, nothing else. */
const toDraftView = (doc) => ({
  id: String(doc._id),
  status: doc.status,
  type: doc.type,
  title: doc.title,
  text: doc.text,
  mediaType: doc.mediaType,
  aspectRatio: doc.aspectRatio ?? null,
  media: [...doc.media]
    .sort((a, b) => a.position - b.position)
    .map((m) => ({ ...toMediaView(m), uploaded: Boolean(m.url), thumbnailUploaded: m.kind === 'video' ? Boolean(m.thumbnailUrl) : undefined })),
});

// --- authoring -----------------------------------------------------------------

/**
 * Deletes [authorUserId]'s drafts (or everyone's, with no author) that never
 * finished uploading. The draft is deleted first, and only while still a draft,
 * so a post that was published in the meantime keeps every file.
 */
export const cleanupAbandonedDrafts = async ({ authorUserId = null, now = new Date(), ttlMs = DRAFT_TTL_MS } = {}) => {
  const stale = await Post.find(
    { status: 'uploading', createdAt: { $lt: new Date(now.getTime() - ttlMs) }, ...(authorUserId ? { authorUserId } : {}) },
    { media: 1 },
  ).lean();
  let removed = 0;
  for (const draft of stale) {
    const { deletedCount } = await Post.deleteOne({ _id: draft._id, status: 'uploading' });
    if (deletedCount !== 1) continue;
    removed += 1;
    for (const m of draft.media) {
      await removePostMedia(m.storageKey);
      await removePostMedia(m.thumbnailStorageKey);
    }
  }
  return removed;
};

/**
 * `POST /coach/feed/posts` - step 1 of publishing: a draft with an empty slot
 * per expected file. A retry with the same `clientRequestId` returns the same
 * draft rather than a second one.
 */
export const createDraft = async (user, body = {}) => {
  const author = await publisherOf(user);
  const type = postType(body.type);
  const title = requiredText(body.title, 'title', POST_TITLE_MAX);
  const text = requiredText(body.text, 'text', POST_TEXT_MAX);
  if (body.mediaType !== 'images' && body.mediaType !== 'video') throw invalid("mediaType must be 'images' or 'video'");
  const count = Number(body.mediaCount ?? (body.mediaType === 'video' ? 1 : undefined));
  if (body.mediaType === 'video' && count !== 1) throw invalid('A video post has exactly one video');
  if (body.mediaType === 'images' && (!Number.isInteger(count) || count < 1 || count > POST_MAX_IMAGES)) {
    throw invalid(`An image post has 1 to ${POST_MAX_IMAGES} images`);
  }
  const aspectRatio = aspectRatioOf(body.aspectRatio);
  const crops = cropsOf(body.crops, count);
  let clientRequestId;
  if (body.clientRequestId !== undefined) {
    clientRequestId = typeof body.clientRequestId === 'string' ? body.clientRequestId.trim() : '';
    if (!clientRequestId || clientRequestId.length > CLIENT_REQUEST_ID_MAX) throw invalid('clientRequestId is invalid');
    const existing = await Post.findOne({ authorUserId: user._id, clientRequestId }).lean();
    if (existing) return toDraftView(existing);
  }

  // Housekeeping: this author's abandoned drafts go before a new one starts.
  await cleanupAbandonedDrafts({ authorUserId: user._id }).catch((error) =>
    logger.warn(`Could not clean up abandoned feed drafts: ${error.message}`),
  );

  const kind = body.mediaType === 'video' ? 'video' : 'image';
  try {
    const doc = await Post.create({
      authorUserId: user._id,
      ...author,
      type,
      title,
      text,
      mediaType: body.mediaType,
      aspectRatio,
      media: Array.from({ length: count }, (_, i) => ({ id: `media_${i + 1}`, kind, position: i, ...crops[i] })),
      status: 'uploading',
      clientRequestId,
    });
    return toDraftView(doc.toObject());
  } catch (error) {
    // Two retries at once: the unique index let one through; return that one.
    if (error?.code === 11000 && clientRequestId) {
      return toDraftView(await Post.findOne({ authorUserId: user._id, clientRequestId }).lean());
    }
    throw error;
  }
};

/** The caller's own post, any status, or 404 - another author's post is never acknowledged. */
const ownPost = async (user, postId) => {
  const post = await Post.findOne({ _id: objectId(postId), authorUserId: user._id }).lean();
  if (!post || post.status === 'removed' || post.status === 'hidden') throw postNotFound();
  return post;
};

/**
 * `PUT /coach/feed/posts/:id/media/:index` (and `/thumbnail`) - step 2: one
 * file into one slot of a draft. The bytes decide the type, never the header.
 * Uploading again replaces the slot (a retry); a published post is refused.
 */
export const uploadPostMedia = async (user, postId, index, buffer, { slot = 'media', width, height, durationMs } = {}) => {
  const post = await ownPost(user, postId);
  if (post.status !== 'uploading') {
    throw conflict(ERROR_CODES.POST_NOT_EDITABLE, 'Media cannot be changed after publishing');
  }
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= post.media.length) throw invalid(`index must be from 0 to ${post.media.length - 1}`);
  const target = post.media.find((m) => m.position === i);
  const thumbnail = slot === 'thumbnail';
  if (thumbnail && target.kind !== 'video') throw invalid('Only a video has a thumbnail');

  const type =
    target.kind === 'video' && !thumbnail
      ? assertValidVideo(buffer, { maxBytes: env.storage.maxVideoUploadBytes })
      : assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes });

  const set = {};
  const prefix = `media.${post.media.indexOf(target)}`;
  if (!thumbnail) {
    set[`${prefix}.width`] = measurement(width, 'width', MAX_DIMENSION);
    set[`${prefix}.height`] = measurement(height, 'height', MAX_DIMENSION);
    if (target.kind === 'video') set[`${prefix}.durationMs`] = measurement(durationMs, 'durationMs', MAX_DURATION_MS);
  }

  const stored = await savePostMedia(buffer, {
    postId: post._id,
    slot: thumbnail ? `media-${i}-thumbnail` : `media-${i}`,
    extension: type.extension,
  });
  set[thumbnail ? `${prefix}.thumbnailUrl` : `${prefix}.url`] = stored.url;
  set[thumbnail ? `${prefix}.thumbnailStorageKey` : `${prefix}.storageKey`] = stored.storageKey;

  // Only while still a draft: a publish that won the race keeps its media.
  let before;
  try {
    before = await Post.findOneAndUpdate(
      { _id: post._id, authorUserId: user._id, status: 'uploading' },
      { $set: set },
      { new: false },
    ).lean();
  } catch (error) {
    // Nothing references the new file: it goes, and the draft is as it was.
    await removePostMedia(stored.storageKey);
    throw error;
  }
  if (!before) {
    await removePostMedia(stored.storageKey);
    throw conflict(ERROR_CODES.POST_NOT_EDITABLE, 'Media cannot be changed after publishing');
  }
  // A replaced file goes; the same bytes again keep the same (content-hashed) key.
  const previous = before.media.find((m) => m.position === i);
  const previousKey = thumbnail ? previous?.thumbnailStorageKey : previous?.storageKey;
  if (previousKey && previousKey !== stored.storageKey) await removePostMedia(previousKey);

  return toDraftView(await Post.findById(post._id).lean());
};

/**
 * `POST /coach/feed/posts/:id/publish` - step 3: the draft becomes visible, but
 * only with every file present (and a video's thumbnail). Publishing twice
 * returns the same post: a retried tap never makes a second one.
 */
export const publishPost = async (user, postId) => {
  const post = await ownPost(user, postId);
  if (post.status === 'published') return (await present([post], user._id, { requireActiveAuthor: false }))[0];

  for (const m of post.media) {
    if (!m.url) throw badRequest(ERROR_CODES.POST_INCOMPLETE, `Media ${m.position + 1} has not been uploaded`);
    if (m.kind === 'video' && !m.thumbnailUrl) throw badRequest(ERROR_CODES.POST_INCOMPLETE, 'The video needs a thumbnail');
    for (const key of [m.storageKey, m.kind === 'video' ? m.thumbnailStorageKey : null].filter(Boolean)) {
      if (!(await postMediaExists(key))) {
        throw badRequest(ERROR_CODES.POST_INCOMPLETE, `Media ${m.position + 1} is missing - upload it again`);
      }
    }
  }

  const published = await Post.findOneAndUpdate(
    { _id: post._id, authorUserId: user._id, status: 'uploading' },
    { $set: { status: 'published', publishedAt: new Date() } },
    { new: true },
  ).lean();
  const doc = published ?? (await ownPost(user, postId));
  if (doc.status !== 'published') throw postNotFound();
  return (await present([doc], user._id, { requireActiveAuthor: false }))[0];
};

/** `PATCH /coach/feed/posts/:id` - title and text only. Media is fixed once published. */
export const editPost = async (user, postId, body = {}) => {
  const other = Object.keys(body).filter((key) => key !== 'title' && key !== 'text');
  if (other.length) throw invalid(`Only title and text can be edited (not ${other.join(', ')})`);
  const set = {};
  if (body.title !== undefined) set.title = requiredText(body.title, 'title', POST_TITLE_MAX);
  if (body.text !== undefined) set.text = requiredText(body.text, 'text', POST_TEXT_MAX);
  if (!Object.keys(set).length) throw invalid('Send a title or text to change');

  const doc = await Post.findOneAndUpdate(
    { _id: objectId(postId), authorUserId: user._id, status: 'published' },
    { $set: { ...set, editedAt: new Date() } },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) throw postNotFound();
  return (await present([doc], user._id, { requireActiveAuthor: false }))[0];
};

/**
 * `DELETE /coach/feed/posts/:id` - a soft delete that keeps who and when. The
 * files stay: removing them is a separate, deliberate clean-up. Deleting again
 * succeeds quietly.
 */
export const deletePost = async (user, postId) => {
  const id = objectId(postId);
  const doc = await Post.findOneAndUpdate(
    { _id: id, authorUserId: user._id, status: { $in: ['uploading', 'published'] } },
    { $set: { status: 'removed', removedAt: new Date(), removedBy: user._id } },
    { new: true },
  ).lean();
  if (doc) return { id: String(doc._id), status: doc.status };
  if (await Post.exists({ _id: id, authorUserId: user._id, status: 'removed' })) return { id: String(id), status: 'removed' };
  throw postNotFound();
};

// --- reading -------------------------------------------------------------------

const page = async (query, sortField, { limit, cursor }, viewerId, presentOptions) => {
  const size = pageSize(limit);
  const filter = cursor === undefined ? query : { $and: [query, afterCursor(sortField, cursor)] };
  const docs = await Post.find(filter).sort({ [sortField]: -1, _id: -1 }).limit(size + 1).lean();
  const shown = docs.slice(0, size);
  const last = shown.at(-1);
  return {
    posts: await present(shown, viewerId, presentOptions),
    nextCursor: docs.length > size ? encodeCursor(last[sortField], last._id) : null,
  };
};

/** `GET /feed` - every visible author's published posts, newest first. */
export const listFeed = async (user, { type, limit, cursor } = {}) => {
  const kind = feedType(type);
  const query = await visibleQuery();
  return page(kind ? { ...query, type: kind } : query, 'publishedAt', { limit, cursor }, user._id);
};

/** `GET /coach/feed/posts` - the caller's own published posts, newest first. */
export const listOwnPosts = async (user, { type, limit, cursor } = {}) => {
  const kind = feedType(type);
  const query = { authorUserId: user._id, status: 'published', ...(kind ? { type: kind } : {}) };
  return page(query, 'publishedAt', { limit, cursor }, user._id, { requireActiveAuthor: false });
};

/** `GET /feed/posts/:id` - one visible post, or 404. */
export const getPost = async (user, postId) => {
  const post = await visiblePost(postId);
  const [view] = await present([post], user._id);
  if (!view) throw postNotFound();
  return view;
};

// --- likes and saves ------------------------------------------------------------

const likeState = async (postId, userId) => {
  const [post, mine] = await Promise.all([
    Post.findById(postId, { likeCount: 1 }).lean(),
    PostLike.exists({ postId, userId }),
  ]);
  return { postId: String(postId), liked: Boolean(mine), likeCount: post?.likeCount ?? 0 };
};

/**
 * Runs [work] in a transaction. A duplicate-key error means another request for
 * the same account and post got there first, which is the state wanted anyway.
 */
const atomically = async (work) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => work(session));
  } catch (error) {
    if (error?.code !== 11000) throw error;
  } finally {
    await session.endSession();
  }
};

/** `PUT /feed/posts/:id/like` - idempotent: a second like changes nothing. */
export const likePost = async (user, postId) => {
  const post = await visiblePost(postId);
  await atomically(async (session) => {
    const result = await PostLike.updateOne(
      { postId: post._id, userId: user._id },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true, session },
    );
    if (result.upsertedCount === 1) await Post.updateOne({ _id: post._id }, { $inc: { likeCount: 1 } }, { session });
  });
  return likeState(post._id, user._id);
};

/** `DELETE /feed/posts/:id/like` - only an existing like lowers the count, never below 0. */
export const unlikePost = async (user, postId) => {
  const post = await visiblePost(postId);
  await atomically(async (session) => {
    const { deletedCount } = await PostLike.deleteOne({ postId: post._id, userId: user._id }, { session });
    if (deletedCount === 1) {
      await Post.updateOne({ _id: post._id, likeCount: { $gt: 0 } }, { $inc: { likeCount: -1 } }, { session });
    }
  });
  return likeState(post._id, user._id);
};

/** `PUT /feed/posts/:id/save` - private and idempotent. */
export const savePost = async (user, postId) => {
  const post = await visiblePost(postId);
  try {
    await PostSave.updateOne(
      { postId: post._id, userId: user._id },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  return { postId: String(post._id), saved: true };
};

/** `DELETE /feed/posts/:id/save` - also works for a post that has since disappeared. */
export const unsavePost = async (user, postId) => {
  const id = objectId(postId);
  await PostSave.deleteOne({ postId: id, userId: user._id });
  return { postId: String(id), saved: false };
};

/**
 * `GET /users/me/saved-posts` - the caller's saves, most recent first. A saved
 * post that is no longer visible (removed, hidden, author inactive) is left
 * out, so a page can hold fewer than `limit`; `nextCursor` still continues.
 */
export const listSavedPosts = async (user, { limit, cursor } = {}) => {
  const size = pageSize(limit);
  const query = { userId: user._id };
  const filter = cursor === undefined ? query : { $and: [query, afterCursor('createdAt', cursor)] };
  const saves = await PostSave.find(filter).sort({ createdAt: -1, _id: -1 }).limit(size + 1).lean();
  const shown = saves.slice(0, size);
  const last = shown.at(-1);

  const visible = await Post.find({ ...(await visibleQuery()), _id: { $in: shown.map((s) => s.postId) } }).lean();
  const byId = new Map(visible.map((p) => [String(p._id), p]));
  const ordered = shown.map((s) => byId.get(String(s.postId))).filter(Boolean);
  return {
    posts: await present(ordered, user._id),
    nextCursor: saves.length > size ? encodeCursor(last.createdAt, last._id) : null,
  };
};

export default {
  createDraft,
  uploadPostMedia,
  publishPost,
  editPost,
  deletePost,
  listFeed,
  listOwnPosts,
  getPost,
  likePost,
  unlikePost,
  savePost,
  unsavePost,
  listSavedPosts,
  cleanupAbandonedDrafts,
  publisherOf,
};
