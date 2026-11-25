import mongoose from 'mongoose';

import env from '../config/env.js';
import logger from '../config/logger.js';
import User from '../models/user.model.js';
import { MAX_FEATURED_TALKS, TalkAuditLog, TalkEngagement, TalkEvent, TalkVideo } from '../models/talks.models.js';
import { businessDayOf } from '../utils/business-date.js';
import { now } from '../utils/clock.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../utils/errors.js';
import { assertValidImage } from '../utils/image.js';
import { canonicalYouTubeUrl, fetchYouTubeOEmbed, parseYouTubeVideoId } from '../utils/youtube.js';
import { getStorage, talkMediaFolder } from './storage/index.js';

/**
 * TALKS: YouTube videos curated by admins. A talk is a YouTube link plus card
 * metadata; members open the video on YouTube. Metadata comes from YouTube's
 * public oEmbed endpoint (no API key) when the admin adds or refreshes a talk
 * - never when members read the list - and the admin types what oEmbed does
 * not give (description; optionally duration and upload date).
 *
 * Members see a talk only while it is published and has a title.
 */

const talkNotFound = () => notFound(ERROR_CODES.TALK_NOT_FOUND, 'Talk not found');
const iso = (date) => (date ? new Date(date).toISOString() : null);
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Metadata older than this is shown to admins as due a refresh. */
export const METADATA_REFRESH_DAYS = 30;

/** What the app is allowed to see. */
const memberVisible = { status: 'published', title: { $ne: '' } };

const thumbnailOf = (t) => t.customThumbnail?.url ?? t.thumbnailUrl ?? null;

const audit = (adminId, action, talk, previousStatus, newStatus, metadata = null) =>
  TalkAuditLog.create({ adminId, action, talksVideoId: talk._id, previousStatus, newStatus, metadata }).catch((error) =>
    logger.warn(`Talks audit log not written (${action}): ${error.message}`),
  );

