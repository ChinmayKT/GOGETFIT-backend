import mongoose from 'mongoose';

import env from '../config/env.js';
import logger from '../config/logger.js';
import Coach from '../models/coach.model.js';
import { assertValidImage } from '../utils/image.js';
import { coachImageFolder, getStorage } from './storage/index.js';
import { getCoachById } from './coach.service.js';

/**
 * The coach's two pictures. Each slot is its own field on the Coach document and
 * its own folder in storage, so either can be changed or removed without
 * touching the other - or the user's avatar, which lives on the User.
 */
export const COACH_IMAGE_SLOTS = {
  profilePicture: { field: 'profile.profilePicture', folder: 'profile' },
  coverPicture: { field: 'profile.coverPicture', folder: 'cover' },
};

const slotOf = (slot) => {
  const config = COACH_IMAGE_SLOTS[slot];
  if (!config) throw new Error(`Unknown coach image slot "${slot}"`);
  return config;
};

const discard = async (image, label) => {
  if (!image?.url) return;
  await getStorage()
    .remove(image.url)
    .catch((error) => {
      // The admin's change has already succeeded; an orphaned file is not worth
      // failing the request over.
      logger.warn(`Could not remove the previous coach ${label}: ${error.message}`);
    });
};

/**
 * Stores a new coach picture and points the coach at it.
 *
 * Same order as the member avatar: the new file is stored and the document
 * updated BEFORE the old file is deleted, so a failure anywhere never leaves the
 * coach pointing at a file that no longer exists. The previous reference is read
 * from the same atomic update that replaces it, so two overlapping uploads
 * cannot both believe they replaced the same file.
 *
 * Returns the updated coach, or null when no such coach exists.
 */
export const setCoachImage = async (coachId, slot, buffer, adminId) => {
  const { field, folder } = slotOf(slot);
  if (!mongoose.isValidObjectId(coachId)) return null;

  // Validated before anything is stored: bytes, not filename or Content-Type.
  const type = assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes });

  // Checked first so a missing coach never leaves a stored file behind.
  if (!(await Coach.exists({ _id: coachId }))) return null;

  const storage = getStorage();
  const url = await storage.save(buffer, { folder: coachImageFolder(coachId, folder), extension: type.extension });
  const image = { url, storageKey: storage.keyFor(url) };

  const before = await Coach.findByIdAndUpdate(
    coachId,
    { $set: { [field]: image, updatedBy: adminId } },
    { new: false, runValidators: true },
  ).lean();

  if (!before) {
    // Deleted between the check and the update.
    await discard(image, slot);
    return null;
  }

  const previous = slot === 'profilePicture' ? before.profile?.profilePicture : before.profile?.coverPicture;
  // Uploading the identical image again yields the same content-hashed URL, which
  // is now the current file and must not be deleted.
  if (previous?.url && previous.url !== url) await discard(previous, slot);

  return getCoachById(coachId);
};

/** Clears one coach picture, then removes its stored file. Null when no such coach. */
export const removeCoachImage = async (coachId, slot, adminId) => {
  const { field } = slotOf(slot);
  if (!mongoose.isValidObjectId(coachId)) return null;

  const before = await Coach.findByIdAndUpdate(
    coachId,
    { $set: { [field]: null, updatedBy: adminId } },
    { new: false },
  ).lean();
  if (!before) return null;

  const previous = slot === 'profilePicture' ? before.profile?.profilePicture : before.profile?.coverPicture;
  await discard(previous, slot);

  return getCoachById(coachId);
};
