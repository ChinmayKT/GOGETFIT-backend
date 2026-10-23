import mongoose from 'mongoose';

/**
 * A member's GoGetFit streak - ONE document per member (unique clientId),
 * updated in place. `currentStreak` is the number of distinct plan days with
 * a submitted Daily Update: cumulative, never reset by a missed day, never
 * more than the plan's `planDays`. The plan fields are the enrollment the
 * last counted day belonged to; a day of a different enrollment starts that
 * plan's count again (see rewards.service).
 */
const streakSchema = new mongoose.Schema(
  {
    /** The member (a User) - here the client is the user. */
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnrolledClient', default: null },
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', default: null },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'GogetfitPlan', default: null },
    /** Business days (YYYY-MM-DD, Asia/Kolkata) the plan runs. */
    planStartDate: { type: String, default: null },
    planEndDate: { type: String, default: null },
    /** The plan's length in days (its weeks × 7): the most currentStreak can reach. */
    planDays: { type: Number, default: null, min: 0 },
    /** Distinct plan days completed so far (not consecutive). */
    currentStreak: { type: Number, default: 0, min: 0 },
    /** The last day that counted. */
    lastUpdatedDate: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'streaks' },
);

streakSchema.index({ clientId: 1 }, { unique: true, name: 'streak_client' });

export const Streak = mongoose.model('Streak', streakSchema);
export default Streak;
