import mongoose from 'mongoose';

/**
 * A member's GoGetFit Coins - ONE document per member (unique clientId),
 * updated in place and kept across plans: coins once earned are never taken
 * away by a missed day or a plan ending. `totalEarned` only ever grows;
 * `balance` would fall only by spending (not part of the app yet).
 */
const coinsSchema = new mongoose.Schema(
  {
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    /** The plan of the last reward (context only). */
    enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnrolledClient', default: null },
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', default: null },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'GogetfitPlan', default: null },
    balance: { type: Number, default: 0, min: 0 },
    totalEarned: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'gogetfitcoins' },
);

coinsSchema.index({ clientId: 1 }, { unique: true, name: 'gogetfitcoins_client' });

export const GoGetFitCoins = mongoose.model('GoGetFitCoins', coinsSchema);
export default GoGetFitCoins;
