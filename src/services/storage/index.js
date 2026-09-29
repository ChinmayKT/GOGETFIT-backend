import path from 'node:path';

import env from '../../config/env.js';
import LocalStorageDriver from './local.driver.js';

/**
 * The storage integration point.
 *
 * Every caller depends on this module rather than on a concrete driver, so
 * adding object storage later is a new driver plus a branch here. The project
 * currently ships only the local-filesystem driver.
 */
let driver = null;

export const getStorage = () => {
  if (driver) return driver;

  switch (env.storage.driver) {
    case 'local':
      driver = new LocalStorageDriver({
        rootDirectory: path.resolve(env.storage.localRoot),
        publicBaseUrl: env.storage.publicBaseUrl,
        publicPath: env.storage.publicPath,
      });
      break;
    default:
      throw new Error(
        `Unknown STORAGE_DRIVER "${env.storage.driver}". Supported: local.`,
      );
  }

  return driver;
};

/** Test seam: forces the next getStorage() to rebuild from the current env. */
export const resetStorage = () => {
  driver = null;
};

export const PROFILE_PICTURE_FOLDER = 'profile';

/**
 * Coach pictures live in a folder per coach and per slot. Stored filenames are
 * content hashes, so a shared folder would let two owners end up pointing at the
 * same file - and deleting one owner's picture would delete the other's. Keeping
 * each coach slot in its own folder makes the coach's profile picture, the coach's
 * cover and the user's own avatar three files that can never collide.
 */
export const coachImageFolder = (coachId, slot) => `coaches/${coachId}/${slot}`;

/** A GoGetFit Plan's cover image: its own folder per plan, for the same reason. */
export const planImageFolder = (planId) => `gogetfit-plans/${planId}/cover`;
