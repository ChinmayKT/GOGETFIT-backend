import { BODY_MEASUREMENT_BY_KEY, BODY_MEASUREMENT_KEYS, MEDIA_SLOTS } from '../constants/body-metrics-definition.js';
import { BODY_METRICS_STATUSES } from '../models/body-metrics.model.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * Validates a Body Metrics save. The body may carry the 11 measurements and the
 * status - nothing else. Ownership fields (userId, enrollmentId, coachId) and
 * the gender copied from the user profile are refused outright rather than
 * ignored, so a client trying to set them learns it cannot. Media are not part of this body: they go through the upload route.
 *
 * Every measurement given must be a finite number - no range, precision or
 * length limit. A draft may leave any of them out; null clears one.
 */

const invalid = (message) => badRequest(ERROR_CODES.VALIDATION_ERROR, message);

const FORBIDDEN_KEYS = ['userId', 'enrollmentId', 'coachId', 'gender', 'submittedAt', 'schemaVersion', ...MEDIA_SLOTS];

export const validateMeasurement = (key, value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${key} must be a number`);
  return value;
};

/** @returns {{ measurements: Record<string, number|null>, status: 'draft'|'submitted' }} */
export const validateBodyMetricsSave = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be an object');

  for (const key of Object.keys(body)) {
    if (FORBIDDEN_KEYS.includes(key)) throw invalid(`${key} cannot be set`);
    if (key !== 'status' && key !== 'measurements') throw invalid(`Unknown field: ${key}`);
  }

  const status = body.status ?? 'draft';
  if (!BODY_METRICS_STATUSES.includes(status)) throw invalid(`status must be one of: ${BODY_METRICS_STATUSES.join(', ')}`);

  const raw = body.measurements ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) throw invalid('measurements must be an object');

  const measurements = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!BODY_MEASUREMENT_BY_KEY.has(key)) throw invalid(`Unknown measurement: ${key}`);
    measurements[key] = value === null ? null : validateMeasurement(key, value);
  }
  return { measurements, status };
};

export const validateMediaSlot = (slot) => {
  if (!MEDIA_SLOTS.includes(slot)) throw invalid(`Media slot must be one of: ${MEDIA_SLOTS.join(', ')}`);
  return slot;
};

export const validateBodyMetricsStatus = (status) => {
  if (!BODY_METRICS_STATUSES.includes(status)) throw invalid(`status must be one of: ${BODY_METRICS_STATUSES.join(', ')}`);
  return status;
};

export { BODY_MEASUREMENT_KEYS };
