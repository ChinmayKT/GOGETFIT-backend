import mongoose from 'mongoose';

import { WEEKLY_MEASUREMENT_KEYS } from '../constants/weekly-update-definition.js';

/**
 * A member's Weekly Update for a report date - the business day
 * (Asia/Kolkata) it was made on, as YYYY-MM-DD. (For now a member may submit
 * several a day; see the index below.)
 *
 * It starts as a `draft` when the first progress photo is uploaded - the
 * photos live on the draft, so a failed submit or an app restart never has to
 * upload them again - and becomes `submitted` once the nine measurements are
 * in and the three photos are present. Submitted is final: it is never
 * changed again; the next upload starts a new draft.
 *
 * clientId / enrollmentId / coachId / planId and the profile snapshot are
 * resolved server-side, never taken from a request. Media are references
 * ({ url, storageKey, uploadedAt }) to files in the storage driver - never
 * the bytes.
 */

export const WEEKLY_UPDATE_STATUSES = ['draft', 'submitted'];

const mediaSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    storageKey: { type: String, required: true, trim: true },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false },
);

const measurementPaths = Object.fromEntries(WEEKLY_MEASUREMENT_KEYS.map((key) => [key, { type: Number, default: null }]));

const weeklyUpdateSchema = new mongoose.Schema(
  {
    /** The member (a User); always the token's subject. */
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnrolledClient', required: true, immutable: true },
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', default: null },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'GogetfitPlan', default: null },

    reportDate: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    timezone: { type: String, required: true },
    /** Week of the plan (1 = its first week); null until the plan has started. */
    weekNumber: { type: Number, default: null, min: 1 },

    /** Who it was measured for, as the member's own records said when submitted. */
    profileSnapshot: {
      gender: { type: String, enum: ['male', 'female', null], default: null },
      age: { type: Number, default: null },
      heightCm: { type: Number, default: null },
    },

    measurements: measurementPaths,

    progressMedia: {
      frontPhoto: { type: mediaSchema, default: null },
      sidePhoto: { type: mediaSchema, default: null },
      backPhoto: { type: mediaSchema, default: null },
      video: { type: mediaSchema, default: null },
    },

    status: { type: String, enum: WEEKLY_UPDATE_STATUSES, required: true, default: 'draft' },
    submittedAt: { type: Date, default: null },
    /** The app's id for the submit request, so a retried submit is the same one. */
    submissionId: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'weeklyupdates' },
);

// One open draft per member, enrollment and report date - where the day's
// photos collect. Submitted updates are not limited.
// ponytail: while testing, several updates a day are allowed. Once the rule is
// decided (one a day / a week), make this index cover submitted ones too.
weeklyUpdateSchema.index(
  { clientId: 1, enrollmentId: 1, reportDate: 1 },
  { unique: true, partialFilterExpression: { status: 'draft' }, name: 'uniq_weekly_update_draft_per_day' },
);
weeklyUpdateSchema.index({ submissionId: 1 }, { sparse: true, name: 'weekly_update_submission' });
weeklyUpdateSchema.index({ clientId: 1, status: 1, reportDate: -1 }, { name: 'weekly_update_client_history' });
weeklyUpdateSchema.index({ enrollmentId: 1, status: 1, reportDate: -1 }, { name: 'weekly_update_enrollment_history' });

const WeeklyUpdate = mongoose.model('WeeklyUpdate', weeklyUpdateSchema);

export default WeeklyUpdate;
