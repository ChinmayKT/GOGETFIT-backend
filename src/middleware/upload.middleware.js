import express from 'express';

import env from '../config/env.js';
import { SUPPORTED_IMAGE_TYPES } from '../utils/image.js';
import { SUPPORTED_VIDEO_TYPES } from '../utils/video.js';

/**
 * Raw image bytes rather than multipart: the payload is a single file, so this
 * needs no parser dependency and hands the service an untouched Buffer to sniff.
 * The limit is enforced here as well as in the validator, so an oversized body
 * is refused before it is buffered.
 *
 * Shared by every image endpoint (member avatar, coach pictures) so there is one
 * upload path, not one per feature.
 */
export const rawImageBody = express.raw({
  type: SUPPORTED_IMAGE_TYPES,
  limit: env.storage.maxUploadBytes,
});

/**
 * The same raw-body approach for workout videos, with its own larger limit so a
 * video upload cannot be capped by the avatar limit and an oversized body is
 * still refused before it is buffered.
 */
export const rawVideoBody = express.raw({
  type: SUPPORTED_VIDEO_TYPES,
  limit: env.storage.maxVideoUploadBytes,
});

export default rawImageBody;
