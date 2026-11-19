import mongoose from 'mongoose';

import env from '../config/env.js';
import logger from '../config/logger.js';
import Coach, { MAX_COACH_CERTIFICATIONS } from '../models/coach.model.js';
import { assertValidCertificateFile } from '../utils/certificate-file.js';
import { ERROR_CODES, badRequest, notFound } from '../utils/errors.js';
import { coachCertificationFolder, getStorage } from './storage/index.js';
import { getCoachById } from './coach.service.js';

/**
 * A coach's certifications - admin writes only. Same rules as the coach's
 * pictures (coach-image.service.js): the file is checked by its bytes and
 * stored BEFORE the document points at it, and an old file is deleted only
 * AFTER nothing points at it any more. Stored names are content hashes, so
 * the same file under two certifications is one file: it is kept while
 * either still uses it.
 *
 * Every function returns the updated coach (as the admin reads it), null when
 * no such coach exists, and throws 404 COACH_CERTIFICATION_NOT_FOUND for a
 * certification the coach does not have.
 */

const certificationNotFound = () => notFound(ERROR_CODES.COACH_CERTIFICATION_NOT_FOUND, 'Certification not found');

/** Stores [buffer] for [coachId]; returns the file reference to keep. */
const storeFile = async (coachId, buffer) => {
  const type = assertValidCertificateFile(buffer, { maxBytes: env.storage.maxUploadBytes });
  const storage = getStorage();
  const url = await storage.save(buffer, { folder: coachCertificationFolder(coachId), extension: type.extension });
  return { url, storageKey: storage.keyFor(url), type: type.kind, mimeType: type.mimeType };
};

/** Removes a stored file unless the coach still uses it (content-hashed names). */
const discardUnlessUsed = async (coachId, url) => {
  if (!url) return;
  if (await Coach.exists({ _id: coachId, 'certifications.file.url': url })) return;
  await getStorage()
    .remove(url)
    .catch((error) => {
      // The admin's change has already succeeded; an orphaned file is not worth failing over.
      logger.warn(`Could not remove a coach certificate file: ${error.message}`);
    });
};

const validIds = (coachId, certificationId) =>
  mongoose.isValidObjectId(coachId) && (certificationId === undefined || mongoose.isValidObjectId(certificationId));

/** Adds one certification with its file ([details] is validateCertificationDetails' output). */
export const addCertification = async (coachId, details, buffer, adminId, { now = new Date() } = {}) => {
  if (!validIds(coachId)) return null;
  // Checked first so a missing coach never leaves a stored file behind.
  const current = await Coach.findById(coachId, { certifications: 1 }).lean();
  if (!current) return null;
  if ((current.certifications ?? []).length >= MAX_COACH_CERTIFICATIONS) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `A coach can have at most ${MAX_COACH_CERTIFICATIONS} certifications`);
  }
  const file = await storeFile(coachId, buffer);
  const certification = {
    _id: new mongoose.Types.ObjectId(),
    name: details.name,
    issuer: details.issuer ?? null,
    issueDate: details.issueDate ?? null,
    expiryDate: details.expiryDate ?? null,
    file,
    uploadedAt: now,
  };
  const updated = await Coach.findOneAndUpdate(
    // The cap again, atomically: two uploads at once cannot both pass it.
    { _id: coachId, [`certifications.${MAX_COACH_CERTIFICATIONS - 1}`]: { $exists: false } },
    { $push: { certifications: certification }, $set: { updatedBy: adminId } },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) {
    await discardUnlessUsed(coachId, file.url);
    if (!(await Coach.exists({ _id: coachId }))) return null;
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `A coach can have at most ${MAX_COACH_CERTIFICATIONS} certifications`);
  }
  return getCoachById(coachId);
};

/** Edits a certification's details (partial); its file is untouched. */
export const updateCertification = async (coachId, certificationId, details, adminId) => {
  if (!validIds(coachId, certificationId)) return null;
  const current = await Coach.findById(coachId, { certifications: 1 }).lean();
  if (!current) return null;
  const existing = (current.certifications ?? []).find((c) => String(c._id) === String(certificationId));
  if (!existing) throw certificationNotFound();
  const issueDate = details.issueDate === undefined ? existing.issueDate : details.issueDate;
  const expiryDate = details.expiryDate === undefined ? existing.expiryDate : details.expiryDate;
  if (issueDate && expiryDate && expiryDate < issueDate) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'expiryDate cannot be before issueDate');
  }
  const set = { updatedBy: adminId };
  for (const [key, value] of Object.entries(details)) set[`certifications.$.${key}`] = value;
  const updated = await Coach.findOneAndUpdate(
    { _id: coachId, 'certifications._id': certificationId },
    { $set: set },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw certificationNotFound();
  return getCoachById(coachId);
};

/** Replaces a certification's file; its details stay. The old file goes once unused. */
export const replaceCertificationFile = async (coachId, certificationId, buffer, adminId, { now = new Date() } = {}) => {
  if (!validIds(coachId, certificationId)) return null;
  const current = await Coach.findById(coachId, { certifications: 1 }).lean();
  if (!current) return null;
  if (!(current.certifications ?? []).some((c) => String(c._id) === String(certificationId))) throw certificationNotFound();
  const file = await storeFile(coachId, buffer);
  const before = await Coach.findOneAndUpdate(
    { _id: coachId, 'certifications._id': certificationId },
    { $set: { 'certifications.$.file': file, 'certifications.$.uploadedAt': now, updatedBy: adminId } },
    { new: false, runValidators: true },
  ).lean();
  if (!before) {
    await discardUnlessUsed(coachId, file.url);
    throw certificationNotFound();
  }
  const previous = before.certifications.find((c) => String(c._id) === String(certificationId))?.file?.url;
  if (previous && previous !== file.url) await discardUnlessUsed(coachId, previous);
  return getCoachById(coachId);
};

/** Deletes one certification; the others are untouched. Its file goes once unused. */
export const removeCertification = async (coachId, certificationId, adminId) => {
  if (!validIds(coachId, certificationId)) return null;
  if (!(await Coach.exists({ _id: coachId }))) return null;
  const before = await Coach.findOneAndUpdate(
    { _id: coachId, 'certifications._id': certificationId },
    { $pull: { certifications: { _id: certificationId } }, $set: { updatedBy: adminId } },
    { new: false },
  ).lean();
  if (!before) throw certificationNotFound();
  const removed = before.certifications.find((c) => String(c._id) === String(certificationId));
  await discardUnlessUsed(coachId, removed?.file?.url);
  return getCoachById(coachId);
};
