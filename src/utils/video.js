import { ERROR_CODES, badRequest } from './errors.js';

/**
 * Video types the workout video endpoint accepts, keyed by what actually starts
 * the file. The client's filename and Content-Type are never trusted - legacy
 * checked the extension alone, which any renamed file passes.
 *
 * Only MP4 is accepted, which is what the legacy form allowed and what all 188
 * legacy workout videos are.
 */

/**
 * An ISO Base Media file (MP4 and friends) starts with a box: a 4-byte size,
 * then the type "ftyp". The brand that follows says which flavour it is.
 */
const MP4_BRANDS = [
  'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'avc1', 'mp41', 'mp42', 'mp4v',
  'M4V ', 'dash', 'mmp4', 'qt  ',
];

export const detectVideoType = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(4, 8).toString('ascii') !== 'ftyp') return null;

  const brand = buffer.subarray(8, 12).toString('ascii');
  // The brand list is not exhaustive across every encoder, so an ftyp box with
  // an unknown brand is still accepted as MP4 rather than rejected outright;
  // what matters is that the file really is an ISO media container.
  return {
    extension: 'mp4',
    mimeType: 'video/mp4',
    brand: MP4_BRANDS.includes(brand) ? brand : brand.trim() || 'unknown',
  };
};

export const SUPPORTED_VIDEO_TYPES = ['video/mp4'];

/**
 * Validates an uploaded workout video. Rejects anything that is not a real MP4
 * and anything over the configured size, so the endpoint can never be used to
 * store arbitrary files.
 */
export const assertValidVideo = (buffer, { maxBytes }) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'No video data was uploaded');
  }

  if (buffer.length > maxBytes) {
    const limitMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    throw badRequest(ERROR_CODES.FILE_TOO_LARGE, `Video is larger than the ${limitMb} MB limit`);
  }

  const type = detectVideoType(buffer);
  if (!type) {
    throw badRequest(ERROR_CODES.UNSUPPORTED_VIDEO_TYPE, 'Only MP4 video is supported');
  }
  return type;
};

export default { detectVideoType, assertValidVideo, SUPPORTED_VIDEO_TYPES };
