import mongoose from 'mongoose';

/**
 * One Feed post. A single collection for every author: a coach's post carries
 * `authorCoachId`, a member's (once member publishing is switched on) does not.
 * Ownership is always `authorUserId`, the account that wrote it. Names and
 * pictures are never copied in: they are read from users/coaches when shown.
 *
 * Lifecycle: `uploading` (a draft whose media is still arriving) -> `published`
 * -> `removed` (the author deleted it) or `hidden` (future moderation). Only
 * published posts are ever shown in the Feed. Media is fixed once published.
 */

export const POST_TITLE_MAX = 150;
export const POST_TEXT_MAX = 2000;
export const POST_MAX_IMAGES = 10;

export const POST_TYPES = ['article', 'transformation'];
export const AUTHOR_TYPES = ['coach', 'member'];
export const MEDIA_TYPES = ['images', 'video'];
export const POST_STATUSES = ['uploading', 'published', 'removed', 'hidden'];
/** The frame shapes an item can be shown in. */
export const POST_ASPECT_RATIOS = ['original', '1:1', '4:5', '1.91:1', '9:16'];
export const CROP_MAX_ZOOM = 5;

/**
 * Where an item sits inside the post's frame. The file itself is never cut:
 * the app draws it covering the frame, scaled by `zoom` (1 = just covering)
 * and aligned by `x` / `y` (-1 = left/top edge, 0 = centre, 1 = right/bottom).
 */
const cropSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true, min: -1, max: 1 },
    y: { type: Number, required: true, min: -1, max: 1 },
    zoom: { type: Number, required: true, min: 1, max: CROP_MAX_ZOOM },
  },
  { _id: false },
);

/**
 * One slot of the post's media, created empty with the draft and filled by its
 * upload. Width, height and duration are what the app measured on the device;
 * they only size the frame before the file loads.
 */
const mediaSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    kind: { type: String, enum: ['image', 'video'], required: true },
    position: { type: Number, required: true, min: 0 },
    url: { type: String, default: null },
    storageKey: { type: String, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    // Video only.
    thumbnailUrl: { type: String, default: null },
    thumbnailStorageKey: { type: String, default: null },
    durationMs: { type: Number, default: null },
    // Null on posts made before cropping existed: shown at the media's own shape.
    // Each item has its own frame shape; a carousel may mix them.
    aspectRatio: { type: String, enum: [...POST_ASPECT_RATIOS, null], default: null },
    crop: { type: cropSchema, default: null },
  },
  { _id: false },
);

const postSchema = new mongoose.Schema(
  {
    authorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorType: { type: String, enum: AUTHOR_TYPES, required: true },
    authorCoachId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Coach',
      default: null,
      required() {
        return this.authorType === 'coach';
      },
    },
    type: { type: String, enum: POST_TYPES, required: true },
    title: { type: String, required: true, trim: true, maxlength: POST_TITLE_MAX },
    text: { type: String, required: true, trim: true, maxlength: POST_TEXT_MAX },
    mediaType: { type: String, enum: MEDIA_TYPES, required: true },
    media: { type: [mediaSchema], default: [] },
    /**
     * The ratio last applied to every item ("Apply to All") - the default for
     * items. Each item's own `aspectRatio` wins. Null on older posts.
     */
    aspectRatio: { type: String, enum: [...POST_ASPECT_RATIOS, null], default: null },
    status: { type: String, enum: POST_STATUSES, default: 'uploading' },
    likeCount: { type: Number, default: 0, min: 0 },
    publishedAt: { type: Date, default: null },
    editedAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },
    removedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** Sent by the app with a new draft, so a retried create returns the same draft. */
    clientRequestId: { type: String, default: undefined, trim: true },
  },
  { timestamps: true, versionKey: false, collection: 'posts' },
);

/** The Feed (all types), newest first. */
postSchema.index({ status: 1, publishedAt: -1, _id: -1 }, { name: 'post_status_published' });
/** The Feed filtered by type. */
postSchema.index({ status: 1, type: 1, publishedAt: -1, _id: -1 }, { name: 'post_status_type_published' });
/** An author's own posts. */
postSchema.index({ authorUserId: 1, status: 1, publishedAt: -1, _id: -1 }, { name: 'post_author_published' });
/** A retried draft create finds the first one. */
postSchema.index(
  { authorUserId: 1, clientRequestId: 1 },
  {
    unique: true,
    name: 'uniq_post_author_request',
    partialFilterExpression: { clientRequestId: { $type: 'string' } },
  },
);

export const Post = mongoose.model('Post', postSchema);
export default Post;
