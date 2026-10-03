import mongoose from 'mongoose';

import { LEGACY_SOURCE } from './user.model.js';

/**
 * Where an enrollment came from, for rows created by the application. Migrated
 * rows carry no `source` (their origin is the `legacy` block) - it is never
 * backfilled onto them.
 */
export const ENROLLMENT_SOURCE_ADMIN_MANUAL = 'admin_manual';

/** How a manually recorded payment was collected. Gateway payments carry none. */
export const PAYMENT_METHODS = ['cash', 'upi', 'bank_transfer', 'other'];

/**
 * One enrollment: a member bought one plan, once, with one coach and one
 * payment. The new home of legacy `t_enrollment` joined to `t_payment` on
 * `transaction_id`. See docs/enrolledclients-legacy.md for the column-by-column
 * discovery this was built from.
 *
 * A member has as many of these documents as they have purchases - there is no
 * "client" document per user and no array on the User. The User stays the
 * canonical person; this is the relationship they entered into.
 *
 * Relationships are ObjectId references, never copies: the plan's name, the
 * coach's name and the member's phone are joined for display, exactly as every
 * legacy read joined for them. What IS stored here is what the purchase itself
 * recorded and nothing else can reproduce - the amount charged, the billing
 * identity as it was typed, the coupon code as it was entered.
 */

/**
 * The payment that bought this enrollment, from `t_payment`. Flattened onto the
 * document rather than made its own collection: the legacy relationship is 1:1
 * through `transaction_id`, and no read ever wanted a payment on its own.
 */