const adminNames = async (docs) => {
  const ids = [...new Set(docs.flatMap((d) => [d.createdByAdminId, d.updatedByAdminId]).filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();
  const users = await User.find({ _id: { $in: ids } }, { 'profile.name': 1, 'profile.email': 1 }).lean();
  return new Map(users.map((u) => [String(u._id), { id: String(u._id), name: u.profile?.name ?? null, email: u.profile?.email ?? null }]));
};

const metadataStale = (t) =>
  !t.metadataFetchedAt || now().getTime() - new Date(t.metadataFetchedAt).getTime() > METADATA_REFRESH_DAYS * 86_400_000;

/** The admin's view: everything, counts included. */
const toAdminTalk = (t, names = new Map()) => ({
  id: String(t._id),
  youtubeVideoId: t.youtubeVideoId,
  youtubeUrl: t.youtubeUrl,
  title: t.title,
  titleEdited: Boolean(t.titleEdited),
  description: t.description ?? '',
  thumbnailUrl: thumbnailOf(t),
  youtubeThumbnailUrl: t.thumbnailUrl ?? null,
  customThumbnail: t.customThumbnail?.url ? { url: t.customThumbnail.url } : null,
  channelName: t.channelName ?? null,
  channelUrl: t.channelUrl ?? null,
  durationSeconds: t.durationSeconds ?? null,
  publishedAt: iso(t.publishedAt),
  viewCount: t.viewCount ?? null,
  isFeatured: Boolean(t.isFeatured),
  displayOrder: t.displayOrder,
  status: t.status,
  listedAt: iso(t.listedAt),
  archivedAt: iso(t.archivedAt),
  metadataStatus: t.metadataStatus,
  metadataError: t.metadataError ?? null,
  metadataFetchedAt: iso(t.metadataFetchedAt),
  metadataStale: metadataStale(t),
  counts: { hifi: t.hifiCount ?? 0, saves: t.saveCount ?? 0, opens: t.openCount ?? 0, shares: t.shareCount ?? 0 },
  createdBy: names.get(String(t.createdByAdminId)) ?? null,
  updatedBy: names.get(String(t.updatedByAdminId)) ?? null,
  createdAt: iso(t.createdAt),
  updatedAt: iso(t.updatedAt),
});

const findTalk = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw talkNotFound();
  const talk = await TalkVideo.findById(id).lean();
  if (!talk) throw talkNotFound();
  return talk;
};

export const getAdminTalk = async (id) => {
  const talk = await findTalk(id);
  return toAdminTalk(talk, await adminNames([talk]));
};

// --- YouTube metadata ---------------------------------------------------------

/** The fields an oEmbed result sets (the title only when the admin has not edited it). */
const metadataSet = (result, { keepTitle = false } = {}) => {
  if (result.status !== 'complete') {
    return { metadataStatus: result.status === 'unavailable' ? 'unavailable' : 'pending', metadataError: result.error, metadataFetchedAt: now() };
  }
  const m = result.metadata;
  return {
    ...(keepTitle ? {} : { title: m.title.slice(0, 200) }),
    channelName: m.channelName,
    channelUrl: m.channelUrl,
    thumbnailUrl: m.thumbnailUrl,
    metadataStatus: 'complete',
    metadataError: null,
    metadataFetchedAt: now(),
  };
};

/**
 * POST /admin/talks/preview - what a pasted link resolves to, before saving:
 * the video id, its canonical URL, the oEmbed metadata (or why there is
 * none), and the existing talk when this video is already in Talks.
 */
export const previewYouTubeTalk = async ({ youtubeUrl }) => {
  const youtubeVideoId = parseYouTubeVideoId(youtubeUrl);
  if (!youtubeVideoId) throw invalidUrl();
  const [existing, result] = await Promise.all([
    TalkVideo.findOne({ youtubeVideoId }, { title: 1, status: 1 }).lean(),
    fetchYouTubeOEmbed(youtubeVideoId),
  ]);
  return {
    youtubeVideoId,
    youtubeUrl: canonicalYouTubeUrl(youtubeVideoId),
    metadataStatus: result.status === 'complete' ? 'complete' : result.status === 'unavailable' ? 'unavailable' : 'pending',
    metadata: result.metadata ?? null,
    error: result.error ?? null,
    existing: existing ? { id: String(existing._id), title: existing.title, status: existing.status } : null,
  };
};

const invalidUrl = () =>
  new AppError(400, ERROR_CODES.TALK_INVALID_YOUTUBE_URL, 'Enter a YouTube video link (youtu.be, youtube.com/watch, /shorts or /embed)');

const duplicate = (existing) =>
  new AppError(409, ERROR_CODES.TALK_DUPLICATE, 'This YouTube video is already in Talks', {
    existingId: String(existing._id),
    title: existing.title,
    status: existing.status,
  });

// --- Admin lifecycle ------------------------------------------------------------

const ADMIN_FILTER = {
  all: {},
  draft: { status: 'draft' },
  published: { status: 'published' },
  unpublished: { status: 'unpublished' },
  archived: { status: 'archived' },
  attention: { metadataStatus: { $in: ['pending', 'unavailable'] } },
};

export const listAdminTalks = async ({ status, search, sortKey, sortDir, page, pageSize }) => {
  const filter = { ...ADMIN_FILTER[status] };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ title: rx }, { channelName: rx }, { youtubeVideoId: search.trim() }];
  }
  const dir = sortDir === 'asc' ? 1 : -1;
  const [docs, total] = await Promise.all([
    TalkVideo.find(filter)
      .sort({ [sortKey]: dir, _id: dir })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    TalkVideo.countDocuments(filter),
  ]);
  const names = await adminNames(docs);
  return {
    talks: docs.map((d) => toAdminTalk(d, names)),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
};

/**
 * At most [MAX_FEATURED_TALKS] talks are featured: featuring one more is
 * refused until another is unfeatured. [exceptId]: the talk being edited.
 */
