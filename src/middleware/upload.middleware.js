import express from 'express';

import env from '../config/env.js';
import { SUPPORTED_IMAGE_TYPES } from '../utils/image.js';

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

export default rawImageBody;
