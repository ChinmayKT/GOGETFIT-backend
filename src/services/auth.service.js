import env from '../config/env.js';
import logger from '../config/logger.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { normalizePhone } from '../utils/phone.js';
import { signUserToken } from '../utils/jwt.js';
import { issueOtp, verifyOtp } from './otp.service.js';
import { createNewUser, findByNormalizedPhone, refreshAge, toPublicUser } from './user.service.js';

/**
 * Step 1: challenge a phone number.
 * No user is created here, even when registrations are open - the account is
 * only created after the code is verified.
 */
export const requestOtp = async (rawPhone) => {
  const normalized = normalizePhone(rawPhone);
  const existingUser = await findByNormalizedPhone(normalized);

  if (!existingUser && !env.allowNewRegistrations) {
    throw notFound(ERROR_CODES.USER_NOT_FOUND, 'No account exists for this phone number');
  }

  const { code, expiresAt } = await issueOtp(normalized);

  if (env.otp.debug) {
    logger.debug(`OTP issued for ${normalized}: ${code}`);
  } else {
    logger.info(`OTP issued for ${normalized}`);
  }

  return {
    phone: normalized,
    isNewUser: !existingUser,
    expiresAt,
    // Returned only when OTP_DEBUG is on, which is rejected in production.
    devOtp: env.otp.debug ? code : undefined,
  };
};

/**
 * Step 2: verify the code, then resolve the user.
 * Existing user -> log in. Unknown phone -> create only now, if allowed.
 */
export const verifyOtpAndLogin = async (rawPhone, code) => {
  const normalized = normalizePhone(rawPhone);

  await verifyOtp(normalized, code);

  let user = await findByNormalizedPhone(normalized);
  let created = false;

  if (!user) {
    if (!env.allowNewRegistrations) {
      throw notFound(ERROR_CODES.USER_NOT_FOUND, 'No account exists for this phone number');
    }
    user = await createNewUser({ raw: String(rawPhone).trim(), normalized });
    created = true;
    logger.info(`New user created after OTP verification: ${user._id}`);
  }

  const age = await refreshAge(user);

  return {
    token: signUserToken(user),
    isNewUser: created,
    user: toPublicUser(user, age),
  };
};
