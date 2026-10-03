import mongoose from 'mongoose';

import { ROLE_USER, ROLES } from '../constants/roles.js';
import { roundBodyFat } from '../utils/round.js';
import { ACTIVITY_LEVELS, FITNESS_GOALS, FOOD_TYPES } from '../utils/fitness-calculations.js';
import { FITNESS_NUMBERS } from '../validators/profile.validator.js';

export const LEGACY_SOURCE = 'gogetfit';

const phoneSchema = new mongoose.Schema(
  {
    raw: { type: String, required: true, trim: true },
    normalized: { type: String, required: true, trim: true },
  },
  { _id: false },
);

/**
 * Historical MariaDB identity. Absent for users who signed up directly in the
 * new application - a legacy userId is never invented.
 */
const legacySchema = new mongoose.Schema(
  {
    source: { type: String, required: true, default: LEGACY_SOURCE },
    userId: { type: Number, required: true },
  },
  { _id: false },
);

/**
 * The member's physical stats and training preferences.
 *
 * Height, weight and body fat were carried over from the legacy m_user table;
 * activityLevel, foodType and goal had no confirmed legacy source, so they
 * start null and are only ever set by the member.
 *
 * The three preference fields are plain strings rather than enums: their
 * vocabulary is owned by the client today, and pinning it here would break the
 * app the moment it adds an option.
 */
const fitnessProfileSchema = new mongoose.Schema(
  {
    /** Centimetres. */
    height: { type: Number, default: null },
    /** Kilograms. */
    weight: { type: Number, default: null },
    /** Percentage, stored to two decimal places. */
    bodyFatPercentage: { type: Number, default: null, set: roundBodyFat },
    activityLevel: { type: String, default: null, trim: true },
    foodType: { type: String, default: null, trim: true },
    goal: { type: String, default: null, trim: true },
    /**
     * Basal metabolic rate in kcal/day, carried over from the legacy
     * m_user.bmr column. Nothing here computes it: the value is whatever the
     * legacy system stored, and null when it stored nothing.
     */
    bmr: { type: Number, default: null },
    /**
     * Resting daily energy expenditure in kcal/day. The legacy column is named
     * tdee; tdee is this system's name for the same figure. Carried across
     * unchanged - never recalculated, never derived from bmr.
     */
    tdee: { type: Number, default: null },
  },
  { _id: false },
);

