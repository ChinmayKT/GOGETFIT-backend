import { ERROR_CODES, badRequest } from './errors.js';
import { SUPPORTED_IMAGE_TYPES, detectImageType } from './image.js';

/**
 * A coach certificate's file: a supported image (JPEG, PNG, WebP - the same
 * signatures as every picture) or a PDF. Decided by the bytes the file starts
 * with, never by its name or Content-Type.
 */
const PDF = { extension: 'pdf', mimeType: 'application/pdf', kind: 'pdf' };

export const SUPPORTED_CERTIFICATE_TYPES = [...SUPPORTED_IMAGE_TYPES, PDF.mimeType];

/** The real type of [buffer] as { extension, mimeType, kind }, or null. */
export const detectCertificateType = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (buffer.length > 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return PDF;
  const image = detectImageType(buffer);
  return image ? { extension: image.extension, mimeType: image.mimeType, kind: 'image' } : null;
};

/** Rejects an empty, oversized or unsupported certificate file. */
export const assertValidCertificateFile = (buffer, { maxBytes }) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'No certificate file was uploaded');
  }
  if (buffer.length > maxBytes) {
    const limitMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    throw badRequest(ERROR_CODES.FILE_TOO_LARGE, `Certificate file is larger than the ${limitMb} MB limit`);
  }
  const type = detectCertificateType(buffer);
  if (!type) {
    throw badRequest(ERROR_CODES.UNSUPPORTED_FILE_TYPE, 'Unsupported certificate file. Accepted: JPEG, PNG, WebP or PDF');
  }
  return type;
};
