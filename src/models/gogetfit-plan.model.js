import mongoose from 'mongoose';

import { LEGACY_SOURCE } from './user.model.js';
import { COACH_LEVELS } from './coach.model.js';

/**
 * GoGetFit Plans: the paid coaching products members buy - the new home of the
 * legacy `m_package` table. See docs/gogetfit-plans-legacy.md.
 *
 * Not the Free Diet Plan templates (legacy m_plan, FreeDietPlan): different
 * table, different purpose, no shared fields.
 */

/** Legacy m_package.package_type, verbatim. Enrollment = coaching plan; Challenge = plan with a refund reward. */
export const PLAN_TYPES = ['Enrollment', 'Challenge'];

/** Legacy m_package.coach_level - the same LEVEL 1..5 vocabulary as coaches. */
export const PLAN_LEVELS = COACH_LEVELS;

export const PLAN_STATUSES = ['active', 'archived'];

/** Prices are whole rupees, tax-inclusive, exactly as the legacy int columns held them. */
export const PLAN_CURRENCY = 'INR';

const pricingSchema = new mongoose.Schema(
  {
    /** m_package.base_price - INR, incl. taxes. */
    basePrice: { type: Number, required: true, min: 0 },
    /** m_package.reward - the refund money of a Challenge. Legacy Enrollment rows hold 0. */
    reward: { type: Number, default: null, min: 0 },
  },
  { _id: false },
);

/**
 * A stored image: where it is served from and the storage driver's key for it.
 * Same shape as a coach picture; only the reference is kept, never the bytes.
 */
const imageRefSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    storageKey: { type: String, required: true },
  },
  { _id: false },
);

/** The five free-text sections the app shows on a plan, kept verbatim. */
const contentSchema = new mongoose.Schema(
  {
    description: { type: String, default: null },
    /** Newline-separated "* ..." lines, as authored. */
    inclusions: { type: String, default: null },
    whatNext: { type: String, default: null },
    termsAndConditions: { type: String, default: null },
    eligibility: { type: String, default: null },
  },
  { _id: false },
);

/**
 * Historical identity plus the legacy row's audit columns. m_package has no
 * create date - only last_update_date - so none is invented.
 */
const legacySchema = new mongoose.Schema(
  {
    source: { type: String, required: true, default: LEGACY_SOURCE },
    packageId: { type: Number, required: true },
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

const gogetfitPlanSchema = new mongoose.Schema(
  {
    // Identity / basic information.
    name: { type: String, required: true, trim: true },
    /** No enum at the schema level: migrated rows are kept exactly as stored; the API validates writes. */
    planType: { type: String, required: true, trim: true },
    coachLevel: { type: String, default: null, trim: true },
    durationWeeks: { type: Number, required: true, min: 0 },
    personsAllowed: { type: Number, required: true, min: 0 },

    // Commercial information.
    pricing: { type: pricingSchema, required: true },

    // Display information.
    content: { type: contentSchema, default: () => ({}) },
    /**
     * The plan's 3:1 cover image, or null. Plan-specific (not the coach's), set
     * only through the plan image endpoints. Migrated plans have none.
     */
    image: { type: imageRefSchema, default: null },

    /**
     * Soft-delete state. The legacy admin had no delete at all, and enrollments
     * reference plans by id, so "delete" archives: the document stays, leaves
     * the default list, and can be restored.
     */
    status: { type: String, enum: PLAN_STATUSES, default: 'active' },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    legacy: { type: legacySchema, default: undefined },
    migration: { type: migrationSchema, default: () => ({}) },

    /** The authenticated administrator, never a value supplied by the browser. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false, collection: 'gogetfitplans' },
);

/** Migration identity: one legacy package can never become two plans. */
gogetfitPlanSchema.index(
  { 'legacy.source': 1, 'legacy.packageId': 1 },
  {
    unique: true,
    name: 'uniq_legacy_source_packageid',
    partialFilterExpression: { 'legacy.packageId': { $exists: true, $type: 'number' } },
  },
);

/**
 * List query index. Deliberately no unique index on name: the legacy system had
 * no duplicate rule and none is invented here.
 */
gogetfitPlanSchema.index(
  { status: 1, planType: 1, coachLevel: 1 },
  { name: 'gogetfitplan_status_type_level' },
);

/**
 * Coach -> plans lookup: a coach offers every active plan of the coach's level,
 * oldest first. {status, coachLevel} equality plus the createdAt sort are all
 * served by this one index (the index above has planType in between).
 */
gogetfitPlanSchema.index(
  { status: 1, coachLevel: 1, createdAt: 1 },
  { name: 'gogetfitplan_status_level_created' },
);

export const GogetfitPlan = mongoose.model('GogetfitPlan', gogetfitPlanSchema);
export default GogetfitPlan;
