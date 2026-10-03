import mongoose from 'mongoose';

import env from '../config/env.js';
import logger from '../config/logger.js';
import BodyMetrics from '../models/body-metrics.model.js';
import Coach from '../models/coach.model.js';
import EnrolledClient from '../models/enrolled-client.model.js';
import User from '../models/user.model.js';
import {
  BODY_MEASUREMENTS,
  BODY_MEASUREMENT_KEYS,
  BODY_METRICS_SCHEMA_VERSION,
  REQUIRED_PHOTO_SLOTS,
  VIDEO_SLOT,
} from '../constants/body-metrics-definition.js';
import { assertValidImage } from '../utils/image.js';
import { assertValidVideo } from '../utils/video.js';
import { ERROR_CODES, AppError, conflict, notFound } from '../utils/errors.js';
import { validateBodyMetricsSave, validateMediaSlot } from '../validators/body-metrics.validator.js';
import { bodyMetricsMediaFolder, getStorage } from './storage/index.js';

/**
 * A member's Body Metrics, one per enrollment - the questionnaire's model:
 *
 *   authenticated JWT user -> owns this EnrolledClient -> the enrollment names
 *   the coach -> the Body Metrics belong to that enrollment
 *
 * userId is always the token's subject and coachId is read off the enrollment;
 * neither is ever taken from a request. An enrollment that is not the caller's
 * is indistinguishable from one that does not exist.
 *
 * Unlike the questionnaire, a SUBMITTED record is final: every later write
 * (values or media) is refused with 409, so nothing - an autosave included -
 * can turn it back into a draft or change what the coach reads.
 */

const iso = (date) => (date ? new Date(date).toISOString() : null);
const idOf = (value) => (value ? String(value._id ?? value) : null);
const isObject = (value) => value && typeof value === 'object' && !(value instanceof mongoose.Types.ObjectId);
const mediaRef = (media) => (media?.url ? { url: media.url, storageKey: media.storageKey } : null);

const POPULATE = [
  { path: 'enrollmentId', select: 'planId enrollDate startDate endDate isDeleted', populate: { path: 'planId', select: 'name planType durationWeeks' } },
  { path: 'coachId', select: 'profile.level userId', populate: { path: 'userId', select: 'profile.name' } },
];

/** One Body Metrics record as every reader (member, coach, admin) sees it. */
export const toBodyMetrics = (doc) => {
  const enrollment = isObject(doc.enrollmentId) ? doc.enrollmentId : null;
  const plan = isObject(enrollment?.planId) ? enrollment.planId : null;
  const coach = isObject(doc.coachId) ? doc.coachId : null;
  const coachUser = isObject(coach?.userId) ? coach.userId : null;

  return {
    bodyMetricsId: String(doc._id),
    enrollmentId: idOf(doc.enrollmentId),
    coachId: idOf(doc.coachId),
    schemaVersion: doc.schemaVersion,
    status: doc.status,
    submittedAt: iso(doc.submittedAt),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
    gender: doc.gender ?? null,
    measurements: Object.fromEntries(BODY_MEASUREMENT_KEYS.map((key) => [key, doc[key] ?? null])),
    media: {
      front: mediaRef(doc.front),
      side: mediaRef(doc.side),
      back: mediaRef(doc.back),
      video: mediaRef(doc.video),
    },
    ...(enrollment
      ? { enrollment: { id: String(enrollment._id), enrollDate: iso(enrollment.enrollDate), startDate: iso(enrollment.startDate), endDate: iso(enrollment.endDate) } }
      : {}),
    ...(plan ? { plan: { id: String(plan._id), name: plan.name ?? null, planType: plan.planType ?? null, durationWeeks: plan.durationWeeks ?? null } } : {}),
    ...(coach ? { coach: { id: String(coach._id), name: coachUser?.profile?.name ?? null, level: coach.profile?.level ?? null } } : {}),
  };
};

/** The caller's own, non-deleted enrollment - checked in the query itself - or a 404. */
const findOwnedEnrollment = async (userId, enrollmentId) => {
  if (!mongoose.isValidObjectId(enrollmentId)) throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrollment not found');
  const enrollment = await EnrolledClient.findOne({ _id: enrollmentId, userId, isDeleted: { $ne: true } }).lean();
  if (!enrollment) throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrollment not found');
  return enrollment;
};

