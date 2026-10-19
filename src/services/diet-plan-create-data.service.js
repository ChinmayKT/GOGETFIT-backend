import mongoose from 'mongoose';

import Coach from '../models/coach.model.js';
import EnrolledClient from '../models/enrolled-client.model.js';
import User from '../models/user.model.js';
import { calculateAge } from '../utils/age.js';
import { ERROR_CODES, forbidden, notFound } from '../utils/errors.js';
import { ACTIVITY_LEVELS, FITNESS_GOALS, GENDERS } from '../utils/fitness-calculations.js';

/**
 * The six values a Create Diet Plan screen opens with (the coach's app and the
 * Admin Portal alike), for one enrollment - from the member's PROFILE ONLY:
 * profile.gender, age from profile.dateOfBirth, and
 * profile.fitnessProfile.height/weight/activityLevel/goal. A field the
 * profile lacks is null and is filled in by hand; there is no second source
 * (the questionnaire is deliberately not read). Read-only: nothing is written.
 */

/**
 * Who is acting on an enrollment's diet plans: { userId, role } from the
 * token - role 'coach' (only their own enrollments) or 'admin' (any). The
 * enrollment, never the request, decides the client and the coach.
 */
export const ACTOR_COACH = 'coach';
export const ACTOR_ADMIN = 'admin';

/**
 * The live enrollment [enrollmentId] for [actor] - 404 when it is malformed,
 * unknown, deleted or has no member; 403 when a coach asks for another coach's.
 * A caller that reads the member itself passes `checkUser: false` and handles
 * a missing member, so the user is not read twice.
 * @returns {{ _id, userId, coachId }} lean; coachId may be null.
 */
export const resolveEnrollmentForActor = async (actor, enrollmentId, { checkUser = true } = {}) => {
  let coachId = null;
  if (actor.role === ACTOR_COACH) {
    const coach = await Coach.findOne({ userId: actor.userId }, { _id: 1 }).lean();
    if (!coach) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'You do not have a coach profile');
    coachId = coach._id;
  } else if (actor.role !== ACTOR_ADMIN) {
    throw forbidden(ERROR_CODES.FORBIDDEN, 'Not allowed');
  }

  const missing = () => notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrollment not found');
  if (!mongoose.isValidObjectId(enrollmentId)) throw missing();
  const enrollment = await EnrolledClient.findOne(
    { _id: enrollmentId, isDeleted: { $ne: true } },
    { userId: 1, coachId: 1 },
  ).lean();
  if (!enrollment) throw missing();
  if (coachId && String(enrollment.coachId) !== String(coachId)) {
    throw forbidden(ERROR_CODES.FORBIDDEN, 'This enrollment is not one of your clients');
  }
  if (!enrollment.userId || (checkUser && !(await User.exists({ _id: enrollment.userId })))) {
    throw noMember();
  }
  return { _id: enrollment._id, userId: enrollment.userId, coachId: enrollment.coachId ?? null };
};

const noMember = () => notFound(ERROR_CODES.USER_NOT_FOUND, 'This enrollment has no member');

const positive = (value) => {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** What the profile says, each field null when it says nothing usable. */
const fromProfile = (profile = {}) => {
  const fp = profile.fitnessProfile ?? {};
  return {
    gender: GENDERS.includes(profile.gender) ? profile.gender : null,
    // DOB is the source of truth; the stored age is only its cached copy.
    age: calculateAge(profile.dateOfBirth) ?? positive(profile.age),
    height: positive(fp.height),
    weight: positive(fp.weight),
    activityLevel: ACTIVITY_LEVELS.some((a) => a.value === fp.activityLevel) ? fp.activityLevel : null,
    goal: FITNESS_GOALS.includes(fp.goal) ? fp.goal : null,
  };
};

const FIELDS = ['gender', 'age', 'height', 'weight', 'activityLevel', 'goal'];

/**
 * @param actor { userId, role } - see resolveEnrollmentForActor.
 * @returns {Promise<{gender, age, height, weight, activityLevel, goal}>}
 *   exactly these six keys, each null when unknown.
 */
export const getDietPlanCreateData = async (actor, enrollmentId) => {
  // The member is read once, here: this read is also the existence check.
  const enrollment = await resolveEnrollmentForActor(actor, enrollmentId, { checkUser: false });
  const user = await User.findById(enrollment.userId, {
    'profile.gender': 1,
    'profile.dateOfBirth': 1,
    'profile.age': 1,
    'profile.fitnessProfile': 1,
  }).lean();
  if (!user) throw noMember();
  const profile = fromProfile(user.profile);

  // Exactly the six keys, each null when the profile says nothing usable.
  return Object.fromEntries(FIELDS.map((f) => [f, profile[f]]));
};

export default { getDietPlanCreateData, resolveEnrollmentForActor };
