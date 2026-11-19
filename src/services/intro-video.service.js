import mongoose from 'mongoose';

import IntroVideo from '../models/intro-video.model.js';

/**
 * Introductory Videos: the admin reads and writes (paginated, searched and
 * sorted in MongoDB, like the Workout master) and the member list.
 */

export const DEFAULT_PAGE_SIZE = 25;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const iso = (date) => (date ? new Date(date).toISOString() : null);
const toMediaRef = (m) => (m?.url ? { url: m.url, storageKey: m.storageKey ?? null } : null);
const toActor = (user) =>
  user?._id ? { id: String(user._id), name: user.profile?.name ?? null, email: user.profile?.email ?? null } : null;

const AUDIT_POPULATE = [
  { path: 'createdBy', select: 'profile.name profile.email' },
  { path: 'updatedBy', select: 'profile.name profile.email' },
];

const SORTABLE = { position: 'position', title: 'title', createdAt: 'createdAt', updatedAt: 'updatedAt' };

/** The admin's view: every field, media with its storage key, audit people. */
export const toIntroVideoDetail = (doc) => ({
  id: String(doc._id),
  title: doc.title,
  subtitle: doc.subtitle ?? null,
  description: doc.description ?? null,
  whatYoullLearn: Array.isArray(doc.whatYoullLearn) ? doc.whatYoullLearn : [],
  notes: doc.notes ?? null,
  tips: doc.tips ?? null,
  position: doc.position,
  durationSeconds: doc.durationSeconds ?? null,
  video: toMediaRef(doc.video),
  thumbnail: toMediaRef(doc.thumbnail),
  hasVideo: Boolean(doc.video?.url),
  status: doc.status,
  archivedAt: iso(doc.archivedAt),
  archivedBy: toActor(doc.archivedBy),
  createdBy: toActor(doc.createdBy),
  updatedBy: toActor(doc.updatedBy),
  createdAt: iso(doc.createdAt),
  updatedAt: iso(doc.updatedAt),
});

/** What the app shows: the lesson, its video and thumbnail URLs - nothing else. */
export const toMemberIntroVideo = (doc) => ({
  id: String(doc._id),
  title: doc.title,
  subtitle: doc.subtitle ?? null,
  description: doc.description ?? null,
  whatYoullLearn: Array.isArray(doc.whatYoullLearn) ? doc.whatYoullLearn : [],
  notes: doc.notes ?? null,
  tips: doc.tips ?? null,
  position: doc.position,
  durationSeconds: doc.durationSeconds ?? null,
  video: { url: doc.video.url },
  thumbnail: doc.thumbnail?.url ? { url: doc.thumbnail.url } : null,
});

/** One page for the Admin Portal. Default: active ones, lesson order. */
export const listIntroVideos = async (params = {}) => {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  const filter = { status: params.status ?? 'active' };
  const term = String(params.search ?? '').trim();
  if (term) {
    const rx = new RegExp(escapeRegex(term), 'i');
    filter.$or = [{ title: rx }, { subtitle: rx }];
  }
  const sortField = SORTABLE[params.sortKey] ?? 'position';
  const dir = params.sortDir === 'desc' ? -1 : 1;
  const [docs, total] = await Promise.all([
    IntroVideo.find(filter)
      .sort({ [sortField]: dir, createdAt: dir, _id: dir })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate(AUDIT_POPULATE)
      .lean(),
    IntroVideo.countDocuments(filter),
  ]);
  return { rows: docs.map(toIntroVideoDetail), total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
};

export const getIntroVideoById = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await IntroVideo.findById(id)
    .populate([...AUDIT_POPULATE, { path: 'archivedBy', select: 'profile.name profile.email' }])
    .lean();
  return doc ? toIntroVideoDetail(doc) : null;
};

/** A new lesson; without a position it goes after the last active one. */
export const createIntroVideo = async (input, adminId) => {
  let { position } = input;
  if (position === undefined) {
    const last = await IntroVideo.findOne({ status: 'active' }, { position: 1 }).sort({ position: -1 }).lean();
    position = Math.min((last?.position ?? 0) + 1, 999);
  }
  const created = await IntroVideo.create({ ...input, position, createdBy: adminId, updatedBy: adminId });
  return getIntroVideoById(created._id);
};

/** Only the supplied fields change; media and audit fields are untouched. */
export const updateIntroVideo = async (id, patch, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const current = await IntroVideo.findById(id, { status: 1 }).lean();
  if (!current) return null;
  const update = { ...patch, updatedBy: adminId };
  if (patch.status === 'active') {
    update.archivedAt = null;
    update.archivedBy = null;
  } else if (patch.status === 'archived' && current.status !== 'archived') {
    update.archivedAt = new Date();
    update.archivedBy = adminId;
  }
  await IntroVideo.updateOne({ _id: id }, { $set: update }, { runValidators: true });
  return getIntroVideoById(id);
};

/** "Delete" archives, as for workouts: out of the app, reversible. */
export const archiveIntroVideo = async (id, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await IntroVideo.findByIdAndUpdate(
    id,
    { $set: { status: 'archived', archivedAt: new Date(), archivedBy: adminId, updatedBy: adminId } },
    { new: true },
  ).lean();
  return doc ? getIntroVideoById(doc._id) : null;
};

export const restoreIntroVideo = async (id, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await IntroVideo.findByIdAndUpdate(
    id,
    { $set: { status: 'active', archivedAt: null, archivedBy: null, updatedBy: adminId } },
    { new: true },
  ).lean();
  return doc ? getIntroVideoById(doc._id) : null;
};

/** The app's list: active lessons that have a video, in lesson order. */
export const listIntroVideosForMember = async () => {
  const docs = await IntroVideo.find({ status: 'active', 'video.url': { $type: 'string' } })
    .sort({ position: 1, createdAt: 1, _id: 1 })
    .lean();
  return docs.map(toMemberIntroVideo);
};
