import mongoose from 'mongoose';

import env from '../config/env.js';
import logger from '../config/logger.js';
import IntroVideo from '../models/intro-video.model.js';
import { assertValidImage } from '../utils/image.js';
import { assertValidVideo } from '../utils/video.js';
import { getStorage, introVideoThumbnailFolder, introVideoVideoFolder } from './storage/index.js';
import { getIntroVideoById } from './intro-video.service.js';

/**
 * An Introductory Video's video and thumbnail - the workout media lifecycle
 * exactly: validate the bytes, store under the lesson's own folder, point the
 * document at the new file in one atomic update, and only then delete the file
 * it replaced.
 */

const discard = async (media, what) => {
  if (!media?.url) return;
  await getStorage()
    .remove(media.url)
    .catch((error) => logger.warn(`Could not remove the previous intro video ${what}: ${error.message}`));
};

const SLOTS = {
  video: {
    folder: introVideoVideoFolder,
    validate: (buffer) => assertValidVideo(buffer, { maxBytes: env.storage.maxVideoUploadBytes }),
  },
  thumbnail: {
    folder: introVideoThumbnailFolder,
    validate: (buffer) => assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes }),
  },
};

export const setIntroVideoMedia = async (slot, id, buffer, adminId) => {
  const config = SLOTS[slot];
  if (!config) throw new Error(`Unknown intro video media slot "${slot}"`);
  if (!mongoose.isValidObjectId(id)) return null;
  const type = config.validate(buffer);
  if (!(await IntroVideo.exists({ _id: id }))) return null;

  const storage = getStorage();
  const url = await storage.save(buffer, { folder: config.folder(id), extension: type.extension });
  const media = { url, storageKey: storage.keyFor(url) };
  const before = await IntroVideo.findByIdAndUpdate(
    id,
    { $set: { [slot]: media, updatedBy: adminId } },
    { new: false, runValidators: true },
  ).lean();
  if (!before) {
    await discard(media, slot);
    return null;
  }
  if (before[slot]?.url && before[slot].url !== url) await discard(before[slot], slot);
  return getIntroVideoById(id);
};

export const removeIntroVideoMedia = async (slot, id, adminId) => {
  if (!SLOTS[slot]) throw new Error(`Unknown intro video media slot "${slot}"`);
  if (!mongoose.isValidObjectId(id)) return null;
  const before = await IntroVideo.findByIdAndUpdate(id, { $set: { [slot]: null, updatedBy: adminId } }, { new: false }).lean();
  if (!before) return null;
  await discard(before[slot], slot);
  return getIntroVideoById(id);
};
