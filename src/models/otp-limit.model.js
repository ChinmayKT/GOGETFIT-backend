import mongoose from 'mongoose';

/**
 * OTP request counters, shared by every API process (MongoDB, not memory).
 *
 *   phone:<normalized>       one document per phone identity: today's UTC day,
 *                            requests charged that day, last request time
 *                            (the resend cooldown).
 *   ip:<address>:<UTC hour>  requests from one address in one clock hour.
 *
 * Each is changed only by single-document atomic updates, so concurrent
 * requests - from any number of devices - cannot exceed a limit.
 */
const otpLimitSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    kind: { type: String, enum: ['phone', 'ip'], required: true },
    day: { type: String, default: null }, // "2026-11-20" (UTC), phone only
    count: { type: Number, default: 0 },
    lastRequestAt: { type: Date, default: null }, // phone only
    expireAt: { type: Date, required: true },
  },
  { versionKey: false },
);

// Idle counters are removed by MongoDB itself once they can no longer matter.
otpLimitSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expire_at' });

export const OtpLimit = mongoose.model('OtpLimit', otpLimitSchema, 'otplimits');
export default OtpLimit;
