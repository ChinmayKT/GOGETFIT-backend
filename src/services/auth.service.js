import env from '../config/env.js';
import logger from '../config/logger.js';
import { AppError, ERROR_CODES, notFound } from '../utils/errors.js';
import { PhoneNormalizationError, normalizePhone, parsePhone } from '../utils/phone.js';
import { signUserToken } from '../utils/jwt.js';
import { deliverOtp } from './otp-delivery.service.js';
import { consumeIpRequest, reservePhoneRequest } from './otp-limit.service.js';
import { activateOtp, discardOtp, issueOtp, verifyOtp } from './otp.service.js';
import {
  createOrFindUser,
  fillPhoneDetails,
  findByNormalizedPhone,
  refreshAge,
  toPublicUser,
} from './user.service.js';

/**
 * The phone identity for a login, plus the parsed details when the number is
 * valid under its country's rules.
 *
 * A number that fails today's rules still logs into the account already
 * stored under its legacy identity (old app versions, no countryIso) - but
 * never creates one, and nothing is guessed about it (details stay null).
 * With a countryIso the number must parse: a short international number is
 * never re-read as Indian.
 */
const resolveLoginPhone = async (rawPhone, countryIso) => {
  try {
    const details = parsePhone(rawPhone, countryIso);
    return { normalized: details.normalized, details, existing: undefined };
  } catch (error) {
    if (countryIso || !(error instanceof PhoneNormalizationError)) throw error;
    const normalized = normalizePhone(rawPhone);
    const existing = await findByNormalizedPhone(normalized);
    if (!existing) throw error;
    return { normalized, details: null, existing };
  }
};

/**
 * Step 1: challenge a phone number.
 * No user is created here, even when registrations are open - the account is
 * only created after the code is verified.
 */
export const requestOtp = async (rawPhone, countryIso, { ip, now = new Date() } = {}) => {
  const { normalized, details, existing } = await resolveLoginPhone(rawPhone, countryIso);
  const existingUser = existing ?? (await findByNormalizedPhone(normalized));

  if (!existingUser && !env.allowNewRegistrations) {
    throw notFound(ERROR_CODES.USER_NOT_FOUND, 'No account exists for this phone number');
  }

  // Limits, cheapest refusal first. The IP attempt always counts; the phone's
  // daily request is reserved here and kept only if the code goes out.
  await consumeIpRequest(ip, now);
  const reservation = await reservePhoneRequest(normalized, now);

  let issued;
  try {
    issued = await issueOtp(normalized, now);
  } catch (error) {
    await reservation.release();
    throw error;
  }
  const { record, code, expiresAt } = issued;

  const delivery = await deliverOtp({ e164: `+${normalized}`, code, expiresAt });
  if (delivery.status === 'rejected') {
    // Refused before acceptance: nothing sent, nothing charged.
    await discardOtp(record);
    await reservation.release();
    logger.warn(`OTP delivery rejected for ${normalized}: ${delivery.reason}`);
    throw new AppError(502, ERROR_CODES.OTP_DELIVERY_FAILED, 'Could not send the code. Please try again.');
  }
  // Accepted, or uncertain (timeout): the member may receive it, so the code
  // stays valid and the request stays charged.
  await activateOtp(record, delivery, now);
  if (delivery.status === 'uncertain') {
    logger.warn(`OTP delivery uncertain for ${normalized}: ${delivery.reason}`);
  }

  if (env.otp.debug) {
    logger.debug(`OTP issued for ${normalized}: ${code}`);
  } else {
    logger.info(`OTP issued for ${normalized}`);
  }

  return {
    phone: normalized,
    e164: `+${normalized}`,
    formatted: details?.formatted ?? existingUser?.phone?.formatted ?? null,
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
export const verifyOtpAndLogin = async (rawPhone, code, countryIso) => {
  const { normalized, details, existing } = await resolveLoginPhone(rawPhone, countryIso);

  await verifyOtp(normalized, code);

  let user = existing ?? (await findByNormalizedPhone(normalized));
  let created = false;

  if (!user) {
    if (!env.allowNewRegistrations) {
      throw notFound(ERROR_CODES.USER_NOT_FOUND, 'No account exists for this phone number');
    }
    // details is always set here: an unparsable number only gets this far
    // for an existing account.
    ({ user, created } = await createOrFindUser({ raw: String(rawPhone).trim(), ...details }));
    if (created) logger.info(`New user created after OTP verification: ${user._id}`);
  } else if (details) {
    await fillPhoneDetails(user, details);
  }

  const age = await refreshAge(user);

  return {
    token: signUserToken(user),
    isNewUser: created,
    user: toPublicUser(user, age),
  };
};
