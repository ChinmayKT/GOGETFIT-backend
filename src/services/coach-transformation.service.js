import mongoose from 'mongoose';

import env from '../config/env.js';
import CoachTransformation, { TRANSFORMATION_TITLE_MAX } from '../models/coach-transformation.model.js';
import EnrolledClient from '../models/enrolled-client.model.js';
import { assertValidImage } from '../utils/image.js';
import { ERROR_CODES, badRequest, notFound } from '../utils/errors.js';
import { coachNames, coachOfUser } from './diet-plan.service.js';
import { coachTransformationFolder, getStorage } from './storage/index.js';

/**
 * Coach transformation submissions: a coach sends an image with a title for
 * one of their clients; admins list them. Nothing is reviewed or published.
 */

const PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

const toView = (doc, coachName = null) => ({
  id: String(doc._id),
  title: doc.title,
  imageUrl: doc.image.url,
  submittedAt: new Date(doc.submittedAt).toISOString(),
  coach: { id: String(doc.coachId), name: coachName },
  clientId: String(doc.clientId),
});

/**
 * Coach write: stores [buffer] (validated by its bytes, under the upload
 * limit) and records it with [title] for [clientUserId], who must be one of
 * the signed-in coach's clients. The coach is always the token's.
 */
export const submitCoachTransformation = async (coachUserId, clientUserId, { title, buffer }) => {
  const text = typeof title === 'string' ? title.trim() : '';
  if (!text) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'title is required');
  if (text.length > TRANSFORMATION_TITLE_MAX) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `title must be at most ${TRANSFORMATION_TITLE_MAX} characters`);
  }
  const type = assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes });

  const coach = await coachOfUser(coachUserId);
  const notYours = notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'This member is not one of your clients');
  if (!mongoose.isValidObjectId(clientUserId)) throw notYours;
  const yours = await EnrolledClient.exists({ userId: clientUserId, coachId: coach._id, isDeleted: { $ne: true } });
  if (!yours) throw notYours;

  // Checked before storing, so a refused request never leaves a file behind.
  const storage = getStorage();
  const url = await storage.save(buffer, { folder: coachTransformationFolder(coach._id), extension: type.extension });
  const doc = await CoachTransformation.create({
    coachId: coach._id,
    clientId: clientUserId,
    title: text,
    image: { url, storageKey: storage.keyFor(url) },
    submittedAt: new Date(),
  });
  return toView(doc.toObject());
};

/** Admin read: every submission, newest first, a page at a time. */
export const listCoachTransformations = async ({ page, pageSize } = {}) => {
  const parse = (value, fallback, label) => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw badRequest(ERROR_CODES.VALIDATION_ERROR, `${label} must be a positive integer`);
    return n;
  };
  const pageNo = parse(page, 1, 'page');
  const size = Math.min(parse(pageSize, PAGE_SIZE, 'pageSize'), MAX_PAGE_SIZE);
  const [docs, total] = await Promise.all([
    CoachTransformation.find()
      .sort({ submittedAt: -1, _id: -1 })
      .skip((pageNo - 1) * size)
      .limit(size)
      .lean(),
    CoachTransformation.countDocuments(),
  ]);
  const names = await coachNames(docs.map((d) => d.coachId));
  return {
    items: docs.map((d) => toView(d, names.get(String(d.coachId)) ?? null)),
    pagination: { page: pageNo, pageSize: size, total, hasMore: pageNo * size < total },
  };
};

export default { submitCoachTransformation, listCoachTransformations };