/**
 * The member's gender as their user profile holds it, copied onto the record
 * at save time. Null for an account that has not given one - the report then
 * shows no gender rather than guessing one.
 */
const genderOf = async (userId) => {
  const user = await User.findById(userId, { 'profile.gender': 1 }).lean();
  return user?.profile?.gender ?? null;
};

const alreadySubmitted = () =>
  conflict(ERROR_CODES.BODY_METRICS_ALREADY_SUBMITTED, 'Body Metrics for this enrollment have already been submitted');

const isDuplicateKey = (error) => error?.code === 11000;

/** Every write targets the enrollment's record only while it is still a draft. */
const draftFilter = (userId, enrollmentId) => ({ userId, enrollmentId, status: { $ne: 'submitted' } });

/** What a submission is still missing: measurements and required photos. */
const missingForSubmission = (doc) => [
  ...BODY_MEASUREMENTS.filter((m) => doc[m.key] === null || doc[m.key] === undefined).map((m) => m.key),
  ...REQUIRED_PHOTO_SLOTS.filter((slot) => !doc[slot]?.url),
];

/** GET - the Body Metrics of one of the caller's enrollments (draft or submitted). */
export const getMemberBodyMetrics = async (userId, enrollmentId) => {
  await findOwnedEnrollment(userId, enrollmentId);
  const doc = await BodyMetrics.findOne({ userId, enrollmentId }).lean();
  if (!doc) throw notFound(ERROR_CODES.BODY_METRICS_NOT_FOUND, 'No Body Metrics have been started for this enrollment');
  return toBodyMetrics(doc);
};

/**
 * POST - creates the enrollment's Body Metrics or updates the draft.
 *
 * Measurements are MERGED (a draft can be saved field by field; null clears
 * one). `status: "submitted"` is accepted only when all 11 measurements and the
 * three photos are on the record; submittedAt is stamped then. A submitted
 * record refuses every write.
 */
