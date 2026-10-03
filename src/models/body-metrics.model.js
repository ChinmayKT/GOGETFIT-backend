import mongoose from 'mongoose';

import { BODY_METRICS_SCHEMA_VERSION, BODY_MEASUREMENT_KEYS } from '../constants/body-metrics-definition.js';

/**
 * The Body Metrics a member submits for ONE enrollment - the same model as the
 * questionnaire: enrollment-scoped, one document per enrollment (a unique index,
 * not a convention), coachId copied from the enrollment server-side.
 *
 * Measurements are in the app's canonical units (years / cm / kg) and are
 * absent until entered. Media are references ({ url, storageKey }) to files in
 * the storage driver - never the bytes.
 *
 * Status: `draft` while the member fills it in, `submitted` once every
 * measurement and the three required photos are in. Submitted is terminal: the
 * service refuses any later write, so an autosave can never turn it back into
 * a draft or overwrite what the coach is reading.
 */

export const BODY_METRICS_STATUSES = ['draft', 'submitted'];

const mediaSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    storageKey: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const measurementPaths = Object.fromEntries(
  BODY_MEASUREMENT_KEYS.map((key) => [key, { type: Number, default: null }]),
);

const bodyMetricsSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnrolledClient', required: true },
    /** Resolved from the enrollment, never from the request body. */
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', default: null },

    /**
     * The member's gender, copied from their user profile when the record is
     * saved - never taken from the request. Stored on the record so a report
     * read back months later shows the gender the submission was made with,
     * and so a reader needs no second lookup to compute body composition.
     */
    gender: { type: String, enum: ['male', 'female', null], default: null },

    ...measurementPaths,

    front: { type: mediaSchema, default: null },
    side: { type: mediaSchema, default: null },
    back: { type: mediaSchema, default: null },
    video: { type: mediaSchema, default: null },

    schemaVersion: { type: Number, required: true, default: BODY_METRICS_SCHEMA_VERSION },
    status: { type: String, enum: BODY_METRICS_STATUSES, required: true, default: 'draft' },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'bodymetrics' },
);

// One Body Metrics document per enrollment - a hard database constraint.
bodyMetricsSchema.index({ userId: 1, enrollmentId: 1 }, { unique: true, name: 'uniq_body_metrics_user_enrollment' });
bodyMetricsSchema.index({ userId: 1, submittedAt: -1 }, { name: 'body_metrics_user_submitted' });
bodyMetricsSchema.index({ enrollmentId: 1, status: 1 }, { name: 'body_metrics_enrollment_status' });

const BodyMetrics = mongoose.model('BodyMetrics', bodyMetricsSchema);

export default BodyMetrics;