const assertCanFeature = async (exceptId = null) => {
  const featured = await TalkVideo.countDocuments({ isFeatured: true, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (featured >= MAX_FEATURED_TALKS) {
    throw conflict(
      ERROR_CODES.TALK_FEATURED_LIMIT,
      `Up to ${MAX_FEATURED_TALKS} talks can be featured. Unfeature one before featuring this talk.`,
    );
  }
};

const assertPublishable = (talk) => {
  if (!talk.title) {
    throw conflict(ERROR_CODES.TALK_NOT_READY, 'Add a title before publishing - YouTube metadata could not be fetched for this video');
  }
};

/**
 * POST /admin/talks - a talk from a YouTube link. The metadata is fetched
 * here (oEmbed); what the admin typed wins over it. When oEmbed fails the
 * talk is still saved, marked metadata `pending` / `unavailable`, and can be
 * completed by hand. One talk per YouTube video (409 with the existing id).
 */
export const createTalk = async (input, adminId) => {
  const youtubeVideoId = parseYouTubeVideoId(input.youtubeUrl);
  if (!youtubeVideoId) throw invalidUrl();
  const existing = await TalkVideo.findOne({ youtubeVideoId }, { title: 1, status: 1 }).lean();
  if (existing) throw duplicate(existing);

  const fetched = metadataSet(await fetchYouTubeOEmbed(youtubeVideoId));
  const doc = {
    youtubeVideoId,
    youtubeUrl: canonicalYouTubeUrl(youtubeVideoId),
    title: '',
    ...fetched,
    isFeatured: input.isFeatured ?? false,
    displayOrder: input.displayOrder ?? 100,
    description: input.description ?? '',
    durationSeconds: input.durationSeconds ?? null,
    publishedAt: input.publishedAt ?? null,
    createdByAdminId: adminId,
    updatedByAdminId: adminId,
  };
  if (input.title && input.title !== doc.title) Object.assign(doc, { title: input.title, titleEdited: true });
  if (input.channelName) doc.channelName = input.channelName;
  const publish = input.status === 'published';
  if (publish) assertPublishable(doc);
  if (doc.isFeatured) await assertCanFeature();
  Object.assign(doc, publish ? { status: 'published', listedAt: now() } : { status: 'draft' });

  let talk;
  try {
    talk = await TalkVideo.create(doc);
  } catch (error) {
    // Added by someone else between the check and the write.
    if (error?.code === 11000) throw duplicate(await TalkVideo.findOne({ youtubeVideoId }).lean());
    throw error;
  }
  await audit(adminId, 'create', talk, null, talk.status, { youtubeVideoId, metadataStatus: talk.metadataStatus });
  return getAdminTalk(talk._id);
};

/** PUT /admin/talks/:id - only the fields sent change; the video itself never does. */
export const updateTalk = async (id, patch, adminId) => {
  const before = await findTalk(id);
  const set = { ...patch, updatedByAdminId: adminId };
  if (patch.title !== undefined) set.titleEdited = true;
  if (before.status === 'published' && patch.title === '') assertPublishable({ title: '' });
  if (patch.isFeatured === true && !before.isFeatured) await assertCanFeature(before._id);
  await TalkVideo.updateOne({ _id: before._id }, { $set: set }, { runValidators: true });
  await audit(adminId, 'update', before, before.status, before.status, { fields: Object.keys(patch) });
  return getAdminTalk(id);
};

/** POST /admin/talks/:id/refresh-metadata - oEmbed again (an edited title is kept). */
export const refreshTalkMetadata = async (id, adminId) => {
  const talk = await findTalk(id);
  const result = await fetchYouTubeOEmbed(talk.youtubeVideoId);
  const set = metadataSet(result, { keepTitle: talk.titleEdited });
  if (result.status !== 'complete') {
    // Keep what was there; only the status and error change.
    await TalkVideo.updateOne({ _id: talk._id }, { $set: { metadataStatus: set.metadataStatus, metadataError: set.metadataError, metadataFetchedAt: set.metadataFetchedAt, updatedByAdminId: adminId } });
  } else {
    await TalkVideo.updateOne({ _id: talk._id }, { $set: { ...set, updatedByAdminId: adminId } });
  }
  await audit(adminId, 'refresh_metadata', talk, talk.status, talk.status, { result: result.status, error: result.error ?? null });
  return getAdminTalk(id);
};

const transition = async (talk, next, adminId, action, set = {}) => {
  await TalkVideo.updateOne({ _id: talk._id }, { $set: { status: next, updatedByAdminId: adminId, ...set } });
  await audit(adminId, action, talk, talk.status, next);
  return getAdminTalk(talk._id);
};

export const publishTalk = async (id, adminId) => {
  const talk = await findTalk(id);
  if (talk.status === 'archived') throw conflict(ERROR_CODES.TALK_NOT_READY, 'Restore this talk before publishing it');
  if (talk.status === 'published') return getAdminTalk(id);
  assertPublishable(talk);
  return transition(talk, 'published', adminId, 'publish', { listedAt: talk.listedAt ?? now() });
};

export const unpublishTalk = async (id, adminId) => {
  const talk = await findTalk(id);
  if (talk.status !== 'published') throw conflict(ERROR_CODES.TALK_NOT_READY, 'Only a published talk can be unpublished');
  return transition(talk, 'unpublished', adminId, 'unpublish');
};

export const archiveTalk = async (id, adminId) => {
  const talk = await findTalk(id);
  if (talk.status === 'archived') return getAdminTalk(id);
  // An archived talk leaves the carousel too, freeing its featured place.
  return transition(talk, 'archived', adminId, 'archive', { statusBeforeArchive: talk.status, archivedAt: now(), isFeatured: false });
};

/** Back to where it was - except a talk that was live comes back unpublished, never straight onto the app. */
export const restoreTalk = async (id, adminId) => {
  const talk = await findTalk(id);
  if (talk.status !== 'archived') return getAdminTalk(id);
  const back = talk.statusBeforeArchive === 'published' ? 'unpublished' : (talk.statusBeforeArchive ?? 'draft');
  return transition(talk, back, adminId, 'restore', { statusBeforeArchive: null, archivedAt: null });
};

const removeStored = async (m) => {
  if (!m?.url) return;
  await getStorage()
    .remove(m.url)
    .catch((error) => logger.warn(`Could not remove a Talks file: ${error.message}`));
};

/** Deletes a talk for good (its engagement and events too). A published talk is refused. The audit trail is kept. */
export const deleteTalk = async (id, adminId) => {
  const talk = await findTalk(id);
  if (talk.status === 'published') throw conflict(ERROR_CODES.TALK_PUBLISHED, 'Unpublish this talk before deleting it');
  await TalkVideo.deleteOne({ _id: talk._id });
  await Promise.all([TalkEngagement.deleteMany({ talksVideoId: talk._id }), TalkEvent.deleteMany({ talksVideoId: talk._id })]);
  await removeStored(talk.customThumbnail);
  await audit(adminId, 'delete', talk, talk.status, null, { title: talk.title, youtubeVideoId: talk.youtubeVideoId });
  return { id: String(talk._id), deleted: true };
};

/** PUT /admin/talks/:id/thumbnail - the admin's own thumbnail (raw image bytes). */
export const setTalkThumbnail = async (id, buffer, adminId) => {
  const talk = await findTalk(id);
  const type = assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes });
  const storage = getStorage();
  const url = await storage.save(buffer, { folder: talkMediaFolder(talk._id, 'thumbnail'), extension: type.extension });
  await TalkVideo.updateOne({ _id: talk._id }, { $set: { customThumbnail: { url, storageKey: storage.keyFor(url) }, updatedByAdminId: adminId } });
  if (talk.customThumbnail?.url && talk.customThumbnail.url !== url) await removeStored(talk.customThumbnail);
  await audit(adminId, 'thumbnail', talk, talk.status, talk.status);
  return getAdminTalk(id);
};

