import mongoose from 'mongoose';

/**
 * A coach-assigned diet plan applied to a run of calendar days.
 * See docs/diet-plans-design.md.
 *
 * Migrated plans: a plan assigned to sparse days is several documents that
 * share `planId`, one per contiguous run. Plans created in the app are ONE
 * document; where the coach picked days with a gap, `selectedDates` lists the
 * exact days and the plan applies on those only (fromDate/toDate are then its
 * first and last). Without `selectedDates` it is every day from fromDate to
 * toDate. Either way a plan never appears on a day it was not assigned to. Where several documents of
 * one client cover the same day, the newest `assignedAt` wins - the legacy rule
 * (WorkoutDAL.GetDietPlanDetails: ORDER BY create_date DESC LIMIT 1).
 *
 * Each food assignment is a snapshot: `calories/fat/carbs/protein` describe
 * `portion` of the food, frozen when the food was assigned, and the member sees
 * `value / portion * qty`. Name, brand and image are read live from the Food.
 */

export const DIET_PLAN_MEALS = [1, 2, 3, 4, 5, 6, 7, 8];
export const DIET_PLAN_STATUSES = ['active', 'archived'];

const nonNegative = { type: Number, required: true, min: 0 };

const foodAssignmentSchema = new mongoose.Schema(
  {
    foodId: { type: mongoose.Schema.Types.ObjectId, ref: 'Food', required: true },
    /** The amount prescribed, in `servingUnit`. */
    qty: { type: Number, required: true, min: 0 },
    /** The serving size the four values below describe; the display divisor. */
    portion: { type: Number, required: true, min: 0 },
    /** The unit of `qty` and `portion`, frozen with them. */
    servingUnit: { type: String, required: true },
    calories: nonNegative,
    fat: nonNegative,
    carbs: nonNegative,
    protein: nonNegative,
  },
  { _id: false },
);

const mealSchema = new mongoose.Schema(
  {
    meal: { type: Number, required: true, enum: DIET_PLAN_MEALS },
    /** Array order is the display order. */
    foods: { type: [foodAssignmentSchema], default: [] },
  },
  { _id: false },
);

/**
 * The coach's targets for the day. Not derived from the foods. Migrated plans
 * carry `calories`; plans created in the app carry `dailyCalorieTarget` -
 * the same figure, never both rewritten into one.
 */
const targetsSchema = new mongoose.Schema(
  {
    calories: { type: Number, min: 0 },
    dailyCalorieTarget: { type: Number, min: 0 },
    fat: nonNegative,
    carbs: nonNegative,
    protein: nonNegative,
  },
  { _id: false },
);

/**
 * The daily intake a coach set for the client on this plan (Set Calorie
 * Intake) - separate from `targets`, the plan's own targets, which it never
 * rewrites. All four or none: a document either has the whole set or null.
 */
const coachGivenTargetsSchema = new mongoose.Schema(
  {
    calories: { type: Number, required: true, min: 0 },
    protein: { type: Number, required: true, min: 0 },
    carbs: { type: Number, required: true, min: 0 },
    fat: { type: Number, required: true, min: 0 },
    setAt: { type: Date, required: true },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false },
);

/** Provenance of a migrated document. Absent on plans created in the new app. */
const legacySchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    dietPlanId: { type: Number, required: true },
    /** m_diet_plan.created_by - an m_user.user_id, kept whether or not it resolved to a Coach. */
    createdBy: { type: Number, default: null },
    createDate: { type: Date, default: null },
    lastUpdateDate: { type: Date, default: null },
    /** Which of the plan's date runs this document is (0-based, by fromDate). */
    segment: {
      index: { type: Number, required: true },
      of: { type: Number, required: true },
    },
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

