import mongoose from 'mongoose';

/**
 * OTP challenges are stored separately from the user so that an unknown phone
 * can be challenged without creating a user record first (spec section 12).
 * Only a keyed hash of the code is persisted - never the code itself.
 */
const otpSchema = new mongoose.Schema(
  {
    phoneNormalized: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },
    salt: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

// Expired challenges are removed by MongoDB itself.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expires_at' });
otpSchema.index({ phoneNormalized: 1, consumedAt: 1, expiresAt: -1 }, { name: 'lookup_active' });

export const Otp = mongoose.model('Otp', otpSchema);
export default Otp;
