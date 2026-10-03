import { refreshAge, toPublicUser } from '../services/user.service.js';
import { matchAndAttachPlan } from '../services/free-diet-plan-match.service.js';
import { validateProfilePatch } from '../validators/profile.validator.js';
import { calculateAge } from '../utils/age.js';
import { ERROR_CODES, conflict } from '../utils/errors.js';
import {
  removeProfilePicture,
  setProfilePicture,
} from '../services/profile-picture.service.js';

export const getMe = async (req, res, next) => {
  try {
    // Recalculates age from DOB and refreshes the cached value if it drifted.
    const age = await refreshAge(req.user);
    res.status(200).json({ success: true, data: { user: toPublicUser(req.user, age) } });
  } catch (error) {
    next(error);
  }
};

export const patchProfile = async (req, res, next) => {
  try {
    const user = req.user;

    // A verified address is locked server-side, not only in the UI: calling the
    // API directly must not be a way around the read-only field.
    if (req.body?.email !== undefined && user.profile?.isEmailVerified) {
      throw conflict(
        ERROR_CODES.EMAIL_ALREADY_VERIFIED,
        'This email is verified and cannot be changed',
      );
    }

    const patch = validateProfilePatch(req.body);

    for (const [key, value] of Object.entries(patch)) {
      if (key === 'email') {
        // A new address is untrusted until it proves itself, so changing it
        // always drops the verified flag. Re-sending the same address is not a
        // change and leaves the flag alone.
        const next = value;
        if (next !== (user.profile?.email ?? null)) {
          user.profile.email = next;
          user.profile.isEmailVerified = false;
        }
        continue;
      }
      if (key === 'fitnessProfile') {
        // Merged field by field so a partial update never clears the values
        // the member already has.
        user.profile.fitnessProfile ??= {};
        for (const [field, fieldValue] of Object.entries(value)) {
          user.profile.fitnessProfile[field] = fieldValue;
        }
        continue;
      }
      user.profile[key] = value;
    }

    // Age is always derived, never taken from the request.
    user.profile.age = calculateAge(user.profile.dateOfBirth);
    user.recomputeProfileCompletion();

    await user.save();

    /**
     * The fitness profile decides which pre-authored Free Diet Plan the member
     * is on, so the pointer is resolved here, on the save, by the backend.
     *
     * The outcome is reported alongside the user rather than thrown: the save
     * itself succeeded, and "no template covers this calorie band" is a state
     * the client has to show, not a failed request. A previous pointer is
     * replaced, and cleared to null when nothing matches any more.
     */
    const freeDietPlan = await matchAndAttachPlan(user);

    res.status(200).json({
      success: true,
      message: 'Profile updated',
      data: { user: toPublicUser(user), freeDietPlan },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Replaces the authenticated user's avatar. The body is the raw image; the
 * owner is always req.user, resolved from the JWT subject, so one member can
 * never touch another's picture.
 */
export const putProfilePicture = async (req, res, next) => {
  try {
    await setProfilePicture(req.user, req.body);

    const age = await refreshAge(req.user);
    res.status(200).json({
      success: true,
      message: 'Profile picture updated',
      data: { user: toPublicUser(req.user, age) },
    });
  } catch (error) {
    next(error);
  }
};

/** Removes the avatar. Always allowed, whatever the email's verified state. */
export const deleteProfilePicture = async (req, res, next) => {
  try {
    await removeProfilePicture(req.user);

    const age = await refreshAge(req.user);
    res.status(200).json({
      success: true,
      message: 'Profile picture removed',
      data: { user: toPublicUser(req.user, age) },
    });
  } catch (error) {
    next(error);
  }
};