const dietPlanSchema = new mongoose.Schema(
  {
    /** The logical plan; shared by all of its date runs. "gogetfit:<legacy id>" when migrated. */
    planId: { type: String, required: true, trim: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    /** Only when the coaching cycle is proven; legacy plans were user/date driven. */
    enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnrolledClient', default: null },
    /** Only when the author is a proven Coach. */
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', default: null },
    name: { type: String, required: true },

    /** Start of the first business day (IST), inclusive. */
    fromDate: { type: Date, required: true },
    /** Start of the last business day (IST), inclusive. */
    toDate: { type: Date, required: true },
    /**
     * Only when the days picked have a gap: exactly those days (start of each
     * business day, ascending), first = fromDate, last = toDate. Absent for a
     * continuous run, and on every migrated plan.
     */
    selectedDates: { type: [Date], default: undefined },
    /** Precedence: on a shared day the newest wins. */
    assignedAt: { type: Date, required: true },

    /**
     * The client values this plan was calculated from, as the coach confirmed
     * them on Create Diet Plan (profile vocabulary: 'male', 'moderate'; cm,
     * kg, years). Plans created in the app only; absent on migrated ones.
     */
    gender: { type: String, enum: ['male', 'female'] },
    age: { type: Number, min: 0 },
    height: { type: Number, min: 0 },
    weight: { type: Number, min: 0 },
    activityLevel: { type: String },

    bmr: { type: Number, default: null },
    tdee: { type: Number, default: null },
    goal: { type: String, default: null },
    /**
     * The plan's own targets ("dietPlanTargets" in the API). Stored under its
     * original key so migrated and app-created plans need no rewrite.
     */
    targets: { type: targetsSchema, required: true },
    /** The coach's Set Calorie Intake for this plan, or null when not set. */
    coachGivenTargets: { type: coachGivenTargetsSchema, default: null },

    /** Ascending by meal; meals with no food are not stored. May be empty. */
    meals: { type: [mealSchema], default: [] },

    status: { type: String, enum: DIET_PLAN_STATUSES, default: 'active' },

    legacy: { type: legacySchema, default: undefined },
    migration: { type: migrationSchema, default: undefined },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false, collection: 'dietplans' },
);

dietPlanSchema.pre('validate', function checkRange() {
  if (this.fromDate && this.toDate && this.fromDate > this.toDate) {
    this.invalidate('toDate', 'toDate must not be before fromDate');
  }
  const meals = this.meals.map((m) => m.meal);
  if (new Set(meals).size !== meals.length) this.invalidate('meals', 'a meal may appear only once');
  if (this.targets && this.targets.calories == null && this.targets.dailyCalorieTarget == null) {
    this.invalidate('targets', 'targets need a calorie target');
  }
  const days = this.selectedDates;
  if (days && days.length) {
    const times = days.map((d) => d.getTime());
    const ascending = times.every((t, i) => i === 0 || t > times[i - 1]);
    if (!ascending || times[0] !== this.fromDate?.getTime() || times[times.length - 1] !== this.toDate?.getTime()) {
      this.invalidate('selectedDates', 'selectedDates must ascend from fromDate to toDate');
    }
  }
});

/** The member's day lookup: active plans of the client covering the day, newest assignment first. */
dietPlanSchema.index({ clientId: 1, fromDate: 1, toDate: 1, assignedAt: -1 }, { name: 'dietplan_client_range_assigned' });
dietPlanSchema.index({ planId: 1 }, { name: 'dietplan_planid' });
dietPlanSchema.index(
  { enrollmentId: 1, fromDate: 1 },
  { name: 'dietplan_enrollment_from', partialFilterExpression: { enrollmentId: { $type: 'objectId' } } },
);
dietPlanSchema.index(
  { coachId: 1, assignedAt: -1 },
  { name: 'dietplan_coach_assigned', partialFilterExpression: { coachId: { $type: 'objectId' } } },
);
/** Migration identity: one document per legacy plan date run. */
dietPlanSchema.index(
  { 'legacy.source': 1, 'legacy.dietPlanId': 1, 'legacy.segment.index': 1 },
  {
    unique: true,
    name: 'uniq_legacy_source_dietplan_segment',
    partialFilterExpression: { 'legacy.dietPlanId': { $type: 'number' } },
  },
);

/**
 * The plan a client sees on [day] (a Date at the start of the business day):
 * the newest assignment covering it. `planId` breaks a tie on assignedAt
 * deterministically - never _id, insertion order or updatedAt.
 */
dietPlanSchema.statics.findForDay = function findForDay(clientId, day) {
  return this.findOne({
    clientId,
    status: 'active',
    fromDate: { $lte: day },
    toDate: { $gte: day },
    // A plan with picked days applies on those only - never on its gaps.
    $or: [{ selectedDates: { $exists: false } }, { selectedDates: day }],
  }).sort({
    assignedAt: -1,
    planId: -1,
  });
};

export const DietPlan = mongoose.model('DietPlan', dietPlanSchema);
export default DietPlan;