const profileSchema = new mongoose.Schema(
  {
    name: { type: String, default: null, trim: true },
    dateOfBirth: { type: Date, default: null },
    // Derived from dateOfBirth and refreshed on read; never accepted from a client.
    age: { type: Number, default: null },
    gender: { type: String, enum: ['male', 'female', null], default: null },
    city: { type: String, default: null, trim: true },
    /**
     * Backfilled from the legacy m_user.email_id. Deliberately NOT unique:
     * the legacy database contains duplicate addresses, and email is never an
     * identity key here - phone.normalized is the login identity.
     */
    email: { type: String, default: null, trim: true },
    /**
     * Whether [email] is trusted. Migrated legacy addresses arrive verified
     * because they came from the legacy system; nothing in this application
     * verifies an address yet.
     */
    isEmailVerified: { type: Boolean, default: false },
    /**
     * URL of the member's avatar, or null. A reference only - the image bytes
     * live in the storage driver, never in MongoDB. Always editable by the
     * owner; there is no approval workflow and nothing was migrated from the
     * legacy system, which had no profile pictures.
     */
    profilePicture: { type: String, default: null },
    fitnessProfile: { type: fitnessProfileSchema, default: () => ({}) },
    /**
     * The member's current Free Diet Plan: a reference to the reusable template
     * in `freedietplans`, never a copy of it.
     *
     * One pointer, replaced whenever the fitness profile changes the calorie
     * band or the food preference, and null when the profile no longer matches
     * any template. There is deliberately no history here - the previous plan is
     * simply no longer referenced.
     */
    freeDietPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FreeDietPlan',
      default: null,
    },
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

/**
 * Administrator password credential. Absent on every ordinary member: the
 * mobile app authenticates with phone + OTP and never has a password.
 *
 * `passwordHash` is `select: false`, so it is excluded from every query unless
 * a caller explicitly asks for it. Only the admin login path does.
 */
const authSchema = new mongoose.Schema(
  {
    /** Argon2id encoded hash, or null. Never a plaintext password. */
    passwordHash: { type: String, default: null, select: false },
    passwordUpdatedAt: { type: Date, default: null },
    /** Consecutive failures since the last success. Reset to 0 on success. */
    failedLoginAttempts: { type: Number, default: 0 },
    /** Set while the account is temporarily locked out; null otherwise. */
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    phone: { type: phoneSchema, required: true },
    legacy: { type: legacySchema, default: undefined },
    profile: { type: profileSchema, default: () => ({}) },
    profileCompleted: { type: Boolean, default: false },
    /**
     * Additive roles - see src/constants/roles.js. An account can hold several
     * at once, so this is an array and never a single enum. Validated against
     * the known set so a typo can never silently create a phantom role.
     */
    roles: {
      type: [String],
      default: () => [ROLE_USER],
      validate: {
        validator: (roles) => Array.isArray(roles) && roles.every((r) => ROLES.includes(r)),
        message: (props) => `roles contains an unknown value: ${props.value}`,
      },
    },
    status: { type: String, enum: ['active', 'inactive', 'blocked'], default: 'active' },
    migration: { type: migrationSchema, default: () => ({}) },
    /**
     * Present ONLY on accounts that can sign in with a password, i.e. portal
     * administrators. `default: undefined` (like `legacy`) means an ordinary
     * member's document carries no `auth` key at all, rather than a subdocument
     * full of nulls - so no credential-shaped field is written for the 435
     * migrated members, and nothing needs backfilling.
     */
    auth: { type: authSchema, default: undefined },
  },
  { timestamps: true, versionKey: false },
);

// Login identity: one normalized phone = one user. Hard database constraint.
userSchema.index({ 'phone.normalized': 1 }, { unique: true, name: 'uniq_phone_normalized' });

// Historical identity: the same legacy account can never be migrated twice.
// Partial so that new users without legacy metadata are unaffected.
userSchema.index(
  { 'legacy.source': 1, 'legacy.userId': 1 },
  {
    unique: true,
    name: 'uniq_legacy_source_userid',
    partialFilterExpression: { 'legacy.userId': { $exists: true, $type: 'number' } },
  },
);

const filled = (value) => value !== null && value !== undefined && String(value).trim() !== '';
/** A number within the range the profile save accepts (validators/profile.validator.js). */
const inRange = (value, field) =>
  typeof value === 'number' && Number.isFinite(value) && value >= FITNESS_NUMBERS[field].min && value <= FITNESS_NUMBERS[field].max;

/**
 * THE profile-complete rule - the only place it is decided. profileCompleted is
 * true only when ALL of these hold:
 *
 *   1. the email is verified (isEmailVerified === true)
 *   2. basic profile: name, dateOfBirth (a real date), age, gender (male/female),
 *      city, email, profilePicture
 *   3. fitnessProfile with VALID values:
 *        height, weight, bodyFatPercentage, bmr, tdee - numbers within the
 *          ranges the profile save accepts
 *        activityLevel, foodType, goal - the app's own enum values
 *
 * Anything else is false. Clients can never set the flag; every write that can
 * change one of these fields recalculates it.
 */
export const isProfileComplete = (profile = {}) => {
  const fp = profile?.fitnessProfile;
  if (!fp || typeof fp !== 'object') return false;
  return Boolean(
    profile.isEmailVerified === true &&
      filled(profile.name) &&
      profile.dateOfBirth instanceof Date &&
      !Number.isNaN(profile.dateOfBirth.getTime()) &&
      typeof profile.age === 'number' &&
      Number.isFinite(profile.age) &&
      (profile.gender === 'male' || profile.gender === 'female') &&
      filled(profile.city) &&
      filled(profile.email) &&
      filled(profile.profilePicture) &&
      inRange(fp.height, 'height') &&
      inRange(fp.weight, 'weight') &&
      inRange(fp.bodyFatPercentage, 'bodyFatPercentage') &&
      inRange(fp.bmr, 'bmr') &&
      inRange(fp.tdee, 'tdee') &&
      ACTIVITY_LEVELS.some((a) => a.value === fp.activityLevel) &&
      FOOD_TYPES.includes(fp.foodType) &&
      FITNESS_GOALS.includes(fp.goal),
  );
};

/** Backend-owned rule: the client can never set profileCompleted directly. */
userSchema.methods.recomputeProfileCompletion = function recomputeProfileCompletion() {
  this.profileCompleted = isProfileComplete(this.profile);
  return this.profileCompleted;
};

export const User = mongoose.model('User', userSchema);
export default User;
