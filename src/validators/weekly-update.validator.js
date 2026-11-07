import { WEEKLY_MEASUREMENTS, WEEKLY_MEDIA_SLOTS } from '../constants/weekly-update-definition.js';
import { isCalendarDay } from '../utils/business-date.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * Validates a Weekly Update submission. The body carries the report date, the
 * nine measurements and, optionally, the app's submission id (a retry sends
 * the same one) - nothing else. Ownership fields, the profile snapshot and the
 * media are refused outright rather than ignored: the server resolves the
 * owner, enrollment and coach itself, snapshots the profile, and the photos
 * are already on the draft through the upload route.
 *
 * Every measurement is required and must be a number. No range or decimal
 * limit is applied (not decided yet for Weekly Update).
 */

const invalid = (message) => badRequest(ERROR_CODES.VALIDATION_ERROR, message);

const ALLOWED_KEYS = ['reportDate', 'measurements', 'submissionId'];

export const validateWeeklyMeasurement = (def, value) => {
  if (value === undefined || value === null || value === '') throw invalid(`${def.key} is required`);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${def.key} must be a number`);
  return value;
};

export const validateReportDate = (value, name = 'reportDate') => {
  if (typeof value !== 'string' || !isCalendarDay(value)) throw invalid(`${name} must be a YYYY-MM-DD date`);
  return value;
};

/** @returns {{ reportDate: string, measurements: Record<string, number>, submissionId: string|null }} */
export const validateWeeklyUpdateSubmission = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be an object');
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.includes(key)) throw invalid(`${key} cannot be set`);
  }

  const reportDate = validateReportDate(body.reportDate);

  const raw = body.measurements;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('measurements must be an object');
  for (const key of Object.keys(raw)) {
    if (!WEEKLY_MEASUREMENTS.some((m) => m.key === key)) throw invalid(`Unknown measurement: ${key}`);
  }
  const measurements = Object.fromEntries(WEEKLY_MEASUREMENTS.map((def) => [def.key, validateWeeklyMeasurement(def, raw[def.key])]));

  let submissionId = null;
  if (body.submissionId !== undefined && body.submissionId !== null) {
    if (typeof body.submissionId !== 'string' || !body.submissionId.trim() || body.submissionId.length > 100) {
      throw invalid('submissionId must be a non-empty string of at most 100 characters');
    }
    submissionId = body.submissionId.trim();
  }
  return { reportDate, measurements, submissionId };
};

export const validateWeeklyMediaSlot = (slot) => {
  if (!WEEKLY_MEDIA_SLOTS.includes(slot)) throw invalid(`Media slot must be one of: ${WEEKLY_MEDIA_SLOTS.join(', ')}`);
  return slot;
};
