import mongoose from 'mongoose';

/**
 * A member's food log for one business day (Intake): what they ate, meal by
 * meal, as they last submitted it. One document per member per day - the
 * unique { clientId, logDate } index makes a second one impossible - and a
 * new day is simply a new document: no log is ever cleared or deleted at
 * midnight.
 *
 * Each entry keeps the food's nutrition as it was when first logged (for
 * `portion` of `servingUnit`), exactly like a diet plan's food snapshot, so a
 * later edit to the Food database never rewrites history. What an entry
 * contributes is `value / portion * qty`. The targets the day was measured
 * against are snapshotted too, with where they came from.
 */

export const FOOD_LOG_MEALS = [1, 2, 3, 4, 5, 6, 7, 8];

/** Successful Intake submissions a member may make per business day. */
export const FOOD_LOG_DAILY_SUBMISSIONS = 3;

const nonNegative = { type: Number, required: true, min: 0 };

const entrySchema = new mongoose.Schema(
  {
    /** Made by the app when the food was added; stable across submissions. */
    entryId: { type: String, required: true },
    foodId: { type: mongoose.Schema.Types.ObjectId, ref: 'Food', required: true },
    /**
     * The food's name when it was logged - kept with the snapshot so a log
     * reads on its own (in the database too); a later rename does not change
     * it. Display uses the Food's current name.
     */
    foodName: { type: String, default: null },
    /** The amount eaten, in `servingUnit`. */
    qty: { type: Number, required: true, min: 0 },
    /** The serving size the four values below describe. */
    portion: { type: Number, required: true, min: 0 },
    servingUnit: { type: String, required: true },
    calories: nonNegative,
    fat: nonNegative,
    carbs: nonNegative,
    protein: nonNegative,
  },
  { _id: false },
);

/** A stored file: its public URL and the storage driver's key for it. */
const imageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    storageKey: { type: String, required: true },
  },
  { _id: false },
);

const mealSchema = new mongoose.Schema(
  {
    meal: { type: Number, required: true, enum: FOOD_LOG_MEALS },
    /** At most one photo of the meal as a whole, or null. */
    image: { type: imageSchema, default: null },
    /**
     * The meal's foods; array order is the display order. Logs saved before
     * this was renamed hold them in `entries` instead - read through
     * mealFoodsOf, never directly.
     */
    foods: { type: [entrySchema], default: [] },
  },
  { _id: false },
);

/**
 * A stored meal's foods, whichever name they were saved under: `foods`, or
 * `entries` on a log saved before the rename. Never both added together -
 * every write replaces the meals whole, so a meal written since the rename
 * has no `entries` at all.
 */
export const mealFoodsOf = (meal) =>
  Array.isArray(meal?.foods) && meal.foods.length ? meal.foods : (meal?.entries ?? meal?.foods ?? []);

const nutrientsSchema = new mongoose.Schema(
  {
    calories: { type: Number, required: true },
    fat: { type: Number, required: true },
    carbs: { type: Number, required: true },
    protein: { type: Number, required: true },
  },
  { _id: false },
);

const foodLogSchema = new mongoose.Schema(
  {
    /** The member (a User) - always the authenticated one, never the request's. */
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    /** The business day, YYYY-MM-DD in `timezone`. */
    logDate: { type: String, required: true, immutable: true },
    timezone: { type: String, required: true },

    /** The diet plan the member followed that day, when there was one. */
    dietPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'DietPlan', default: null },
    planId: { type: String, default: null },
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', default: null },
    enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnrolledClient', default: null },

    /** The daily targets at the last submission, and their source. */
    targets: { type: nutrientsSchema, default: null },
    targetsSource: { type: String, enum: ['coach', 'plan', 'member', null], default: null },
    /** Computed by the server from the entries - never sent by the app. */
    consumed: { type: nutrientsSchema, required: true },
    /** targets - consumed (negative once a target is passed); null without targets. */
    remaining: { type: nutrientsSchema, default: null },

    /** Ascending by meal; meals with no food are not stored. */
    meals: { type: [mealSchema], default: [] },

    status: { type: String, enum: ['open'], default: 'open' },
    submittedAt: { type: Date, required: true },
    /**
     * Successful submissions this day - never more than
     * FOOD_LOG_DAILY_SUBMISSIONS (the save itself refuses a fourth). A log
     * saved before the limit existed has none (read as 0).
     */
    submissionCount: { type: Number, min: 0 },
    /** The app's id for the last counted submission: a retry of it is not counted again. */
    lastSubmissionId: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'foodlogs' },
);

foodLogSchema.index({ clientId: 1, logDate: 1 }, { unique: true, name: 'foodlog_client_day' });

export const FoodLog = mongoose.model('FoodLog', foodLogSchema);
export default FoodLog;