const paymentSchema = new mongoose.Schema(
  {
    /**
     * t_payment.transaction_id - the gateway id, and the legacy join key.
     *
     * Required for every gateway/migrated payment. An admin-recorded manual
     * payment has no gateway id and none is ever invented for it: its receipt,
     * UTR or bank reference goes in `referenceId` instead.
     */
    transactionId: {
      type: String,
      trim: true,
      default: undefined,
      required() {
        return this.ownerDocument?.()?.source !== ENROLLMENT_SOURCE_ADMIN_MANUAL;
      },
    },
    /** t_payment.amount - what was actually charged. Whole rupees, as the legacy int column held it. */
    amount: { type: Number, default: null },
    currency: { type: String, default: null, trim: true },
    /**
     * t_payment.original_amount and discount_percent, verbatim.
     *
     * Both are 0 on every migrated row: the legacy checkout never sent them,
     * even where a coupon code was recorded. Kept as the zeros they are so that
     * nobody later mistakes a back-computed figure for legacy truth.
     *
     * On an admin manual enrollment the server sets them itself:
     *   originalAmount  = the plan's base price before any discount
     *   discountPercent = the applied coupon's percentage (0 without a coupon)
     *   amount          = what the admin actually received
     * The price due is originalAmount minus the truncated discount (the legacy
     * rule); `amount` may differ from it and is recorded as received.
     */
    originalAmount: { type: Number, default: null },
    discountPercent: { type: Number, default: null },
    /** t_payment.status. 'Success' is the only value the legacy data has ever held. */
    status: { type: String, default: null, trim: true },
    paidAt: { type: Date, default: null },
    /**
     * Gateway reference and description. Null on every migrated row, kept because the columns exist.
     * A manual payment's receipt / UTR / bank reference is stored in referenceId.
     */
    referenceId: { type: String, default: null, trim: true },
    description: { type: String, default: null },
    /** Manual payments only: how the money was collected. Absent on gateway/migrated rows. */
    method: { type: String, enum: PAYMENT_METHODS, default: undefined },
    /** Manual payments only: the admin's note. */
    notes: { type: String, default: undefined, trim: true },
    /**
     * The billing identity as entered at checkout. A historical fact about the
     * purchase: the member's profile today may say something different.
     */
    customerName: { type: String, default: null, trim: true },
    contact: { type: String, default: null, trim: true },
    email: { type: String, default: null, trim: true },
    /** t_payment.last_update_date. */
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * Everything needed to trace this document back to the legacy rows, including
 * the identifiers whose new-side mapping is missing or not yet proven.
 */
const legacySchema = new mongoose.Schema(
  {
    source: { type: String, required: true, default: LEGACY_SOURCE },
    /** t_enrollment.enrollment_id - the migration identity. */
    enrollmentId: { type: Number, required: true },
    /** The original foreign keys, always preserved even when they resolved. */
    userId: { type: Number, default: null },
    packageId: { type: Number, default: null },
    /**
     * m_coach.coach_id. Kept unconditionally, because the new Coach collection
     * has no legacy identity and most rows therefore cannot resolve a coachId.
     */
    coachId: { type: Number, default: null },
    /**
     * How coachId was resolved, when it was: 'email' means an opt-in match on
     * the legacy coach's email address, not something the legacy data proved.
     */
    coachResolvedBy: { type: String, default: null },
    /**
     * The coach's name as m_coach held it at migration time.
     *
     * A historical fact, not a substitute for the relationship: most legacy
     * coaches have no Coach document, and a screen that can only print
     * "coach 17" is unreadable. Stored so the name survives even if m_coach is
     * eventually retired, and never used to resolve coachId.
     */
    coachName: { type: String, default: null, trim: true },
    /** m_coach.email, kept alongside the name for the same reason. */
    coachEmail: { type: String, default: null, trim: true },
    /** t_payment.coupon_code as typed. Preserved even when it resolved to a coupon. */
    couponCode: { type: String, default: null, trim: true },
    /** Why couponId is null, when a code was present: 'ambiguous' | 'not_found'. */
    couponUnresolvedReason: { type: String, default: null },
    /** t_enrollment.amount - the enrollment's own copy of the paid amount. */
    enrollmentAmount: { type: String, default: null, trim: true },
    /** The raw flags, so the boolean translation is never the only record. */
    deleteFlg: { type: String, default: null },
    startFlg: { type: String, default: null },
    createdBy: { type: String, default: null },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: null },
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

const enrolledClientSchema = new mongoose.Schema(
  {
    // --- relationships, by id ---
    /** The member. Required: an enrollment without a member is not migrated at all. */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** The plan bought (legacy m_package -> GogetfitPlan). */
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'GogetfitPlan', required: true },
    /**
     * The coach. Nullable on purpose: legacy coach ids have no verified mapping
     * to the new Coach collection, and `legacy.coachId` keeps the original.
     */
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', default: null },
    /**
     * The coupon used, when the legacy code resolved to exactly one. Null when
     * no code was entered, when the code matched several legacy coupons, or when
     * it matched none; `legacy.couponCode` keeps what was typed either way.
     */
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', default: null },

    // --- the enrollment itself ---
    /** t_enrollment.enroll_date - when the purchase happened. */
    enrollDate: { type: Date, default: null },
    /**
     * Set when the member starts the plan, not when they buy it: the legacy
     * SpawnBooking wrote CURDATE()+1 day. Null while unstarted.
     */
    startDate: { type: Date, default: null },
    /** startDate + the plan's duration in weeks, written by the same legacy call. */
    endDate: { type: Date, default: null },
    /** t_enrollment.start_flg - whether the member ever started the plan. */
    hasStarted: { type: Boolean, default: false },
    /** t_enrollment.delete_flg. Every migrated row is '0'; the coach list filtered on it. */
    isDeleted: { type: Boolean, default: false },

    payment: { type: paymentSchema, default: undefined },

    legacy: { type: legacySchema, default: undefined },
    migration: { type: migrationSchema, default: () => ({}) },

    /** 'admin_manual' for an enrollment an admin created in the portal; absent on migrated rows. */
    source: { type: String, enum: [ENROLLMENT_SOURCE_ADMIN_MANUAL], default: undefined },

    /** Set only for rows created through the API; migrated rows carry null. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false, collection: 'enrolledclients' },
);

/**
 * Migration identity: re-running the migration updates the same document rather
 * than adding a second one. Partial, so rows created through the API (which
 * have no legacy block) are unaffected.
 */
enrolledClientSchema.index(
  { 'legacy.source': 1, 'legacy.enrollmentId': 1 },
  {
    unique: true,
    name: 'uniq_legacy_source_enrollmentid',
    partialFilterExpression: { 'legacy.enrollmentId': { $exists: true, $type: 'number' } },
  },
);

/**
 * Query indexes, one per relationship the admin list filters on, plus the two
 * compound ones the real screens need:
 *
 *   - a member's own enrollments, newest first (member view, admin user detail)
 *   - a coach's clients by enrolment date, which is what CoachDAL ordered by
 *
 * Deliberately no index on couponId: the admin list filters by coupon rarely
 * and the collection is small enough that a filtered scan is cheaper than a
 * fifth index on every write. Add one when a real query needs it.
 */
enrolledClientSchema.index({ userId: 1, enrollDate: -1 }, { name: 'enrolled_user_enrolldate' });
enrolledClientSchema.index({ coachId: 1, enrollDate: -1 }, { name: 'enrolled_coach_enrolldate' });
enrolledClientSchema.index({ planId: 1 }, { name: 'enrolled_plan' });
/** The default list ordering, and the window the legacy "active" rule tests. */
enrolledClientSchema.index({ endDate: -1 }, { name: 'enrolled_enddate' });
/** Transaction lookup: the admin list's search box, and the legacy join key. */
enrolledClientSchema.index({ 'payment.transactionId': 1 }, { name: 'enrolled_transaction' });

/**
 * The legacy status rule, computed rather than stored because the legacy system
 * never stored it either:
 *
 *   BookingDAL:  CASE WHEN end_date < NOW() THEN 'inactive' ELSE 'active' END
 *
 * A row the member never started has no end date, and the legacy CASE would
 * have called it "active"; it is reported as 'not_started' here so the two are
 * distinguishable, which the legacy read could not do on its own.
 */
export const enrollmentStatus = (doc, now = new Date()) => {
  if (doc?.isDeleted) return 'deleted';
  if (!doc?.hasStarted || !doc?.endDate) return 'not_started';
  return doc.endDate < now ? 'inactive' : 'active';
};

export const ENROLLMENT_STATUSES = ['active', 'inactive', 'not_started', 'deleted'];

export const EnrolledClient = mongoose.model('EnrolledClient', enrolledClientSchema);
export default EnrolledClient;
