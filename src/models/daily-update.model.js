import mongoose from 'mongoose';

/**
 * A member's Daily Update for one business day: what they entered (weight,
 * workout, steps) and what the app worked out from it, as last submitted.
 * One document per member per day - the unique { clientId, date } index
 * makes a second one impossible - so a resubmission the same day replaces
 * the values in place (createdAt kept, updatedAt moved on).
 *
 * Calorie In is the day's food log as it stood when submitted (the server
 * reads it; the app never sends it). Calorie Out's parts are the app's
 * calculation; the total and the energy balance are summed here, and only
 * when every part is there - an unavailable value is null, never 0.
 */

export const ENERGY_BALANCE_STATUSES = ['negative', 'neutral', 'positive'];

/** Successful Daily Update submissions a member may make per business day. */
export const DAILY_UPDATE_DAILY_SUBMISSIONS = 3;

const kcal = { type: Number, default: null, min: 0 };

const nutrientsSchema = new mongoose.Schema(
  {
    calories: { type: Number, required: true, min: 0 },
    protein: { type: Number, required: true, min: 0 },
    carbs: { type: Number, required: true, min: 0 },
    fat: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const dailyUpdateSchema = new mongoose.Schema(
  {
    /** The member (a User); always the token's, never sent by the app. */
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    /** The business day, YYYY-MM-DD in `timezone`. */
    date: { type: String, required: true, immutable: true },
    timezone: { type: String, required: true },
    /** The member's active enrollment when saved, with its coach and plan. */
    enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnrolledClient', default: null },
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', default: null },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'GogetfitPlan', default: null },
    /** Who the figures were worked out for - a snapshot; the profile stays the source of truth. */
    profile: {
      name: { type: String, default: null },
      gender: { type: String, enum: ['male', 'female', null], default: null },
      age: { type: Number, default: null },
      heightCm: { type: Number, default: null },
    },
    activity: {
      weightKg: { type: Number, required: true, min: 30, max: 250 },
      workoutMinutes: { type: Number, required: true, min: 0, max: 1440 },
      steps: { type: Number, required: true, min: 0, max: 200000 },
    },
    /** The day's food log totals and targets when submitted; null without a log. */
    calorieIn: {
      type: new mongoose.Schema(
        {
          consumed: { type: nutrientsSchema, required: true },
          targets: { type: nutrientsSchema, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    calorieOut: {
      bmr: kcal,
      tef: kcal,
      eat: kcal,
      neat: kcal,
      /** bmr + tef + eat + neat - only with all four. */
      total: kcal,
    },
    /** Calorie In − Calorie Out, only with both; status by its sign. */
    energyBalance: {
      kcal: { type: Number, default: null },
      status: { type: String, enum: [...ENERGY_BALANCE_STATUSES, null], default: null },
    },
    submittedAt: { type: Date, required: true },
    /** Successful submissions this day - never more than DAILY_UPDATE_DAILY_SUBMISSIONS. */
    submissionCount: { type: Number, min: 0 },
    /** The app's id for the last counted submission: a retry of it is not counted again. */
    lastSubmissionId: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

dailyUpdateSchema.index({ clientId: 1, date: 1 }, { unique: true, name: 'dailyupdate_client_day' });

export const DailyUpdate = mongoose.model('DailyUpdate', dailyUpdateSchema);

export default DailyUpdate;
