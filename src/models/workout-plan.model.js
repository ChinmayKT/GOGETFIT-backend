import mongoose from 'mongoose';

/**
 * A coach-assigned workout plan: ONE document per plan, its blocks and each
 * block's exercises embedded, and the exact calendar days it applies on.
 * See docs/workout-plans-design.md (and docs/workout-plans-migration-audit.md
 * for the legacy source).
 *
 * Days: `selectedDates` holds every assigned day - the start of each
 * business day (IST), ascending, no repeats, gaps preserved; there is no
 * recurrence. `fromDate`/`toDate` are its first and last day (both null for
 * a plan with no days, which applies on none). Where several plans of one
 * client share a day, the newest `assignedAt` wins - the legacy rule
 * (WorkoutDAL: ORDER BY create_date DESC LIMIT 1).
 *
 * Each exercise keeps the prescription exactly as written (`setsRaw`,
 * `repsRaw` - "12-15", "15sec") beside what could be safely read from it
 * (`sets`, `measure`, `amount`, `amountMax`, each null when it could not).
 * The exercise itself is a reference to the Workout master, archived ones
 * included; `name` is a snapshot for display when the reference is gone.
 */

/** New plans hold at most this many blocks (the app's Add Workout screen). */
export const WORKOUT_PLAN_MAX_BLOCKS = 8;
export const WORKOUT_PLAN_STATUSES = ['active', 'archived'];
export const WORKOUT_MEASURES = ['reps', 'time'];
export const WORKOUT_NOTE_MAX = 100;

const intOrNull = { type: Number, default: null, min: 0, validate: { validator: (v) => v == null || Number.isInteger(v), message: '{PATH} must be a whole number' } };

const exerciseSchema = new mongoose.Schema(
  {
    /** The Workout master entry; null only on a migrated row whose exercise no longer exists. */
    workoutId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workout', default: null },
    /** m_workout.workout_id, on migrated rows. */
    legacyWorkoutId: { type: Number, default: null },
    /** Display name as known when written - the fallback when workoutId is gone. */
    name: { type: String, default: null },
    /** Exactly as written (legacy varchar(5), trailing spaces and all). */
    setsRaw: { type: String, default: null },
    repsRaw: { type: String, default: null },
    /** Read from the raw text only when it is unambiguous; otherwise null. */
    sets: intOrNull,
    measure: { type: String, enum: [...WORKOUT_MEASURES, null], default: null },
    /** Reps, or seconds when measure is 'time'; amountMax closes a range ("12-15"). */
    amount: intOrNull,
    amountMax: intOrNull,
    /** The coach's note; legacy plans had none. */
    note: { type: String, default: null, maxlength: WORKOUT_NOTE_MAX },
  },
  { _id: false },
);

exerciseSchema.pre('validate', function checkExercise() {
  if (!this.workoutId && this.legacyWorkoutId == null) {
    this.invalidate('workoutId', 'an exercise needs a workoutId (or, migrated, a legacyWorkoutId)');
  }
  if (this.amountMax != null && (this.amount == null || this.amountMax < this.amount)) {
    this.invalidate('amountMax', 'amountMax closes a range: it needs an amount at most itself');
  }
  if (this.amount != null && this.measure == null) this.invalidate('measure', 'an amount needs its measure');
});

const blockSchema = new mongoose.Schema(
  {
    /** Stable within the plan: "gogetfit:cat:<legacy category id>" when migrated. */
    blockId: { type: String, required: true, trim: true },
    /** m_workout_category.workout_category_id, on migrated blocks (deep-copied per plan). */
    legacyCategoryId: { type: Number, default: null },
    /** As the coach named it, verbatim. */
    name: { type: String, required: true },
    /** Display order, 0-based; unique within the plan. */
    order: { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'order must be a whole number' } },
    /** Display order is the array order. */
    exercises: { type: [exerciseSchema], default: [] },
  },
  { _id: false },
);

/** Provenance of a migrated plan. Absent on plans created in the new app. */
const legacySchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    /** m_workout_plan.workout_plan_id */
    workoutPlanId: { type: Number, required: true },
    /** m_workout_plan.user_id - the client, kept whether or not it resolved. */
    clientId: { type: Number, default: null },
    /** m_workout_plan.created_by - kept whether or not it resolved to a Coach. */
    createdBy: { type: Number, default: null },
    /**
     * Where coachId came from: 'creator' - the plan's author, verified as in
     * the diet-plan migration; else the client's coach in the old app
     * ('client_enrollment' covering the plan's day, or 'client_only_coach');
     * null when unresolved.
     */
    coachSource: { type: String, enum: ['client_enrollment', 'client_only_coach', 'creator', null], default: null },
    createDate: { type: Date, default: null },
    lastUpdateDate: { type: Date, default: null },
  },
  { _id: false },
);

