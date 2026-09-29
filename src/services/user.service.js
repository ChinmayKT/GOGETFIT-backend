import User from '../models/user.model.js';
import { calculateAge } from '../utils/age.js';

export const findByNormalizedPhone = (phoneNormalized) =>
  User.findOne({ 'phone.normalized': phoneNormalized });

export const findById = (id) => User.findById(id);

/**
 * Creates a user that has no legacy origin. No legacy mapping is invented.
 */
export const createNewUser = ({ raw, normalized }) =>
  User.create({
    phone: { raw, normalized },
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
  phone: user.phone.normalized,
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