/** DELETE /admin/talks/:id/thumbnail - back to YouTube's thumbnail. */
export const removeTalkThumbnail = async (id, adminId) => {
  const talk = await findTalk(id);
  await TalkVideo.updateOne({ _id: talk._id }, { $set: { customThumbnail: null, updatedByAdminId: adminId } });
  await removeStored(talk.customThumbnail);
  return getAdminTalk(id);
};

/** GET /admin/talks/stats */
export const talksStats = async () => {
  const [rows] = await TalkVideo.aggregate([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        published: { $sum: { $cond: [{ $eq: ['$status', 'published'] }, 1, 0] } },
        draft: { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
        unpublished: { $sum: { $cond: [{ $eq: ['$status', 'unpublished'] }, 1, 0] } },
        archived: { $sum: { $cond: [{ $eq: ['$status', 'archived'] }, 1, 0] } },
        attention: { $sum: { $cond: [{ $in: ['$metadataStatus', ['pending', 'unavailable']] }, 1, 0] } },
        hifi: { $sum: '$hifiCount' },
        saves: { $sum: '$saveCount' },
        opens: { $sum: '$openCount' },
        shares: { $sum: '$shareCount' },
      },
    },
  ]);
  const s = rows ?? {};
  return Object.fromEntries(
    ['total', 'published', 'draft', 'unpublished', 'archived', 'attention', 'hifi', 'saves', 'opens', 'shares'].map((k) => [k, s[k] ?? 0]),
  );
};

