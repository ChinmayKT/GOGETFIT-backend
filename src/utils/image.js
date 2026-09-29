import { ERROR_CODES, badRequest } from './errors.js';

/**
 * Image types the profile picture endpoint accepts, keyed by the magic bytes
 * that actually start the file. The client's filename and Content-Type are
 * never trusted - only what the bytes say.
 */
const SIGNATURES = [
  {
    extension: 'jpg',
    mimeType: 'image/jpeg',
    matches: (buffer) =>
      buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  {
    extension: 'png',
    mimeType: 'image/png',
    matches: (buffer) =>
      buffer.length > 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    extension: 'webp',
    mimeType: 'image/webp',
    matches: (buffer) =>
      buffer.length > 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

/** Sniffs the real type of [buffer], or null when it is not a supported image. */
export const detectImageType = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  return SIGNATURES.find((signature) => signature.matches(buffer)) ?? null;
};

export const SUPPORTED_IMAGE_TYPES = SIGNATURES.map((signature) => signature.mimeType);

/**
 * Validates an uploaded avatar. Rejects anything that is not a real image of a
 * supported type, and anything over the configured size, so the endpoint can
 * never be used to store arbitrary files.
 */
export const assertValidImage = (buffer, { maxBytes }) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'No image data was uploaded');
  }

  if (buffer.length > maxBytes) {
    const limitMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    throw badRequest(
      ERROR_CODES.FILE_TOO_LARGE,
      `Image is larger than the ${limitMb} MB limit`,
    );
  }

  const type = detectImageType(buffer);
  if (!type) {
    throw badRequest(
      ERROR_CODES.UNSUPPORTED_IMAGE_TYPE,
      `Unsupported image. Accepted formats: ${SUPPORTED_IMAGE_TYPES.join(', ')}`,
    );
  }

  return type;
};
