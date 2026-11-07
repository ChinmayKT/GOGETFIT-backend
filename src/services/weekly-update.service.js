import mongoose from 'mongoose';

import env from '../config/env.js';
import logger from '../config/logger.js';
import {
  WEEKLY_MEASUREMENT_KEYS,
  WEEKLY_MEDIA_FIELDS,
  WEEKLY_REQUIRED_PHOTO_SLOTS,
  WEEKLY_VIDEO_SLOT,
} from '../constants/weekly-update-definition.js';
import Coach from '../models/coach.model.js';
import EnrolledClient from '../models/enrolled-client.model.js';
import User from '../models/user.model.js';
import WeeklyUpdate from '../models/weekly-update.model.js';
import { businessDayOf } from '../utils/business-date.js';
import { ERROR_CODES, AppError, badRequest, notFound } from '../utils/errors.js';
import { assertValidImage } from '../utils/image.js';
import { assertValidVideo } from '../utils/video.js';
import {
  validateReportDate,
  validateWeeklyMediaSlot,
  validateWeeklyUpdateSubmission,
} from '../validators/weekly-update.validator.js';
import { profileSnapshot } from './daily-update.service.js';
import { clientOfCoachEnrollment } from './diet-plan.service.js';
import { listMemberEnrollments } from './member-enrollment.service.js';
import { getStorage, weeklyUpdateMediaFolder } from './storage/index.js';

/**
 * Weekly Updates: a member's measurements and progress photos, by report date.
 * (For now - while testing - a member may submit several on one day.)
 *
 *   authenticated JWT user -> their enrollment (the active one, else the latest
 *   purchase - the questionnaire / Body Metrics rule) -> coach and plan
 *
 * Nothing about ownership comes from a request. The report date is today's
 * business day (Asia/Kolkata): the app names it, and the server refuses any
 * other day for a write (another day is read-only).
 *
 * Photos are uploaded first, into the day's draft; the submit then checks the
 * three required photos are there, validates the nine measurements, snapshots
 * the member's gender / age / height and makes the record final - all in one
 * conditional write, so a double tap or a retry never makes two.
 */

const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 50;

const iso = (date) => (date ? new Date(date).toISOString() : null);
const id = (value) => (value ? String(value) : null);
// The storage key stays in the database for file management; readers only need the URL.
const mediaView = (media) => (media?.url ? { url: media.url, uploadedAt: iso(media.uploadedAt) } : null);

/** One Weekly Update as every reader (member, coach) sees it. */
export const toWeeklyUpdate = (doc) => ({
  weeklyUpdateId: String(doc._id),
  reportDate: doc.reportDate,
  timezone: doc.timezone,
  weekNumber: doc.weekNumber ?? null,
  enrollmentId: id(doc.enrollmentId),
  coachId: id(doc.coachId),
  planId: id(doc.planId),
  status: doc.status,
  profileSnapshot: {
    gender: doc.profileSnapshot?.gender ?? null,
    age: doc.profileSnapshot?.age ?? null,
    heightCm: doc.profileSnapshot?.heightCm ?? null,
  },
  measurements: Object.fromEntries(WEEKLY_MEASUREMENT_KEYS.map((key) => [key, doc.measurements?.[key] ?? null])),
  progressMedia: Object.fromEntries(
    Object.values(WEEKLY_MEDIA_FIELDS).map((field) => [field, mediaView(doc.progressMedia?.[field])]),
  ),
  submittedAt: iso(doc.submittedAt),
  createdAt: iso(doc.createdAt),
  updatedAt: iso(doc.updatedAt),
});

const dayClosed = (today) =>
  new AppError(409, ERROR_CODES.WEEKLY_UPDATE_DAY_CLOSED, `A Weekly Update can only be made for today (${today})`, { today });
const isDuplicateKey = (error) => error?.code === 11000;