/**
 * Refreshes the oEmbed metadata of talks fetched more than [olderThanDays]
 * ago (or never) - the job behind `node scripts/talks-youtube.js refresh`.
 * Members' reads never call YouTube.
 */
export const refreshStaleTalkMetadata = async ({ olderThanDays = METADATA_REFRESH_DAYS, adminId = null } = {}) => {
  const cutoff = new Date(now().getTime() - olderThanDays * 86_400_000);
  const due = await TalkVideo.find(
    { status: { $ne: 'archived' }, $or: [{ metadataFetchedAt: null }, { metadataFetchedAt: { $lt: cutoff } }] },
    { _id: 1 },
  ).lean();
  const results = [];
  for (const t of due) {
    const talk = await refreshTalkMetadata(t._id, adminId);
    results.push({ id: talk.id, youtubeVideoId: talk.youtubeVideoId, metadataStatus: talk.metadataStatus });
  }
  return results;
};

// --- Member reads -----------------------------------------------------------

const toMemberTalk = (t, engagement) => ({
  id: String(t._id),
  youtubeVideoId: t.youtubeVideoId,
  youtubeUrl: t.youtubeUrl,
  title: t.title,
  description: t.description ?? '',
  thumbnailUrl: thumbnailOf(t),
  channelName: t.channelName ?? null,
  durationSeconds: t.durationSeconds ?? null,
  publishedAt: iso(t.publishedAt),
  viewCount: t.viewCount ?? null,
  isFeatured: Boolean(t.isFeatured),
  hifiCount: t.hifiCount ?? 0,
  hifi: Boolean(engagement?.hifi),
  saved: Boolean(engagement?.saved),
});

const engagementsFor = async (userId, ids) => {
  if (ids.length === 0) return new Map();
  const rows = await TalkEngagement.find({ userId, talksVideoId: { $in: ids } }).lean();
  return new Map(rows.map((r) => [String(r.talksVideoId), r]));
};

const MEMBER_ORDER = { displayOrder: 1, listedAt: -1, _id: -1 };

/** GET /talks - published talks, in display order. */
export const listMemberTalks = async (user, { page, pageSize }) => {
  const filter = memberVisible;
  const [docs, total] = await Promise.all([
    TalkVideo.find(filter).sort(MEMBER_ORDER).skip((page - 1) * pageSize).limit(pageSize).lean(),
    TalkVideo.countDocuments(filter),
  ]);
  const mine = await engagementsFor(user._id, docs.map((d) => d._id));
  return {
    talks: docs.map((d) => toMemberTalk(d, mine.get(String(d._id)))),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
};

/** GET /talks/featured - the featured published talks (at most 3), in the admin's display order. */
export const listFeaturedTalks = async (user) => {
  const docs = await TalkVideo.find({ ...memberVisible, isFeatured: true }).sort(MEMBER_ORDER).limit(MAX_FEATURED_TALKS).lean();
  const mine = await engagementsFor(user._id, docs.map((d) => d._id));
  return docs.map((d) => toMemberTalk(d, mine.get(String(d._id))));
};

const visibleTalk = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw talkNotFound();
  const talk = await TalkVideo.findOne({ _id: id, ...memberVisible }).lean();
  if (!talk) throw talkNotFound();
  return talk;
};

