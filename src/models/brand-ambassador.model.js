import mongoose from 'mongoose';

/**
 * Brand Ambassador programme. Four collections, all keyed back to the existing
 * User / EnrolledClient / GogetfitPlan records, which stay the source of truth.
 * See docs/brand-ambassador.md.
 */

const { ObjectId } = mongoose.Schema.Types;

export const AMBASSADOR_STATUSES = ['active', 'inactive'];
export const REFERRAL_STATUSES = ['pending', 'successful'];
export const COMMISSION_STATUSES = ['pending', 'paid'];

// ─── brand_ambassador_coupons ────────────────────────────────────────────────

/**
 * One ambassador registration and the coupon it owns. Personal details are
 * read from the User through userId, never copied here. The code and the
 * discount/commission terms are fixed at registration and never regenerated,
 * not even after a name change.
 */
const ambassadorCouponSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    couponCode: { type: String, required: true, trim: true, uppercase: true, immutable: true },
    discountType: { type: String, enum: ['percentage'], default: 'percentage' },
    discountValue: { type: Number, required: true, min: 0, max: 100 },
    commissionType: { type: String, enum: ['percentage'], default: 'percentage' },
    commissionValue: { type: Number, required: true, min: 0, max: 100 },
    status: { type: String, enum: AMBASSADOR_STATUSES, default: 'active' },
  },
  { timestamps: true, versionKey: false, collection: 'brand_ambassador_coupons' },
);

ambassadorCouponSchema.index({ couponCode: 1 }, { unique: true, name: 'uniq_coupon_code' });
// One ambassador profile per user (initial release). Records are never deleted,
// so this also covers "one active profile per user".
ambassadorCouponSchema.index({ userId: 1 }, { unique: true, name: 'uniq_user' });
ambassadorCouponSchema.index({ status: 1, createdAt: -1 }, { name: 'status_created' });

// ─── brand_ambassador_referrals ──────────────────────────────────────────────

const statusChangeSchema = new mongoose.Schema(
  {
    status: { type: String, enum: REFERRAL_STATUSES, required: true },
    at: { type: Date, required: true },
    actorId: { type: ObjectId, ref: 'User', default: null },
    reason: { type: String, default: null },
  },
  { _id: false },
);

/**
 * One purchase attributed to an ambassador. The order (EnrolledClient), the
 * customer (User) and the plan stay the source of truth; what is stored here is
 * the reference plus the figures as they were at purchase, which money must not
 * recompute later. The commission fields make this collection the commission
 * ledger: one line per referral, settled into a monthly payout period.
 */