const migrationSchema = new mongoose.Schema(
  {
    runId: { type: String, default: null },
    migratedAt: { type: Date, default: null },
    version: { type: Number, default: null },
  },
  { _id: false },
);

const workoutPlanSchema = new mongoose.Schema(
  {
    /** "gogetfit:<legacy id>" when migrated. */
    planId: { type: String, required: true, trim: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    /** Only when the author is a proven Coach. */
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', default: null },
    /** Only when the coaching cycle is proven; legacy plans were user/date driven. */
    enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnrolledClient', default: null },
    /** Verbatim. */
    name: { type: String, required: true },

    blocks: { type: [blockSchema], default: [] },

    /** Every assigned day: start of each business day (IST), ascending, distinct. */
    selectedDates: { type: [Date], default: [] },
    /** First and last of selectedDates; null with no days. */
    fromDate: { type: Date, default: null },
    toDate: { type: Date, default: null },
    /** Precedence: on a shared day the newest wins (legacy: the plan's create_date). */
    assignedAt: { type: Date, required: true },

    status: { type: String, enum: WORKOUT_PLAN_STATUSES, default: 'active' },

    legacy: { type: legacySchema, default: undefined },
    migration: { type: migrationSchema, default: undefined },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false, collection: 'workoutplans' },
);

workoutPlanSchema.pre('validate', function checkPlan() {
  // New plans: the app's limit. Migrated plans keep every block they had -
  // never truncated here; one over the limit is reported for a decision.
  if (!this.legacy && this.blocks.length > WORKOUT_PLAN_MAX_BLOCKS) {
    this.invalidate('blocks', `a plan holds at most ${WORKOUT_PLAN_MAX_BLOCKS} blocks`);
  }
  const orders = this.blocks.map((b) => b.order);
  if (new Set(orders).size !== orders.length) this.invalidate('blocks', 'block order must be unique');
  const ids = this.blocks.map((b) => b.blockId);
  if (new Set(ids).size !== ids.length) this.invalidate('blocks', 'blockId must be unique within the plan');

  const days = this.selectedDates ?? [];
  const times = days.map((d) => d.getTime());
  if (!times.every((t, i) => i === 0 || t > times[i - 1])) {
    this.invalidate('selectedDates', 'selectedDates must be ascending with no repeats');
  }
  if (times.length) {
    if (this.fromDate?.getTime() !== times[0] || this.toDate?.getTime() !== times[times.length - 1]) {
      this.invalidate('fromDate', 'fromDate/toDate must be the first and last selected dates');
    }
  } else if (this.fromDate != null || this.toDate != null) {
    this.invalidate('fromDate', 'a plan with no selected dates has no fromDate/toDate');
  }
});

/** Migrated plans: one document per legacy plan, ever - re-runs cannot duplicate. */
workoutPlanSchema.index(
  { 'legacy.source': 1, 'legacy.workoutPlanId': 1 },
  {
    name: 'uniq_legacy_source_workoutplan',
    unique: true,
    partialFilterExpression: { 'legacy.workoutPlanId': { $exists: true, $type: 'number' } },
  },
);
/** The member's day lookup: the client's active plans on a day, newest first. */
workoutPlanSchema.index({ clientId: 1, selectedDates: 1, assignedAt: -1 }, { name: 'workoutplan_client_day_assigned' });
workoutPlanSchema.index({ planId: 1 }, { name: 'workoutplan_planid' });
workoutPlanSchema.index(
  { coachId: 1, assignedAt: -1 },
  { name: 'workoutplan_coach_assigned', partialFilterExpression: { coachId: { $type: 'objectId' } } },
);

/**
 * The ONE plan a client sees on [day] (the start of that business day): an
 * active plan with that exact day selected; where several have it, the
 * newest assignedAt (then the higher legacy id, then the newer document) -
 * so a plan never shows on a day it was not given.
 */
workoutPlanSchema.statics.findForDay = function findForDay(clientId, day) {
  return this.findOne({ clientId, status: 'active', selectedDates: day }).sort({
    assignedAt: -1,
    'legacy.workoutPlanId': -1,
    _id: -1,
  });
};

export const WorkoutPlan = mongoose.model('WorkoutPlan', workoutPlanSchema);
export default WorkoutPlan;
