import mongoose from 'mongoose';

import Workout, { WORKOUT_TYPES } from '../models/workout.model.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * The Workout master: reads and writes for the admin Workout screens.
 *
 * Everything is paginated, filtered and sorted in MongoDB. The legacy list sent
 * all 188 rows to the browser and paged them there; this does not.
 *
 * A migrated workout and one added in the portal are the same kind of document.
 * The `legacy` block is exposed as read-only metadata and never written here.
 */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Sort keys the portal may request, mapped to real document paths. */
const SORTABLE = {
  name: 'name',
  type: 'type',
  equipment: 'equipment',
  level: 'level',
  primaryMuscle: 'primaryMuscle',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  legacyWorkoutId: 'legacy.workoutId',
};

export const SORT_KEYS = Object.keys(SORTABLE);

const iso = (date) => (date ? new Date(date).toISOString() : null);

const toMediaRef = (media) => (media?.url ? { url: media.url, storageKey: media.storageKey ?? null } : null);

/** An admin reference, resolved for display. Null when the lookup found nobody. */
const toActor = (user) =>
  user ? { id: String(user._id), name: user.profile?.name ?? null, email: user.profile?.email ?? null } : null;

/** Allow-listed list row: what the Workout table shows, and nothing more. */
export const toWorkoutRow = (doc) => ({
  id: String(doc._id),
  name: doc.name ?? null,
  type: doc.type ?? null,
  equipment: doc.equipment ?? null,
  primaryMuscle: doc.primaryMuscle ?? null,
  secondaryMuscle: doc.secondaryMuscle ?? null,
  level: doc.level ?? null,
  thumbnail: toMediaRef(doc.thumbnail),
  hasVideo: Boolean(doc.video?.url),
  youtubeUrl: doc.youtubeUrl ?? null,
  status: doc.status ?? null,
  legacyWorkoutId: doc.legacy?.workoutId ?? null,
  createdBy: toActor(doc.createdBy),
  updatedBy: toActor(doc.updatedBy),
  createdAt: iso(doc.createdAt),
  updatedAt: iso(doc.updatedAt),
});

/** Full workout for the detail / edit screen. */
export const toWorkoutDetail = (doc) => ({
  ...toWorkoutRow(doc),
  description: doc.description ?? null,
  video: toMediaRef(doc.video),
  archivedAt: iso(doc.archivedAt),
  archivedBy: toActor(doc.archivedBy),
  legacy: doc.legacy?.workoutId != null ? { source: doc.legacy.source ?? null, workoutId: doc.legacy.workoutId } : null,
  migration: doc.migration?.runId
    ? { runId: doc.migration.runId, migratedAt: iso(doc.migration.migratedAt), version: doc.migration.version ?? null }
    : null,
});

/** The audit references the list and detail resolve for display. */
const AUDIT_POPULATE = [
  { path: 'createdBy', select: 'profile.name profile.email' },
  { path: 'updatedBy', select: 'profile.name profile.email' },
];

export const buildWorkoutFilter = ({ search, type, equipment, level, status } = {}) => {
  // Archived workouts stay out of the default list; plans still resolve them by id.
  const filter = { status: status ?? 'active' };
  if (type) filter.type = type;
  if (equipment) filter.equipment = equipment;
  if (level) filter.level = Number(level);

  const term = String(search ?? '').trim();
  if (term !== '') {
    // The legacy list filtered on name, type, equipment and primary muscle; the
    // same fields, matched in MongoDB across the whole collection.
    const pattern = new RegExp(escapeRegex(term), 'i');
    filter.$or = [{ name: pattern }, { primaryMuscle: pattern }, { secondaryMuscle: pattern }];
  }
  return filter;
};

/** One page of workouts. Always paginated and capped. Default order is name A-Z. */
export const listWorkouts = async (params = {}) => {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);

  const sortField = SORTABLE[params.sortKey] ?? SORTABLE.name;
  const sortDir = params.sortDir === 'desc' ? -1 : 1;

  const filter = buildWorkoutFilter(params);
  const [docs, total] = await Promise.all([
    Workout.find(filter)
      // _id breaks ties so paging is stable where the sort field repeats.
      .sort({ [sortField]: sortDir, _id: sortDir })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate(AUDIT_POPULATE)
      .lean(),
    Workout.countDocuments(filter),
  ]);

  return {
    rows: docs.map(toWorkoutRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

export const getWorkoutById = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await Workout.findById(id)
    .populate([...AUDIT_POPULATE, { path: 'archivedBy', select: 'profile.name profile.email' }])
    .lean();
  return doc ? toWorkoutDetail(doc) : null;
};

/**
 * A new workout. It gets no legacy block: only a migrated workout has one, and
 * inventing one would disguise a portal workout as legacy data.
 */
export const createWorkout = async (input, adminId) => {
  const created = await Workout.create({
    name: input.name,
    type: input.type,
    equipment: input.equipment,
    primaryMuscle: input.primaryMuscle,
    secondaryMuscle: input.secondaryMuscle ?? null,
    level: input.level,
    description: input.description,
    youtubeUrl: input.youtubeUrl ?? null,
    status: input.status ?? 'active',
    createdBy: adminId,
    updatedBy: adminId,
  });
  return getWorkoutById(created._id);
};

/**
 * Controlled update: each supplied field is $set by its own path, so `legacy`,
 * `migration`, `createdAt`, `createdBy` and the media references survive
 * untouched. Media has its own endpoints and is never part of this body - which
 * is also the legacy rule: a text-only edit left both files alone.
 */
export const updateWorkout = async (id, patch, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const current = await Workout.findById(id).lean();
  if (!current) return null;

  const update = { updatedBy: adminId };
  for (const key of [
    'name',
    'type',
    'equipment',
    'primaryMuscle',
    'secondaryMuscle',
    'level',
    'description',
    'youtubeUrl',
  ]) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }

  if (patch.status !== undefined) {
    update.status = patch.status;
    if (patch.status === 'active') {
      update.archivedAt = null;
      update.archivedBy = null;
    } else if (current.status !== 'archived') {
      update.archivedAt = new Date();
      update.archivedBy = adminId;
    }
  }

  const doc = await Workout.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true }).lean();
  return doc ? getWorkoutById(doc._id) : null;
};