const referralSchema = new mongoose.Schema(
  {
    ambassadorCouponId: { type: ObjectId, ref: 'BrandAmbassadorCoupon', required: true, immutable: true },
    ambassadorUserId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    couponCode: { type: String, required: true, immutable: true },
    referredUserId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    orderId: { type: ObjectId, ref: 'EnrolledClient', required: true, immutable: true },
    planId: { type: ObjectId, ref: 'GogetfitPlan', required: true, immutable: true },
    planNameSnapshot: { type: String, default: null, immutable: true },
    originalPlanAmount: { type: Number, required: true, immutable: true },
    discountPercent: { type: Number, required: true, immutable: true },
    discountAmount: { type: Number, required: true, immutable: true },
    finalPaidAmount: { type: Number, required: true, immutable: true },
    currency: { type: String, required: true, immutable: true },
    paymentId: { type: String, default: null, immutable: true },
    paymentStatus: { type: String, default: null },
    /**
     * How the payment behind this referral was confirmed. 'simulated' = the
     * app's own purchase call marked it Success (no gateway exists yet);
     * 'gateway' is reserved for a verified gateway webhook.
     */
    paymentVerification: { type: String, enum: ['simulated', 'gateway'], default: 'simulated' },
    referralStatus: { type: String, enum: REFERRAL_STATUSES, required: true },
    statusHistory: { type: [statusChangeSchema], default: [] },
    purchasedAt: { type: Date, required: true, immutable: true },

    // Commission ledger line - the rate and amounts as applied, never recomputed.
    commissionPercent: { type: Number, required: true, immutable: true },
    grossCommission: { type: Number, required: true, immutable: true },
    tdsPercent: { type: Number, required: true, immutable: true },
    tdsAmount: { type: Number, required: true, immutable: true },
    netCommission: { type: Number, required: true, immutable: true },
    commissionStatus: { type: String, enum: COMMISSION_STATUSES, default: 'pending' },
    /** 'YYYY-MM' in the business timezone: paid out by the 7th of the next month. */
    payoutPeriod: { type: String, required: true, immutable: true },
    payoutReference: { type: String, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'brand_ambassador_referrals' },
);

// One order can produce one referral, whatever retries or duplicate payment
// events arrive. Enforced by the database.
referralSchema.index({ orderId: 1 }, { unique: true, name: 'uniq_order' });
referralSchema.index({ ambassadorCouponId: 1, referralStatus: 1, purchasedAt: -1 }, { name: 'ambassador_status_date' });

// ─── brand_ambassador_sequences ──────────────────────────────────────────────

/** The next four-digit suffix per prefix: { _id: 'CHI', seq: 1 }. Allocated with an atomic $inc. */
const sequenceSchema = new mongoose.Schema(
  { _id: { type: String, required: true }, seq: { type: Number, default: 0 } },
  { versionKey: false, collection: 'brand_ambassador_sequences' },
);

// ─── brand_ambassador_payouts ────────────────────────────────────────────────

export const PAYOUT_STATUSES = ['processing', 'paid'];

/**
 * A payout an admin recorded for one ambassador and one month. Recording
 * 'paid' settles that month's commission lines (commissionStatus -> paid).
 * This records money sent outside the system; nothing here sends money.
 */
const payoutSchema = new mongoose.Schema(
  {
    ambassadorCouponId: { type: ObjectId, ref: 'BrandAmbassadorCoupon', required: true, immutable: true },
    period: { type: String, required: true, immutable: true },
    amount: { type: Number, required: true, min: 0 },
    paidAt: { type: Date, required: true },
    reference: { type: String, required: true, trim: true },
    status: { type: String, enum: PAYOUT_STATUSES, required: true },
    recordedBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false, collection: 'brand_ambassador_payouts' },
);

payoutSchema.index({ ambassadorCouponId: 1, period: 1 }, { unique: true, name: 'uniq_ambassador_period' });

// ─── brand_ambassador_activities ─────────────────────────────────────────────

/** Append-only audit trail. Nothing in the API updates or deletes these. */
const activitySchema = new mongoose.Schema(
  {
    ambassadorCouponId: { type: ObjectId, ref: 'BrandAmbassadorCoupon', required: true, immutable: true },
    entityType: { type: String, enum: ['ambassador', 'referral'], required: true, immutable: true },
    entityId: { type: ObjectId, required: true, immutable: true },
    action: { type: String, required: true, immutable: true },
    detail: { type: String, default: null, immutable: true },
    actorId: { type: ObjectId, ref: 'User', default: null, immutable: true },
    actorRole: { type: String, enum: ['system', 'member', 'admin'], required: true, immutable: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    after: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    at: { type: Date, required: true, immutable: true },
  },
  { versionKey: false, collection: 'brand_ambassador_activities' },
);

activitySchema.index({ ambassadorCouponId: 1, at: -1 }, { name: 'ambassador_at' });

export const BrandAmbassadorCoupon = mongoose.model('BrandAmbassadorCoupon', ambassadorCouponSchema);
export const BrandAmbassadorReferral = mongoose.model('BrandAmbassadorReferral', referralSchema);
export const BrandAmbassadorSequence = mongoose.model('BrandAmbassadorSequence', sequenceSchema);
export const BrandAmbassadorActivity = mongoose.model('BrandAmbassadorActivity', activitySchema);
export const BrandAmbassadorPayout = mongoose.model('BrandAmbassadorPayout', payoutSchema);
