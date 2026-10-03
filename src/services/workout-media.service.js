import mongoose from 'mongoose';

import env from '../config/env.js';
import logger from '../config/logger.js';
import Workout from '../models/workout.model.js';
import { assertValidImage } from '../utils/image.js';
import { assertValidVideo } from '../utils/video.js';
import { getStorage, workoutThumbnailFolder, workoutVideoFolder } from './storage/index.js';
import { getWorkoutById } from './workout.service.js';

/**
 * A workout's video and thumbnail. Same lifecycle as the coach pictures and the
 * plan cover: validate the bytes, store under the workout's own folder, point
 * the workout at the stored file in one atomic update, and only then delete the
 * file it replaced.
 *
 * That last step is the fix for the legacy behaviour, where every replacement
 * left the old file on disk forever. The order matters: if the upload fails,
 * nothing is written and the existing media is still intact; the document is
 * never left pointing at a file that has been removed.
 *
 * MongoDB stores { url, storageKey } - never the bytes.
 */

const discard = async (media, what) => {
  if (!media?.url) return;
  await getStorage()
    .remove(media.url)
    .catch((error) => logger.warn(`Could not remove the previous workout ${what}: ${error.message}`));
};

/** The two media slots, each with its own validator, folder and size limit. */
const SLOTS = {
  video: {
    folder: workoutVideoFolder,
    validate: (buffer) => assertValidVideo(buffer, { maxBytes: env.storage.maxVideoUploadBytes }),
  },
  thumbnail: {
    folder: workoutThumbnailFolder,
    validate: (buffer) => assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes }),
  },
};

/**
 * Stores a new file in [slot]. Returns the updated workout, or null if there is
 * no such workout.
 */
export const setWorkoutMedia = async (slot, workoutId, buffer, adminId) => {
  const config = SLOTS[slot];
  if (!config) throw new Error(`Unknown workout media slot "${slot}"`);
  if (!mongoose.isValidObjectId(workoutId)) return null;

  // Validated before anything is stored: the bytes decide, not the filename.
  const type = config.validate(buffer);
  if (!(await Workout.exists({ _id: workoutId }))) return null;

  const storage = getStorage();
  const url = await storage.save(buffer, { folder: config.folder(workoutId), extension: type.extension });
  const media = { url, storageKey: storage.keyFor(url) };

  // The previous reference comes from the same atomic update that replaces it.
  const before = await Workout.findByIdAndUpdate(
    workoutId,
    { $set: { [slot]: media, updatedBy: adminId } },
    { new: false, runValidators: true },
  ).lean();

  if (!before) {
    await discard(media, slot);
    return null;
  }
  // Re-uploading the identical file yields the same content-hashed URL: keep it.
  if (before[slot]?.url && before[slot].url !== url) await discard(before[slot], slot);

  return getWorkoutById(workoutId);
};

/** Clears a media slot, then removes its file. Null if there is no such workout. */
export const removeWorkoutMedia = async (slot, workoutId, adminId) => {
  if (!SLOTS[slot]) throw new Error(`Unknown workout media slot "${slot}"`);
  if (!mongoose.isValidObjectId(workoutId)) return null;

  const before = await Workout.findByIdAndUpdate(
    workoutId,
    { $set: { [slot]: null, updatedBy: adminId } },
    { new: false },
  ).lean();

  if (!before) return null;
  await discard(before[slot], slot);
  return getWorkoutById(workoutId);
};
