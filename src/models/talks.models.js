import mongoose from 'mongoose';

/**
 * TALKS - a curated channel of GOGETFIT's YouTube videos. Nothing is hosted
 * here: a talk is a YouTube link plus the metadata needed for its card, and
 * playback happens on YouTube. Collections of their own, prefixed `talks_`
 * (talks_videos, talks_engagements, talks_engagement_events,
 * talks_admin_audit_logs). No other collection is written; users is read by
 * id for admin names.
 */

export const TALK_STATUSES = ['draft', 'published', 'unpublished', 'archived'];

/**
 * Where a talk's YouTube metadata stands:
 *   complete    - fetched from YouTube oEmbed (title, channel, thumbnail)
 *   pending     - not fetched yet, or the last try failed (network, timeout)
 *   unavailable - YouTube reports the video private / removed: for admin review
 */
export const TALK_METADATA_STATUSES = ['complete', 'pending', 'unavailable'];

/** Opens (a tap that sends the member to YouTube) and shares: once per account, talk, kind and day. */
export const TALK_EVENT_KINDS = ['open', 'share'];

/** At most this many talks are featured (the app's carousel). */
export const MAX_FEATURED_TALKS = 3;

export const TALK_LIMITS = {
  title: 200,
  description: 5000,
  channelName: 120,
  maxDisplayOrder: 9999,
  maxDurationSeconds: 24 * 60 * 60,
};

const mediaRef = new mongoose.Schema(
  { url: { type: String, required: true }, storageKey: { type: String, required: true } },
  { _id: false },
);

const talkVideoSchema = new mongoose.Schema(
  {
    youtubeVideoId: { type: String, required: true, immutable: true, match: /^[A-Za-z0-9_-]{11}$/ },
    /** https://www.youtube.com/watch?v=<id> - what is opened and shared. */
    youtubeUrl: { type: String, required: true },

    /** From oEmbed; the admin may correct it ([titleEdited] then keeps a refresh off it). */
    title: { type: String, default: '', trim: true, maxlength: TALK_LIMITS.title },
    titleEdited: { type: Boolean, default: false },
    /** Typed by the admin - oEmbed has no description. */
    description: { type: String, default: '', maxlength: TALK_LIMITS.description },
    /** YouTube's thumbnail URL (i.ytimg.com) - linked, never copied. */
    thumbnailUrl: { type: String, default: null },
    /** The admin's own thumbnail, stored by us; wins over [thumbnailUrl]. */
    customThumbnail: { type: mediaRef, default: null },
    channelName: { type: String, default: null, trim: true, maxlength: TALK_LIMITS.channelName },
    channelUrl: { type: String, default: null },

    /** Not available from oEmbed: only what the admin enters; otherwise null. */
    durationSeconds: { type: Number, default: null, min: 0 },
    /** The YouTube upload date, when the admin enters it; otherwise null. */
    publishedAt: { type: Date, default: null },
    /** YouTube views - not available without the Data API; kept null rather than guessed. */
    viewCount: { type: Number, default: null, min: 0 },

    isFeatured: { type: Boolean, default: false },
    displayOrder: { type: Number, default: 100, min: 0, max: TALK_LIMITS.maxDisplayOrder },
    status: { type: String, enum: TALK_STATUSES, default: 'draft' },
    /** Where Restore returns an archived talk. */
    statusBeforeArchive: { type: String, enum: [...TALK_STATUSES, null], default: null },
    /** When it was first published on GOGETFIT (list order). */
    listedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },

    metadataStatus: { type: String, enum: TALK_METADATA_STATUSES, default: 'pending' },
    metadataError: { type: String, default: null },
    metadataFetchedAt: { type: Date, default: null },

    hifiCount: { type: Number, default: 0, min: 0 },
    saveCount: { type: Number, default: 0, min: 0 },
    openCount: { type: Number, default: 0, min: 0 },
    shareCount: { type: Number, default: 0, min: 0 },

    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByAdminId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'talks_videos' },
);

talkVideoSchema.index({ youtubeVideoId: 1 }, { unique: true, name: 'uniq_talk_youtube_video' });
talkVideoSchema.index({ status: 1, displayOrder: 1, listedAt: -1 }, { name: 'talk_status_order' });
talkVideoSchema.index({ status: 1, isFeatured: -1, displayOrder: 1 }, { name: 'talk_status_featured' });
talkVideoSchema.index({ displayOrder: 1 }, { name: 'talk_display_order' });
talkVideoSchema.index({ metadataStatus: 1, metadataFetchedAt: 1 }, { name: 'talk_metadata' });

/** One account's Hi-Fi and Save of one talk - one record, never two. */
const talkEngagementSchema = new mongoose.Schema(
  {
    talksVideoId: { type: mongoose.Schema.Types.ObjectId, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    hifi: { type: Boolean, default: false },
    hifiAt: { type: Date, default: null },
    saved: { type: Boolean, default: false },
    savedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'talks_engagements' },
);
talkEngagementSchema.index({ talksVideoId: 1, userId: 1 }, { unique: true, name: 'uniq_talk_engagement_video_user' });
talkEngagementSchema.index({ userId: 1, saved: 1, savedAt: -1 }, { name: 'talk_engagement_user_saved' });

const talkEventSchema = new mongoose.Schema(
  {
    talksVideoId: { type: mongoose.Schema.Types.ObjectId, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: TALK_EVENT_KINDS, required: true },
    day: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: 'talks_engagement_events' },
);
talkEventSchema.index({ talksVideoId: 1, userId: 1, kind: 1, day: 1 }, { unique: true, name: 'uniq_talk_event_daily' });
talkEventSchema.index({ talksVideoId: 1, kind: 1, createdAt: -1 }, { name: 'talk_event_video_kind' });

const talkAuditLogSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, default: null },
    action: { type: String, required: true },
    talksVideoId: { type: mongoose.Schema.Types.ObjectId, required: true },
    previousStatus: { type: String, default: null },
    newStatus: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: 'talks_admin_audit_logs' },
);
talkAuditLogSchema.index({ talksVideoId: 1, createdAt: -1 }, { name: 'talk_audit_video' });

export const TalkVideo = mongoose.model('TalkVideo', talkVideoSchema);
export const TalkEngagement = mongoose.model('TalkEngagement', talkEngagementSchema);
export const TalkEvent = mongoose.model('TalkEvent', talkEventSchema);
export const TalkAuditLog = mongoose.model('TalkAuditLog', talkAuditLogSchema);

export const TALKS_MODELS = [TalkVideo, TalkEngagement, TalkEvent, TalkAuditLog];

/** Builds every Talks index (unique ones are hard constraints) and drops ones no model declares. */
export const ensureTalksIndexes = () => Promise.all(TALKS_MODELS.map((m) => m.syncIndexes()));
