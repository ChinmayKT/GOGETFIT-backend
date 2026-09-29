import env from '../config/env.js';
import logger from '../config/logger.js';
import User from '../models/user.model.js';
import { assertValidImage } from '../utils/image.js';
import { PROFILE_PICTURE_FOLDER, getStorage } from './storage/index.js';

/**
 * Replaces the authenticated user's avatar.
 *
 * Order matters: the new image is stored and the user updated BEFORE the old
 * one is deleted, so a failure anywhere never leaves the profile pointing at a
 * file that no longer exists.
 */
export const setProfilePicture = async (user, buffer) => {
  const type = assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes });
  const storage = getStorage();

  const previous = user.profile?.profilePicture ?? null;

  // 1. Store the new image.
  const url = await storage.save(buffer, {
    folder: PROFILE_PICTURE_FOLDER,
    extension: type.extension,
  });

  // 2. Point the profile at it. Only this field is written, so the email lock
  //    and every other profile value are untouched.
  await User.updateOne({ _id: user._id }, { $set: { 'profile.profilePicture': url } });
  user.profile.profilePicture = url;

  // 3. Only now discard the old file, and only if it is genuinely replaced.
  if (previous && previous !== url) {
    await storage.remove(previous).catch((error) => {
      // The user's change has already succeeded; an orphaned file is not worth
      // failing the request over.
      logger.warn(`Could not remove the previous avatar: ${error.message}`);
    });
  }

  return url;
};

/** Clears the avatar, then removes the stored file. */
export const removeProfilePicture = async (user) => {
  const previous = user.profile?.profilePicture ?? null;

  await User.updateOne({ _id: user._id }, { $set: { 'profile.profilePicture': null } });
  user.profile.profilePicture = null;

  if (previous) {
    await getStorage()
      .remove(previous)
      .catch((error) => logger.warn(`Could not remove the avatar file: ${error.message}`));
  }

  return null;
};
