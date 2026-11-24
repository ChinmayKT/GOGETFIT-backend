import User from '../models/user.model.js';
import { calculateAge } from '../utils/age.js';

export const findByNormalizedPhone = (phoneNormalized) =>
  User.findOne({ 'phone.normalized': phoneNormalized });

export const findById = (id) => User.findById(id);

/**
 * Creates a user that has no legacy origin. No legacy mapping is invented.
 * [phone] is the full subdocument (raw, normalized and, when parsed, e164,
 * countryIso, countryName, countryCode, formatted).
 */
export const createNewUser = (phone) =>
  User.create({
    phone,
    profile: {
      name: null,
      dateOfBirth: null,
      age: null,
      gender: null,
      city: null,
      email: null,
      isEmailVerified: false,
      profilePicture: null,
      // No plan until a fitness profile exists to match one from.
      freeDietPlanId: null,
      fitnessProfile: {
        height: null,
        weight: null,
        bodyFatPercentage: null,
        activityLevel: null,
        foodType: null,
        goal: null,
        bmr: null,
        tdee: null,
      },
    },
    profileCompleted: false,
    roles: ['user'],
    status: 'active',
  });

const isDuplicatePhone = (error) =>
  error?.code === 11000 &&
  (error.keyPattern?.['phone.normalized'] !== undefined ||
    String(error.message).includes('uniq_phone_normalized'));

/**
 * First login: create the account, or - when a concurrent request created it
 * a moment earlier (unique index violation) - return that one. One phone is
 * always one account; nothing is merged.
 */
export const createOrFindUser = async (phone) => {
  try {
    return { user: await createNewUser(phone), created: true };
  } catch (error) {
    if (!isDuplicatePhone(error)) throw error;
    const user = await findByNormalizedPhone(phone.normalized);
    if (!user) throw error;
    return { user, created: false };
  }
};

const PHONE_DETAIL_FIELDS = ['e164', 'countryIso', 'countryName', 'countryCode', 'formatted'];

/**
 * Stores the parsed phone details on an existing account that lacks them.
 * Only for the account's own number (same normalized identity), only the
 * missing fields, and never touches normalized, raw or the _id.
 */
export const fillPhoneDetails = async (user, details) => {
  if (!details || details.normalized !== user.phone?.normalized) return;
  const set = {};
  for (const field of PHONE_DETAIL_FIELDS) {
    if (details[field] && !user.phone[field]) set[`phone.${field}`] = details[field];
  }
  if (Object.keys(set).length === 0) return;
  await User.updateOne({ _id: user._id, 'phone.normalized': user.phone.normalized }, { $set: set });
  for (const [path, value] of Object.entries(set)) user.phone[path.slice('phone.'.length)] = value;
};

/** The phone details for API responses; e164 is derivable for every user. */
export const phoneDetailsOf = (phone) => ({
  e164: phone?.e164 ?? (phone?.normalized ? `+${phone.normalized}` : null),
  countryIso: phone?.countryIso ?? null,
  countryName: phone?.countryName ?? null,
  countryCode: phone?.countryCode ?? null,
  formatted: phone?.formatted ?? null,
});

/**
 * DOB is authoritative, age is a cache. On every read the age is recalculated
 * and, if it drifted (the user had a birthday), the cached value is refreshed.
 * This is why a user does not need to log in again on their birthday.
 */
export const refreshAge = async (user, now = new Date()) => {
  const currentAge = calculateAge(user.profile?.dateOfBirth, now);

  if (currentAge !== (user.profile?.age ?? null)) {
    user.profile.age = currentAge;
    await User.updateOne({ _id: user._id }, { $set: { 'profile.age': currentAge } });
  }

  return currentAge;
};

/** Public shape returned to the Flutter client. Legacy data stays internal. */
export const toPublicUser = (user, age) => ({
  id: String(user._id),
  // Unchanged: digits with the country code, as every app version reads it.
  phone: user.phone.normalized,
  phoneDetails: phoneDetailsOf(user.phone),
  profile: {
    name: user.profile?.name ?? null,
    dateOfBirth: user.profile?.dateOfBirth
      ? user.profile.dateOfBirth.toISOString().slice(0, 10)
      : null,
    age: age === undefined ? (user.profile?.age ?? null) : age,
    gender: user.profile?.gender ?? null,
    city: user.profile?.city ?? null,
    email: user.profile?.email ?? null,
    isEmailVerified: user.profile?.isEmailVerified ?? false,
    profilePicture: user.profile?.profilePicture ?? null,
    // The member's current Free Diet Plan template, as an id only - the template
    // itself is fetched separately and is never copied onto the user.
    freeDietPlanId: user.profile?.freeDietPlanId
      ? String(user.profile.freeDietPlanId)
      : null,
    fitnessProfile: {
      height: user.profile?.fitnessProfile?.height ?? null,
      weight: user.profile?.fitnessProfile?.weight ?? null,
      bodyFatPercentage: user.profile?.fitnessProfile?.bodyFatPercentage ?? null,
      activityLevel: user.profile?.fitnessProfile?.activityLevel ?? null,
      foodType: user.profile?.fitnessProfile?.foodType ?? null,
      goal: user.profile?.fitnessProfile?.goal ?? null,
      bmr: user.profile?.fitnessProfile?.bmr ?? null,
      tdee: user.profile?.fitnessProfile?.tdee ?? null,
    },
  },
  profileCompleted: user.profileCompleted,
  roles: user.roles,
  status: user.status,
});