export const saveMemberBodyMetrics = async (userId, enrollmentId, body) => {
  const enrollment = await findOwnedEnrollment(userId, enrollmentId);
  const { measurements, status } = validateBodyMetricsSave(body);

  const existing = await BodyMetrics.findOne({ userId, enrollmentId }).lean();
  if (existing?.status === 'submitted') throw alreadySubmitted();

  const merged = { ...(existing ?? {}), ...measurements };
  const set = {
    ...measurements,
    coachId: enrollment.coachId ?? null,
    // Read off the user document, never from the body: the record carries the
    // member's own gender, and it stays current until they submit.
    gender: await genderOf(userId),
    schemaVersion: BODY_METRICS_SCHEMA_VERSION,
  };

  if (status === 'submitted') {
    const missing = missingForSubmission(merged);
    if (missing.length) {
      throw new AppError(400, ERROR_CODES.BODY_METRICS_INCOMPLETE, `Body Metrics are incomplete: ${missing.join(', ')}`, { missing });
    }
    set.status = 'submitted';
    set.submittedAt = new Date();
  }

  try {
    const doc = await BodyMetrics.findOneAndUpdate(
      draftFilter(userId, enrollmentId),
      { $set: set, $setOnInsert: { userId, enrollmentId } },
      { returnDocument: 'after', upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
    return { bodyMetrics: toBodyMetrics(doc), created: !existing };
  } catch (error) {
    // Submitted between the read and the write: the filter no longer matched
    // and the insert hit the one-per-enrollment index.
    if (isDuplicateKey(error)) throw alreadySubmitted();
    throw error;
  }
};

const discard = async (media) => {
  if (!media?.url) return;
  await getStorage()
    .remove(media.url)
    .catch((error) => logger.warn(`Could not remove a Body Metrics file: ${error.message}`));
};

/**
 * PUT media - stores one photo (front/side/back) or the video in the draft.
 * Validated by its bytes; the file it replaces is removed only after the
 * record points at the new one.
 */
export const setMemberBodyMetricsMedia = async (userId, enrollmentId, slot, buffer) => {
  validateMediaSlot(slot);
  const enrollment = await findOwnedEnrollment(userId, enrollmentId);
  const existing = await BodyMetrics.findOne({ userId, enrollmentId }, { status: 1 }).lean();
  if (existing?.status === 'submitted') throw alreadySubmitted();

  const type =
    slot === VIDEO_SLOT
      ? assertValidVideo(buffer, { maxBytes: env.storage.maxVideoUploadBytes })
      : assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes });

  const storage = getStorage();
  const url = await storage.save(buffer, { folder: bodyMetricsMediaFolder(enrollment._id, slot), extension: type.extension });
  const media = { url, storageKey: storage.keyFor(url) };

  let before;
  try {
    before = await BodyMetrics.findOneAndUpdate(
      draftFilter(userId, enrollmentId),
      {
        $set: { [slot]: media, coachId: enrollment.coachId ?? null },
        $setOnInsert: { userId, enrollmentId, schemaVersion: BODY_METRICS_SCHEMA_VERSION },
      },
      { returnDocument: 'before', upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
  } catch (error) {
    await discard(media);
    if (isDuplicateKey(error)) throw alreadySubmitted();
    throw error;
  }
  // Re-uploading the identical file yields the same content-hashed URL: keep it.
  if (before?.[slot]?.url && before[slot].url !== url) await discard(before[slot]);

  return { bodyMetrics: toBodyMetrics(await BodyMetrics.findOne({ userId, enrollmentId }).lean()) };
};

/** DELETE media - clears one slot of the draft, then removes its file. */
export const removeMemberBodyMetricsMedia = async (userId, enrollmentId, slot) => {
  validateMediaSlot(slot);
  await findOwnedEnrollment(userId, enrollmentId);
  const existing = await BodyMetrics.findOne({ userId, enrollmentId }).lean();
  if (!existing) throw notFound(ERROR_CODES.BODY_METRICS_NOT_FOUND, 'No Body Metrics have been started for this enrollment');
  if (existing.status === 'submitted') throw alreadySubmitted();

  const before = await BodyMetrics.findOneAndUpdate(draftFilter(userId, enrollmentId), { $set: { [slot]: null } }, { returnDocument: 'before' }).lean();
  if (!before) throw alreadySubmitted();
  await discard(before[slot]);
  return { bodyMetrics: toBodyMetrics(await BodyMetrics.findOne({ userId, enrollmentId }).lean()) };
};

/** Submitted (or all) records newest submission first, deleted enrollments left out. */
const listFor = async (query) => {
  const docs = await BodyMetrics.find(query).sort({ submittedAt: -1, createdAt: -1, _id: -1 }).populate(POPULATE).lean();
  const rows = docs.filter((doc) => !(isObject(doc.enrollmentId) && doc.enrollmentId.isDeleted)).map(toBodyMetrics);
  return { bodyMetrics: rows, total: rows.length };
};

/** GET /users/me/body-metrics - the member's own history. Scoped by the token's subject. */
export const listMemberBodyMetrics = (userId, { status } = {}) => listFor({ userId, ...(status ? { status } : {}) });

/**
 * Coach read: the SUBMITTED Body Metrics of one enrollment the signed-in coach
 * owns, or null. Another coach's (or a deleted / unknown) enrollment is a 404.
 */
export const getSubmittedBodyMetricsForCoach = async (coachUserId, enrollmentId) => {
  const coach = await Coach.findOne({ userId: coachUserId }, { _id: 1 }).lean();
  if (!coach) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'You do not have a coach profile');
  if (!mongoose.isValidObjectId(enrollmentId)) throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrollment not found');

  const enrollment = await EnrolledClient.findOne(
    { _id: enrollmentId, coachId: coach._id, isDeleted: { $ne: true } },
    { _id: 1, userId: 1 },
  ).lean();
  if (!enrollment) throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrollment not found');

  const doc = await BodyMetrics.findOne({ enrollmentId: enrollment._id, userId: enrollment.userId, status: 'submitted' })
    .populate(POPULATE)
    .lean();
  return doc ? toBodyMetrics(doc) : null;
};

/** Admin read: one member's SUBMITTED Body Metrics, one per enrollment, newest first. */
export const listBodyMetricsForAdmin = async (userId) => {
  if (!mongoose.isValidObjectId(userId) || !(await User.exists({ _id: userId }))) {
    throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  }
  return listFor({ userId, status: 'submitted' });
};


export default {
  toBodyMetrics,
  getMemberBodyMetrics,
  saveMemberBodyMetrics,
  setMemberBodyMetricsMedia,
  removeMemberBodyMetricsMedia,
  listMemberBodyMetrics,
  getSubmittedBodyMetricsForCoach,
  listBodyMetricsForAdmin,
};
