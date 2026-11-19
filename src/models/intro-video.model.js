import mongoose from 'mongoose';

/**
 * Introductory Videos (Journey Module 3): short onboarding lessons the
 * Admin Portal manages and the app lists - a module of its own, in its own
 * `intro_videos` collection, never mixed with the Workout master. Built like
 * a workout: text fields, a video and a thumbnail stored by the storage
 * service ({ url, storageKey } only - never the bytes), and "delete" that
 * archives (reversible).
 */
export const INTRO_VIDEO_STATUSES = ['active', 'archived'];

export const INTRO_VIDEO_LIMITS = {
  title: 150,
  subtitle: 200,
  description: 5000,
  learnItem: 200,
  learnItems: 12,
  note: 2000,
  maxPosition: 999,
  maxDurationSeconds: 3 * 60 * 60,
};

const mediaRefSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    storageKey: { type: String, required: true },
  },
  { _id: false },
);

const introVideoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: INTRO_VIDEO_LIMITS.title },
    subtitle: { type: String, default: null, trim: true, maxlength: INTRO_VIDEO_LIMITS.subtitle },
    /** "About this video". */
    description: { type: String, required: true, maxlength: INTRO_VIDEO_LIMITS.description },
    /** "What you'll learn" checklist. */
    whatYoullLearn: { type: [String], default: () => [] },
    notes: { type: String, default: null, maxlength: INTRO_VIDEO_LIMITS.note },
    tips: { type: String, default: null, maxlength: INTRO_VIDEO_LIMITS.note },
    /** Lesson order in the app (1 first). */
    position: { type: Number, required: true, min: 1, max: INTRO_VIDEO_LIMITS.maxPosition },
    /** Shown on the card; optional (the player reads the real length). */
    durationSeconds: { type: Number, default: null, min: 0, max: INTRO_VIDEO_LIMITS.maxDurationSeconds },

    video: { type: mediaRefSchema, default: null },
    thumbnail: { type: mediaRefSchema, default: null },

    status: { type: String, enum: INTRO_VIDEO_STATUSES, default: 'active' },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false, collection: 'intro_videos' },
);

introVideoSchema.index({ status: 1, position: 1 }, { name: 'intro_video_status_position' });

export const IntroVideo = mongoose.model('IntroVideo', introVideoSchema);
export default IntroVideo;