/**
 * "Delete" archives. 175 of the 188 migrated workouts are referenced by legacy
 * workout plans, and future plans will reference them by _id - removing the
 * document would orphan that history. Reversible with { status: "active" }.
 */
export const archiveWorkout = async (id, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await Workout.findByIdAndUpdate(
    id,
    { $set: { status: 'archived', archivedAt: new Date(), archivedBy: adminId, updatedBy: adminId } },
    { new: true },
  ).lean();
  return doc ? getWorkoutById(doc._id) : null;
};

export const restoreWorkout = async (id, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await Workout.findByIdAndUpdate(
    id,
    { $set: { status: 'active', archivedAt: null, archivedBy: null, updatedBy: adminId } },
    { new: true },
  ).lean();
  return doc ? getWorkoutById(doc._id) : null;
};

/**
 * The coach's workout picker (Create Workout Plan → Add to Block): the
 * active workouts, name A-Z, a page at a time - optionally narrowed by
 * [search] (name, primary and secondary muscle - the admin list's own match,
 * escaped, any case) and by [type] (one of WORKOUT_TYPES, the schema's only
 * category). Only what the picker shows: no audit people, no legacy or
 * migration data. `types` is the schema's category list, for its filters.
 * Read-only.
 */
const COACH_PAGE_SIZE = 30;
const COACH_MAX_PAGE_SIZE = 50;
const COACH_MAX_SEARCH = 100;

const toCoachWorkout = (doc) => ({
  id: String(doc._id),
  name: doc.name ?? null,
  type: doc.type ?? null,
  equipment: doc.equipment ?? null,
  primaryMuscle: doc.primaryMuscle ?? null,
  secondaryMuscle: doc.secondaryMuscle ?? null,
  level: doc.level ?? null,
  description: doc.description ?? null,
  thumbnail: doc.thumbnail?.url ? { url: doc.thumbnail.url } : null,
  hasVideo: Boolean(doc.video?.url),
  /** The uploaded .mp4 (served from /uploads, range requests supported) - what the coach app plays. */
  video: doc.video?.url ? { url: doc.video.url } : null,
});

export const listWorkoutsForCoach = async ({ search, type, page, pageSize } = {}) => {
  const positive = (value, fallback, label) => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw badRequest(ERROR_CODES.VALIDATION_ERROR, `${label} must be a positive integer`);
    return n;
  };
  const pageNo = positive(page, 1, 'page');
  const size = Math.min(positive(pageSize, COACH_PAGE_SIZE, 'pageSize'), COACH_MAX_PAGE_SIZE);
  if (type !== undefined && !WORKOUT_TYPES.includes(type)) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `type must be one of ${WORKOUT_TYPES.join(', ')}`);
  }
  const term = typeof search === 'string' ? search.trim() : '';
  if (term.length > COACH_MAX_SEARCH) throw badRequest(ERROR_CODES.VALIDATION_ERROR, `search must be at most ${COACH_MAX_SEARCH} characters`);

  // Active only, whatever is asked: archived workouts are not offered.
  const filter = buildWorkoutFilter({ search: term, type, status: 'active' });
  const [docs, total] = await Promise.all([
    Workout.find(filter, { name: 1, type: 1, equipment: 1, primaryMuscle: 1, secondaryMuscle: 1, level: 1, description: 1, thumbnail: 1, video: 1 })
      .sort({ name: 1, _id: 1 })
      .skip((pageNo - 1) * size)
      .limit(size)
      .lean(),
    Workout.countDocuments(filter),
  ]);
  return {
    items: docs.map(toCoachWorkout),
    types: WORKOUT_TYPES,
    pagination: { page: pageNo, pageSize: size, total, hasMore: pageNo * size < total },
  };
};

