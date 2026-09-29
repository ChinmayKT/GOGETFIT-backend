import mongoose from 'mongoose';

/** Coach tiers, from Level 1 (entry) to Level 5 (most senior). */
export const COACH_LEVELS = ['LEVEL 1', 'LEVEL 2', 'LEVEL 3', 'LEVEL 4', 'LEVEL 5'];

/**
 * Whether the coach profile is currently in use. Belongs to the coach profile
 * only: User.status stays the account's own status.
 */
export const COACH_STATUSES = ['active', 'inactive'];

/**
 * A stored image: where it is served from and the storage driver's key for it.
 * Only the reference is kept in MongoDB, never the bytes.
 */
const imageRefSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    storageKey: { type: String, required: true },
  },
  { _id: false },
);

/**
 * Coach-specific fields only.
 *
 * Deliberately absent, because they already live on the User the coach points
 * at: name, gender, email, phone and city. The coach screens read those through
 * userId instead of keeping a second copy that could drift.
 *
 * profilePicture is the coach's OWN professional photo, independent of the
 * user's avatar (User.profile.profilePicture): neither is ever copied into the
 * other, and changing one never touches the other. Both pictures are null until
 * an admin uploads one, which is also how coaches created before this field
 * existed read back.
 */
const coachProfileSchema = new mongoose.Schema(
  {
    profilePicture: { type: imageRefSchema, default: null },
    coverPicture: { type: imageRefSchema, default: null },
    level: { type: String, enum: COACH_LEVELS, required: true },
    specialization: { type: String, default: null, trim: true },
    /** The coach's bio. */
    description: { type: String, default: null, trim: true },
    languages: { type: [String], default: () => [] },
    facebook: { type: String, default: null, trim: true },
    instagram: { type: String, default: null, trim: true },
    linkedin: { type: String, default: null, trim: true },
    /** Display figure shown on the coach's profile. */
    transformations: { type: Number, default: 0, min: 0 },
    /** Display figure shown on the coach's profile. */
    availableSlots: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

/**
 * A coach profile. Identity, login and the basic profile stay on the User; this
 * document holds only what makes that user a coach.
 *
 * Creating one also adds "coach" to User.roles, in the same transaction - see
 * coach.service.js.
 */
const coachSchema = new mongoose.Schema(
  {
    /** Set at creation and never changed afterwards. */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    profile: { type: coachProfileSchema, required: true },
    status: { type: String, enum: COACH_STATUSES, default: 'active' },
    /** The authenticated administrator, never a value supplied by the browser. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
);

// One user = one coach profile. Hard database constraint, not just a service check.
coachSchema.index({ userId: 1 }, { unique: true, name: 'uniq_coach_userid' });

// The portal list: filter by status, newest first.
coachSchema.index({ status: 1, createdAt: -1 }, { name: 'coach_status_createdat' });

export const Coach = mongoose.model('Coach', coachSchema);
export default Coach;
