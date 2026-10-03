import mongoose from 'mongoose';

/**
 * The Workout master: one document per exercise, which is what the Add Workout
 * form captures and what a workout plan refers to.
 *
 * The new home of legacy `m_workout` (see docs/workouts-legacy.md). Legacy kept
 * everything in one table with no create date, no real audit trail and a
 * delete flag nothing ever wrote; this keeps the business shape and replaces
 * those with the project's own conventions.
 *
 * A workout is referenced by plans - 175 of the 188 legacy workouts already are
 * - so a workout is archived, never deleted.
 */

/** Legacy workout_type, verbatim. Hardcoded in the legacy view; no lookup table ever existed. */
export const WORKOUT_TYPES = ['Gym', 'Home', 'General'];

/**
 * Legacy equipment values, verbatim - including "Pair of Dumbells", which the
 * legacy form has always spelled with one "b" and 35 rows are stored under.
 * The stored value is legacy truth; a screen is free to label it correctly.
 */
export const WORKOUT_EQUIPMENT = ['Gym Equipment', 'Pair of Dumbells', 'Resistance Band', 'Body Weight'];

/**
 * Legacy stored "LEVEL 1".."LEVEL 5" as text. Here it is the number, which is
 * what the portal's own WorkoutLevel type already uses and what sorting needs.
 */
export const WORKOUT_LEVELS = [1, 2, 3, 4, 5];

/** active = selectable; archived = kept for the plans that reference it, hidden by default. */
export const WORKOUT_STATUSES = ['active', 'archived'];

/** "LEVEL 3" -> 3. Returns null for anything that is not one of the five legacy levels. */
export const parseWorkoutLevel = (value) => {
  if (typeof value === 'number') return WORKOUT_LEVELS.includes(value) ? value : null;
  const match = /^\s*level\s*([1-5])\s*$/i.exec(String(value ?? ''));
  return match ? Number(match[1]) : null;
};

/**
 * A stored file: where it is served from and the storage driver's key for it.
 * Never the bytes, and never a bare legacy filename.
 */
const mediaRefSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    storageKey: { type: String, required: true },
  },
  { _id: false },
);

/**
 * The only legacy information a migrated workout keeps: which system it came
 * from and its id there. Absent on workouts created in the portal.
 */
const legacySchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    workoutId: { type: Number, required: true },
  },
  { _id: false },
);

/** Which migration run wrote a migrated workout. Absent on portal workouts. */
const migrationSchema = new mongoose.Schema(
  {
    runId: { type: String, default: null },
    migratedAt: { type: Date, default: null },
    version: { type: Number, default: null },
  },
  { _id: false },
);

const workoutSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    // --- classification ---
    type: { type: String, enum: WORKOUT_TYPES, required: true },
    equipment: { type: String, enum: WORKOUT_EQUIPMENT, required: true },
    /**
     * Free text, exactly as legacy held it. Not an enum: the stored values mix
     * a muscle with a training phase ("Back (Cool Down)", "Legs (Warm Up)") and
     * 117 distinct secondary values exist. An enum would have to discard them.
     */
    primaryMuscle: { type: String, required: true, trim: true },
    secondaryMuscle: { type: String, default: null, trim: true },
    /** Required: every one of the 188 legacy workouts has a level, and the form always sends one. */
    level: { type: Number, enum: WORKOUT_LEVELS, required: true },

    // --- content ---
    description: { type: String, required: true },

    // --- media ---
    /** The demo clip on YouTube, when there is one. Independent of the uploaded video. */
    youtubeUrl: { type: String, default: null, trim: true },
    /** The uploaded .mp4, set only through the workout video endpoints. */
    video: { type: mediaRefSchema, default: null },
    /** The video's poster image, set only through the workout thumbnail endpoints. */
    thumbnail: { type: mediaRefSchema, default: null },

    /**
     * Archive-not-delete. Legacy had a delete_flg that no code ever wrote and
     * the list ignored; here the flag finally means something, and the document
     * survives so plan history keeps resolving.
     */
    status: { type: String, enum: WORKOUT_STATUSES, default: 'active' },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    legacy: { type: legacySchema, default: undefined },
    migration: { type: migrationSchema, default: () => ({}) },

    /**
     * The real admin who created and last changed this workout. Legacy wrote
     * the literal string "123" into created_by on all 188 rows, which maps to
     * no user at all; the migration resolves an actual admin instead.
     */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false, collection: 'workouts' },
);

/**
 * Migration identity: re-running the migration finds the same document instead
 * of adding a second one. Partial, so workouts created in the portal (which
 * have no legacy block) are unaffected.
 *
 * Deliberately NOT unique: the name. Legacy has no unique constraint on it and
 * nothing in the application ever checked for a duplicate.
 */
workoutSchema.index(
  { 'legacy.source': 1, 'legacy.workoutId': 1 },
  {
    unique: true,
    name: 'uniq_legacy_source_workoutid',
    partialFilterExpression: { 'legacy.workoutId': { $exists: true, $type: 'number' } },
  },
);

/** The default list: active workouts by name. */
workoutSchema.index({ status: 1, name: 1 }, { name: 'workout_status_name' });
/** The filters the admin list offers. */
workoutSchema.index({ type: 1, equipment: 1, level: 1 }, { name: 'workout_classification' });
/** Name search. */
workoutSchema.index({ name: 1 }, { name: 'workout_name' });

export const Workout = mongoose.model('Workout', workoutSchema);
export default Workout;
