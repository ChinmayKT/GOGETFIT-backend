import mongoose from 'mongoose';

/** One admin change of a month's capacity. */
const capacityChangeSchema = new mongoose.Schema(
  {
    from: { type: Number, default: null },
    to: { type: Number, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * A coach's capacity for one calendar month, and who changed it.
 *
 * Deliberately no booking counter: confirmed bookings are always counted from
 * the enrollments themselves (see coach-capacity.service.js), so there is
 * nothing here that can drift away from them. `confirmationSeq` is not a count
 * of anything useful - every booking transaction bumps it purely so that two
 * concurrent bookings for one coach write the same document, and MongoDB makes
 * one of them retry against the other's committed enrollment.
 *
 * Past months are never rewritten: an edit only ever touches the current month.
 */
const coachMonthlyCapacitySchema = new mongoose.Schema(
  {
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', required: true, immutable: true },
    /** YYYY-MM in the business timezone. */
    month: { type: String, required: true, immutable: true },
    capacity: { type: Number, required: true, min: 0 },
    confirmationSeq: { type: Number, default: 0 },
    changes: { type: [capacityChangeSchema], default: () => [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false, collection: 'coachmonthlycapacities' },
);

coachMonthlyCapacitySchema.index({ coachId: 1, month: 1 }, { unique: true, name: 'uniq_coach_month' });

export const CoachMonthlyCapacity = mongoose.model('CoachMonthlyCapacity', coachMonthlyCapacitySchema);
export default CoachMonthlyCapacity;