export const getMemberTalk = async (user, id) => {
  const talk = await visibleTalk(id);
  const mine = await TalkEngagement.findOne({ talksVideoId: talk._id, userId: user._id }).lean();
  return toMemberTalk(talk, mine);
};

/** GET /talks/saved - the caller's saved talks still on the app, most recently saved first. */
export const listSavedTalks = async (user, { page, pageSize }) => {
  const saved = await TalkEngagement.find({ userId: user._id, saved: true }, { talksVideoId: 1, savedAt: 1 })
    .sort({ savedAt: -1, _id: -1 })
    .lean();
  const visible = await TalkVideo.find({ _id: { $in: saved.map((s) => s.talksVideoId) }, ...memberVisible }).lean();
  const byId = new Map(visible.map((t) => [String(t._id), t]));
  const ordered = saved.map((s) => byId.get(String(s.talksVideoId))).filter(Boolean);
  const pageItems = ordered.slice((page - 1) * pageSize, page * pageSize);
  const mine = await engagementsFor(user._id, pageItems.map((t) => t._id));
  return {
    talks: pageItems.map((t) => toMemberTalk(t, mine.get(String(t._id)))),
    pagination: { page, pageSize, total: ordered.length, totalPages: Math.max(1, Math.ceil(ordered.length / pageSize)) },
  };
};

// --- Engagement ---------------------------------------------------------------

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

/**
 * Sets the caller's [flag] ('hifi' | 'saved') on a visible talk to [on],
 * moving the talk's count only when the flag really changed - so repeats,
 * retries and double taps never count twice and a count never goes below 0.
 */
const setFlag = async (user, id, flag, on) => {
  const talk = await visibleTalk(id);
  const counter = flag === 'hifi' ? 'hifiCount' : 'saveCount';
  const at = flag === 'hifi' ? 'hifiAt' : 'savedAt';
  await atomically(async (session) => {
    const result = on
      ? await TalkEngagement.updateOne(
          { talksVideoId: talk._id, userId: user._id, [flag]: { $ne: true } },
          { $set: { [flag]: true, [at]: now() } },
          { upsert: true, session },
        )
      : await TalkEngagement.updateOne(
          { talksVideoId: talk._id, userId: user._id, [flag]: true },
          { $set: { [flag]: false, [at]: null } },
          { session },
        );
    const changed = (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0) === 1;
    if (!changed) return;
    await TalkVideo.updateOne(
      on ? { _id: talk._id } : { _id: talk._id, [counter]: { $gt: 0 } },
      { $inc: { [counter]: on ? 1 : -1 } },
      { session },
    );
  });
  return getMemberTalk(user, talk._id);
};

export const hifiTalk = (user, id) => setFlag(user, id, 'hifi', true);
export const unhifiTalk = (user, id) => setFlag(user, id, 'hifi', false);
export const saveTalk = (user, id) => setFlag(user, id, 'saved', true);
export const unsaveTalk = (user, id) => setFlag(user, id, 'saved', false);

const EVENT_COUNTER = { open: 'openCount', share: 'shareCount' };

/** POST /talks/:id/events - an open (sent to YouTube) or a share, counted once per account, talk and business day. */
export const recordTalkEvent = async (user, id, { kind }) => {
  const talk = await visibleTalk(id);
  const day = businessDayOf(now());
  let counted = false;
  try {
    const result = await TalkEvent.updateOne(
      { talksVideoId: talk._id, userId: user._id, kind, day },
      { $setOnInsert: { createdAt: now() } },
      { upsert: true },
    );
    counted = result.upsertedCount === 1;
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  if (counted) await TalkVideo.updateOne({ _id: talk._id }, { $inc: { [EVENT_COUNTER[kind]]: 1 } });
  return { id: String(talk._id), kind, counted };
};
