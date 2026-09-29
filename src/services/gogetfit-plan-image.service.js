import mongoose from 'mongoose';

import env from '../config/env.js';
import logger from '../config/logger.js';
import GogetfitPlan from '../models/gogetfit-plan.model.js';
import { assertValidImage } from '../utils/image.js';
import { getStorage, planImageFolder } from './storage/index.js';
import { getPlanById } from './gogetfit-plan.service.js';

/**
 * A GoGetFit Plan's cover image. Same lifecycle as the coach pictures
 * (coach-image.service.js): validate the bytes, store under the plan's own
 * folder, point the plan at it in one atomic update, and only then delete the
 * previous file. Archiving a plan leaves its image alone, so a restore keeps it.
 */

const discard = async (image) => {
  if (!image?.url) return;
  await getStorage()
    .remove(image.url)
    .catch((error) => logger.warn(`Could not remove the previous plan image: ${error.message}`));
};

/** Stores a new cover image. Returns the updated plan, or null if there is no such plan. */
export const setPlanImage = async (planId, buffer, adminId) => {
  if (!mongoose.isValidObjectId(planId)) return null;

  // Validated before anything is stored: the bytes decide, not the filename.
  const type = assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes });
  if (!(await GogetfitPlan.exists({ _id: planId }))) return null;

  const storage = getStorage();
  const url = await storage.save(buffer, { folder: planImageFolder(planId), extension: type.extension });
  const image = { url, storageKey: storage.keyFor(url) };

  // The previous reference comes from the same atomic update that replaces it.
  const before = await GogetfitPlan.findByIdAndUpdate(
    planId,
    { $set: { image, updatedBy: adminId } },
    { new: false, runValidators: true },
  ).lean();

  if (!before) {
    await discard(image);
    return null;
  }
  // Re-uploading the identical file yields the same content-hashed URL: keep it.
  if (before.image?.url && before.image.url !== url) await discard(before.image);

  return getPlanById(planId);
};

/** Clears the cover image, then removes its file. Null if there is no such plan. */
export const removePlanImage = async (planId, adminId) => {
  if (!mongoose.isValidObjectId(planId)) return null;

  const before = await GogetfitPlan.findByIdAndUpdate(
    planId,
    { $set: { image: null, updatedBy: adminId } },
    { new: false },
  ).lean();
  if (!before) return null;

  await discard(before.image);
  return getPlanById(planId);
};
