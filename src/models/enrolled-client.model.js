import mongoose from 'mongoose';

import { businessDayOf, startOfBusinessDay } from '../utils/business-date.js';
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
    /**
     * The Brand Ambassador code this order was bought with, set by the backend
     * from its own coupon record at purchase - never from the client. Its
     * referral lives in brand_ambassador_referrals (one per order).
     */
    ambassadorCouponId: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandAmbassadorCoupon', default: null },

    // --- the enrollment itself ---
    /** t_enrollment.enroll_date - when the purchase happened. */
    enrollDate: { type: Date, default: null },
    /**
     * The plan's first day (the instant it begins in the business timezone).
     * Set when the coach starts the plan, not when it is bought: the day
     * after the Start click, as the legacy SpawnBooking's CURDATE()+1 day.
     * Null while unstarted.
     */
    startDate: { type: Date, default: null },
    /**
     * The plan's LAST active day, inclusive (stored like startDate). Coach
     * Start writes startDate + durationWeeks x 7 - 1 day. Migrated rows keep
     * the legacy startDate + weeks x 7, read with the same inclusive rule.
     */
    endDate: { type: Date, default: null },
    /** t_enrollment.start_flg - whether the member ever started the plan. */
    hasStarted: { type: Boolean, default: false },
    /** When the coach clicked Start (null for migrated, manual or unstarted rows). */
    startedAt: { type: Date, default: null },
    /**
     * Coach Stop Plan: when the coach permanently ended this enrollment early
     * (null while it never was). Final - nothing ever clears it, so a stopped
     * enrollment can never run again. startDate/endDate keep the plan's
     * original scheduled days; this is the actual end.
     */
    stoppedAt: { type: Date, default: null },
    /** The coach's user id who stopped it. */
    stoppedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** t_enrollment.delete_flg. Every migrated row is '0'; the coach list filtered on it. */
    isDeleted: { type: Boolean, default: false },

    payment: { type: paymentSchema, default: undefined },

    /**
     * The business month (YYYY-MM) whose coach capacity this booking used: the
     * month it was created in, whatever its enrollDate says. A cash payment
     * recorded late keeps its real date here and still uses this month's slot.
     *
     * Absent on enrollments older than this field, and never backfilled: those
     * count in the month of their enrollDate. See coach-capacity.service.js.
     */
    capacityAccountingMonth: { type: String, default: undefined, match: /^\d{4}-\d{2}$/ },

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
/** A coach's bookings in one capacity month, including the enrollDate fallback for older rows. */
enrolledClientSchema.index(
  { coachId: 1, capacityAccountingMonth: 1, enrollDate: 1 },
  { name: 'enrolled_coach_capacity_month' },
);
enrolledClientSchema.index({ planId: 1 }, { name: 'enrolled_plan' });
/** The default list ordering, and the window the legacy "active" rule tests. */
enrolledClientSchema.index({ endDate: -1 }, { name: 'enrolled_enddate' });
/** Transaction lookup: the admin list's search box, and the legacy join key. */
enrolledClientSchema.index({ 'payment.transactionId': 1 }, { name: 'enrolled_transaction' });

/**
 * THE plan lifecycle of one enrollment on [now]'s business day - the single
 * rule behind enrollmentStatus, Intake's permissions, food-log authorization
 * and coach Start. Calendar days in the business timezone (Asia/Kolkata),
 * never raw timestamps, and the end day is inclusive: a plan ending on
 * 10 Feb is active until 23:59:59.999 IST that day and completed from 11 Feb.
 *
 *   not_started - bought, the coach has not started it (or it has no dates)
 *   scheduled   - started, its first day is still ahead
 *   active      - today is between its first and last day, both included
 *   completed   - its last day has passed
 *   stopped     - the coach stopped it (stoppedAt): over for good, whatever
 *                 its dates say
 */
export const enrollmentLifecycle = (doc, now = new Date()) => {
  if (doc?.isDeleted) return 'deleted';
  if (doc?.stoppedAt) return 'stopped';
  if (!doc?.hasStarted || !doc?.startDate || !doc?.endDate) return 'not_started';
  const today = businessDayOf(now);
  if (today < businessDayOf(doc.startDate)) return 'scheduled';
  return today > businessDayOf(doc.endDate) ? 'completed' : 'active';
};

/**
 * Whether the enrollment unlocks the member's plan features at [now]: during
 * its official days (active), and already from the instant the coach clicked
 * Start (startedAt) while its first official day is still ahead (scheduled).
 * The official dates are untouched - only access starts early. A scheduled
 * row without a coach Start (e.g. an admin enrollment dated ahead) waits for
 * its first day, as before.
 */
export const unlocksPlan = (doc, now = new Date()) => {
  const lifecycle = enrollmentLifecycle(doc, now);
  if (lifecycle === 'active') return true;
  return lifecycle === 'scheduled' && Boolean(doc.startedAt) && new Date(doc.startedAt) <= now;
};

/**
 * THE member's current enrollment among [docs] (theirs, any order): the
 * officially active one, else one the coach has started whose first day is
 * tomorrow (unlocksPlan), else null. Never the newest purchase as such - a
 * bought plan the coach has not started is never current. planAccessOf and
 * the member's enrollment list both pick with this.
 */
export const currentEnrollmentOf = (docs, now = new Date()) =>
  docs.find((d) => enrollmentLifecycle(d, now) === 'active') ?? docs.find((d) => unlocksPlan(d, now)) ?? null;

/**
 * The query form of "its last day is not over yet": endDate (the instant its
 * last day begins) on or after the instant today begins.
 */
export const notEndedCutoff = (now = new Date()) => startOfBusinessDay(businessDayOf(now));

/**
 * The legacy status vocabulary (the admin list and coach counts), from
 * enrollmentLifecycle: a scheduled plan reads 'active' as the legacy CASE
 * did, and 'inactive' only once its last day is over.
 *
 *   BookingDAL:  CASE WHEN end_date < NOW() THEN 'inactive' ELSE 'active' END
 *
 * A row the member never started has no end date, and the legacy CASE would
 * have called it "active"; it is reported as 'not_started' here so the two are
 * distinguishable, which the legacy read could not do on its own.
 */
export const enrollmentStatus = (doc, now = new Date()) => {
  const lifecycle = enrollmentLifecycle(doc, now);
  if (lifecycle === 'not_started' && doc?.hasStarted && doc?.endDate) {
    // A legacy row started without a start date: by its end date alone.
    return doc.endDate < notEndedCutoff(now) ? 'inactive' : 'active';
  }
  return { scheduled: 'active', completed: 'inactive' }[lifecycle] ?? lifecycle;
};

export const ENROLLMENT_STATUSES = ['active', 'inactive', 'not_started', 'stopped', 'deleted'];

export const EnrolledClient = mongoose.model('EnrolledClient', enrolledClientSchema);
export default EnrolledClient;
