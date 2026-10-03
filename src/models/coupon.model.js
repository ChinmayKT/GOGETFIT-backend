import mongoose from 'mongoose';


/**
 * Admin-managed coupons (the new home of legacy m_coupon; see
 * docs/coupons-legacy.md). This is CRUD only: redemption, usage tracking and
 * the legacy migration are separate work.
 */

/** Only percentage discounts exist - legacy never had another kind. */
export const DISCOUNT_TYPES = ['percent'];

/** public = listed to members (legacy everyone='1'); private = not listed. */
export const COUPON_VISIBILITIES = ['public', 'private'];


/** Upper-case and trimmed - the only form a code is stored in. */
export const normalizeCouponCode = (code) => String(code ?? '').trim().toUpperCase();

const discountSchema = new mongoose.Schema(
  {
    type: { type: String, enum: DISCOUNT_TYPES, required: true, default: 'percent' },
    /** 0-100. 100 is allowed, as it was in legacy. */
    value: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false },
);

/**
 * Historical identity for coupons migrated from m_coupon later. Absent on
 * coupons created in the new portal - never invented.
 */
const legacySchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    couponId: { type: Number, required: true },
    /**
     * m_coupon's own audit columns, kept verbatim. They are legacy login ids
     * (always "123" in practice), NOT Mongo User ids - which is why a migrated
     * coupon's createdBy/updatedBy stay null.
     */
    auditCreatedBy: { type: String, default: null },
    auditUpdatedBy: { type: String, default: null },
    auditUpdatedAt: { type: Date, default: null },
    /**
     * m_coupon.delete_flg = '1'. Kept for traceability only - the new system has
     * no archive/deleted status; a coupon's status comes from its dates.
     */
    deleted: { type: Boolean, default: false },
  },
  { _id: false },
);

/** Which migration run wrote a migrated coupon. Absent on portal coupons. */
const migrationSchema = new mongoose.Schema(
  {
    runId: { type: String, default: null },
    migratedAt: { type: Date, default: null },
    version: { type: Number, default: null },
  },
  { _id: false },
);

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: null, trim: true },
    discount: { type: discountSchema, required: true },
    /** Inclusive validity window, stored as real dates. */
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },
    visibility: { type: String, enum: COUPON_VISIBILITIES, default: 'public' },
    // There is deliberately NO status field. Active/inactive is computed from
    // validFrom/validTo at request time (utils/coupon-status.js) and never stored,
    // so time passing never writes to a coupon.
    legacy: { type: legacySchema, default: undefined },
    migration: { type: migrationSchema, default: undefined },
    /** The authenticated administrator - never a value supplied by the browser. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, immutable: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false, collection: 'coupons' },
);

/**
 * A code is unique across ALL coupons (there is no archived state that could
 * share one). Codes are stored normalised, so " welcome20 " and "WELCOME20"
 * are the same code. Enforced by the database, not only by the service check.
 */
couponSchema.index({ code: 1 }, { unique: true, name: 'uniq_code' });

// The computed status queries: "today within [validFrom, validTo]".
couponSchema.index({ validTo: 1, validFrom: 1 }, { name: 'coupon_validity' });

// Migration identity for later legacy imports.
couponSchema.index(
  { 'legacy.source': 1, 'legacy.couponId': 1 },
  {
    unique: true,
    name: 'uniq_legacy_source_couponid',
    partialFilterExpression: { 'legacy.couponId': { $exists: true, $type: 'number' } },
  },
);

export const Coupon = mongoose.model('Coupon', couponSchema);
export default Coupon;
