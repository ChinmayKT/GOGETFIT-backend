import mongoose from 'mongoose';

import env from '../config/env.js';
import logger from '../config/logger.js';
import Food from '../models/food.model.js';
import { assertValidImage } from '../utils/image.js';
import { foodImageFolder, getStorage } from './storage/index.js';
import { getFoodById } from './food.service.js';

/**
 * A food's picture. Same lifecycle as the coach pictures and the plan cover:
 * validate the bytes, store them under the food's own folder, point the food at
 * the stored file in one atomic update, and only then delete the previous file.
 *
 * MongoDB stores the reference { url, storageKey } - never the bytes, never
 * base64, and never a bare legacy filename.
 */

const discard = async (image) => {
  if (!image?.url) return;
  await getStorage()
    .remove(image.url)
    .catch((error) => logger.warn(`Could not remove the previous food image: ${error.message}`));
};

/** Stores a new picture. Returns the updated food, or null if there is no such food. */
export const setFoodImage = async (foodId, buffer, adminId) => {
  if (!mongoose.isValidObjectId(foodId)) return null;

  // The bytes decide the type, not the filename the browser sent.
  const type = assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes });
  if (!(await Food.exists({ _id: foodId }))) return null;

  const storage = getStorage();
  const url = await storage.save(buffer, { folder: foodImageFolder(foodId), extension: type.extension });
  const image = { url, storageKey: storage.keyFor(url) };

  const before = await Food.findByIdAndUpdate(
    foodId,
    { $set: { image, updatedBy: adminId } },
    { new: false, runValidators: true },
  ).lean();

  if (!before) {
    await discard(image);
    return null;
  }
  // Re-uploading the identical file yields the same content-hashed URL: keep it.
  if (before.image?.url && before.image.url !== url) await discard(before.image);

  return getFoodById(foodId);
};

/** Clears the picture, then removes its file. Null if there is no such food. */
export const removeFoodImage = async (foodId, adminId) => {
  if (!mongoose.isValidObjectId(foodId)) return null;

  const before = await Food.findByIdAndUpdate(
    foodId,
    { $set: { image: null, updatedBy: adminId } },
    { new: false },
  ).lean();

  if (!before) return null;
  await discard(before.image);
  return getFoodById(foodId);
};