/**
 * The enrollment a Weekly Update belongs to: the member's active one, else
 * their latest purchase (the rule the questionnaire and Body Metrics use).
 */
const enrollmentFor = async (userId, now) => {
  const { current, enrollments } = await listMemberEnrollments(userId, now);
  const chosen = current ?? enrollments[0] ?? null;
  if (!chosen) throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'You have no plan to send a Weekly Update for');
  const doc = await EnrolledClient.findOne(
    { _id: chosen.id, userId, isDeleted: { $ne: true } },
    { coachId: 1, planId: 1, startDate: 1, hasStarted: 1 },
  ).lean();
  if (!doc) throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'You have no plan to send a Weekly Update for');
  return doc;
};

/** Week of the plan [reportDate] falls in (1-based); null before it has started. */
const weekNumberOf = (enrollment, reportDate) => {
  if (!enrollment.hasStarted || !enrollment.startDate) return null;
  const startDay = businessDayOf(enrollment.startDate);
  const days = (Date.parse(`${reportDate}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86_400_000;
  return days < 0 ? null : Math.floor(days / 7) + 1;
};

/** Writes are for today only; returns today. */
const assertToday = (reportDate, now) => {
  const today = businessDayOf(now);
  if (reportDate !== today) throw dayClosed(today);
  return today;
};

const draftFilter = (clientId, enrollmentId, reportDate) => ({ clientId, enrollmentId, reportDate, status: 'draft' });

const discard = async (media) => {
  if (!media?.url) return;
  await getStorage()
    .remove(media.url)
    .catch((error) => logger.warn(`Could not remove a Weekly Update file: ${error.message}`));
};

/** GET one day - the member's open draft for [date], else their latest submitted one. */
export const getMemberWeeklyUpdate = async (userId, date, { now = new Date() } = {}) => {
  const reportDate = validateReportDate(date, 'date');
  // Today's open draft first (the app resumes its photos), else the latest submitted.
  const doc = await WeeklyUpdate.findOne({ clientId: userId, reportDate }).sort({ status: 1, updatedAt: -1 }).lean();
  if (!doc) throw notFound(ERROR_CODES.WEEKLY_UPDATE_NOT_FOUND, 'No Weekly Update for that date');
  return { today: businessDayOf(now), weeklyUpdate: toWeeklyUpdate(doc) };
};

/**
 * PUT media - one progress photo or the video into today's draft (created by
 * the first upload). Validated by its bytes; the file it replaces is removed
 * only once the record points at the new one.
 */
export const setMemberWeeklyUpdateMedia = async (userId, date, slot, buffer, { now = new Date() } = {}) => {
  validateWeeklyMediaSlot(slot);
  const reportDate = validateReportDate(date, 'date');
  assertToday(reportDate, now);
  const enrollment = await enrollmentFor(userId, now);
  const field = `progressMedia.${WEEKLY_MEDIA_FIELDS[slot]}`;

  const type =
    slot === WEEKLY_VIDEO_SLOT
      ? assertValidVideo(buffer, { maxBytes: env.storage.maxVideoUploadBytes })
      : assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes });

  const storage = getStorage();
  const url = await storage.save(buffer, {
    folder: weeklyUpdateMediaFolder(userId, reportDate, slot),
    extension: type.extension,
  });
  const media = { url, storageKey: storage.keyFor(url), uploadedAt: now };

  // Into the day's open draft, started by this upload when there is none (a
  // second upload racing to start it finds it on the retry).
  const write = () =>
    WeeklyUpdate.findOneAndUpdate(
      draftFilter(userId, enrollment._id, reportDate),
      {
        $set: { [field]: media, coachId: enrollment.coachId ?? null, planId: enrollment.planId ?? null },
        $setOnInsert: { clientId: userId, enrollmentId: enrollment._id, reportDate, timezone: env.businessTimezone },
      },
      { returnDocument: 'before', upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
  let before;
  try {
    before = await write().catch((error) => (isDuplicateKey(error) ? write() : Promise.reject(error)));
  } catch (error) {
    await discard(media);
    throw error;
  }
  const previous = before?.progressMedia?.[WEEKLY_MEDIA_FIELDS[slot]];
  // Re-uploading the identical file yields the same content-hashed URL: keep it.
  if (previous?.url && previous.url !== url) await discard(previous);

  const doc = await WeeklyUpdate.findOne(draftFilter(userId, enrollment._id, reportDate)).lean();
  return { weeklyUpdate: toWeeklyUpdate(doc) };
};

/** DELETE media - clears one slot of today's draft, then removes its file. */
export const removeMemberWeeklyUpdateMedia = async (userId, date, slot, { now = new Date() } = {}) => {
  validateWeeklyMediaSlot(slot);
  const reportDate = validateReportDate(date, 'date');
  assertToday(reportDate, now);
  const enrollment = await enrollmentFor(userId, now);
  const field = WEEKLY_MEDIA_FIELDS[slot];

  const before = await WeeklyUpdate.findOneAndUpdate(
    draftFilter(userId, enrollment._id, reportDate),
    { $set: { [`progressMedia.${field}`]: null } },
    { returnDocument: 'before' },
  ).lean();
  if (!before) throw notFound(ERROR_CODES.WEEKLY_UPDATE_NOT_FOUND, 'No Weekly Update in progress for that date');
  await discard(before.progressMedia?.[field]);
  const doc = await WeeklyUpdate.findOne({ _id: before._id }).lean();
  return { weeklyUpdate: toWeeklyUpdate(doc) };
};

/**
 * POST - submits today's Weekly Update: the nine measurements over the open
 * draft holding the three required photos. One conditional write makes it
 * final, so concurrent submits of one draft produce one record, and a retry
 * carrying the same submissionId gets that record back.
 */
export const submitMemberWeeklyUpdate = async (userId, body, { now = new Date() } = {}) => {
  const { reportDate, measurements, submissionId } = validateWeeklyUpdateSubmission(body);
  assertToday(reportDate, now);
  const enrollment = await enrollmentFor(userId, now);
  const key = { clientId: userId, enrollmentId: enrollment._id, reportDate };

  const user = await User.findById(userId).lean();
  if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  const { gender, age, heightCm } = await profileSnapshot(user, enrollment._id);

  const photosPresent = Object.fromEntries(
    WEEKLY_REQUIRED_PHOTO_SLOTS.map((slot) => [`progressMedia.${WEEKLY_MEDIA_FIELDS[slot]}.url`, { $exists: true, $type: 'string' }]),
  );

  const doc = await WeeklyUpdate.findOneAndUpdate(
    { ...key, status: 'draft', ...photosPresent },
    {
      $set: {
        measurements,
        profileSnapshot: { gender, age, heightCm },
        weekNumber: weekNumberOf(enrollment, reportDate),
        coachId: enrollment.coachId ?? null,
        planId: enrollment.planId ?? null,
        status: 'submitted',
        submittedAt: now,
        submissionId,
      },
    },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (doc) return { weeklyUpdate: toWeeklyUpdate(doc), created: true };

  // Nothing was submitted: a retry of one that already was, or say why.
  if (submissionId) {
    const done = await WeeklyUpdate.findOne({ ...key, status: 'submitted', submissionId }).lean();
    if (done) return { weeklyUpdate: toWeeklyUpdate(done), created: false };
  }
  const existing = await WeeklyUpdate.findOne(draftFilter(userId, enrollment._id, reportDate)).lean();
  const missing = WEEKLY_REQUIRED_PHOTO_SLOTS.filter((slot) => !existing?.progressMedia?.[WEEKLY_MEDIA_FIELDS[slot]]?.url);
  throw new AppError(
    400,
    ERROR_CODES.WEEKLY_UPDATE_INCOMPLETE,
    `Upload the progress photos first: ${missing.join(', ')}`,
    { missing },
  );
};

/**
 * Where a page starts: `<reportDate>_<id>` of the last item seen (several
 * updates can share a date), or a bare date - everything before that day.
 */
const afterCursor = (cursor) => {
  const [date, lastId] = String(cursor).split('_');
  validateReportDate(date, 'cursor');
  if (lastId === undefined) return { reportDate: { $lt: date } };
  if (!mongoose.isValidObjectId(lastId)) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'cursor is invalid');
  return { $or: [{ reportDate: { $lt: date } }, { reportDate: date, _id: { $lt: new mongoose.Types.ObjectId(lastId) } }] };
};

/** Submitted updates of [query], newest report date first, a page at a time. */
const historyOf = async (query, { limit, cursor } = {}) => {
  const after = cursor !== undefined ? afterCursor(cursor) : {};
  let size = HISTORY_DEFAULT_LIMIT;
  if (limit !== undefined) {
    size = Number.parseInt(limit, 10);
    if (!Number.isInteger(size) || size < 1) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'limit must be a positive integer');
    size = Math.min(size, HISTORY_MAX_LIMIT);
  }
  const docs = await WeeklyUpdate.find({ ...query, status: 'submitted', ...after })
    .sort({ reportDate: -1, _id: -1 })
    .limit(size + 1)
    .lean();
  const page = docs.slice(0, size);
  const last = page[page.length - 1];
  return { items: page.map(toWeeklyUpdate), nextCursor: docs.length > size ? `${last.reportDate}_${last._id}` : null };
};

/** GET history - the member's own submitted Weekly Updates. */
export const listMemberWeeklyUpdates = (userId, query = {}) => historyOf({ clientId: userId }, query);

/** Coach reads: one of the coach's own enrollments - its submitted updates only. */
export const listWeeklyUpdatesForCoach = async (coachUserId, enrollmentId, query = {}) => {
  const clientId = await clientOfCoachEnrollment(coachUserId, enrollmentId);
  return historyOf({ clientId, enrollmentId }, query);
};

/**
 * Coach read: one client's submitted updates across every one of their
 * enrollments with this coach (another coach's cycles never show), newest
 * first. A member who is not this coach's client is a 404.
 */
export const listClientWeeklyUpdatesForCoach = async (coachUserId, clientUserId, query = {}) => {
  const coach = await Coach.findOne({ userId: coachUserId }, { _id: 1 }).lean();
  if (!coach) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'You do not have a coach profile');

  const notFoundError = notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'This member is not one of your clients');
  if (!mongoose.isValidObjectId(clientUserId)) throw notFoundError;
  const enrollmentIds = await EnrolledClient.distinct('_id', { userId: clientUserId, coachId: coach._id, isDeleted: { $ne: true } });
  if (enrollmentIds.length === 0) throw notFoundError;

  return historyOf({ clientId: clientUserId, enrollmentId: { $in: enrollmentIds } }, query);
};

export const getWeeklyUpdateForCoach = async (coachUserId, enrollmentId, date) => {
  const clientId = await clientOfCoachEnrollment(coachUserId, enrollmentId);
  const reportDate = validateReportDate(date, 'date');
  const doc = await WeeklyUpdate.findOne({ clientId, enrollmentId, reportDate, status: 'submitted' }).lean();
  if (!doc) throw notFound(ERROR_CODES.WEEKLY_UPDATE_NOT_FOUND, 'No Weekly Update for that date');
  return { weeklyUpdate: toWeeklyUpdate(doc) };
};

export default {
  toWeeklyUpdate,
  getMemberWeeklyUpdate,
  setMemberWeeklyUpdateMedia,
  removeMemberWeeklyUpdateMedia,
  submitMemberWeeklyUpdate,
  listMemberWeeklyUpdates,
  listWeeklyUpdatesForCoach,
  listClientWeeklyUpdatesForCoach,
  getWeeklyUpdateForCoach,
};
