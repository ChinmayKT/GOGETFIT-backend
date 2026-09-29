import crypto from 'node:crypto';

import env from '../config/env.js';
import Otp from '../models/otp.model.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/** Cryptographically secure 4-digit code, 1000-9999. Never Math.random(). */
export const generateOtpCode = () => String(crypto.randomInt(1000, 10000));

/**
 * Keyed hash: HMAC-SHA256 over (salt + code) with a server-side secret.
 * A 4-digit code has only 9000 possibilities, so a plain digest would be
 * trivially reversible from a database dump; the secret is not in the database.
 */
export const hashOtpCode = (code, salt) =>
  crypto.createHmac('sha256', env.otp.hashSecret).update(`${salt}:${code}`).digest('hex');

const hashesMatch = (a, b) => {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
};

/**
 * Issues a challenge for a phone number. Any previously active challenge for
 * the same phone is invalidated so only the newest code can be used.
 */
export const issueOtp = async (phoneNormalized, now = new Date()) => {
  await Otp.updateMany(
    { phoneNormalized, consumedAt: null },
    { $set: { consumedAt: now } },
  );

  const code = generateOtpCode();
  const salt = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + env.otp.ttlSeconds * 1000);

  const record = await Otp.create({
    phoneNormalized,
    codeHash: hashOtpCode(code, salt),
    salt,
    expiresAt,
  });

  return { record, code, expiresAt };
};

/**
 * Verifies and atomically consumes a challenge. Single use: a consumed record
 * can never verify again, and a wrong code burns an attempt.
 */
export const verifyOtp = async (phoneNormalized, code, now = new Date()) => {
  const record = await Otp.findOne({ phoneNormalized, consumedAt: null }).sort({ createdAt: -1 });

  if (!record) {
    throw badRequest(ERROR_CODES.OTP_NOT_FOUND, 'No active OTP for this phone number');
  }

  if (record.expiresAt.getTime() <= now.getTime()) {
    throw badRequest(ERROR_CODES.OTP_EXPIRED, 'OTP has expired');
  }

  if (record.attempts >= env.otp.maxAttempts) {
    await Otp.updateOne({ _id: record._id }, { $set: { consumedAt: now } });
    throw badRequest(ERROR_CODES.OTP_ATTEMPTS_EXCEEDED, 'Too many incorrect attempts');
  }

  const candidateHash = hashOtpCode(String(code), record.salt);

  if (!hashesMatch(candidateHash, record.codeHash)) {
    await Otp.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    throw badRequest(ERROR_CODES.OTP_INVALID, 'Incorrect OTP');
  }

  // Conditional update: the first caller wins, a replay finds nothing to consume.
  const consumed = await Otp.findOneAndUpdate(
    { _id: record._id, consumedAt: null },
    { $set: { consumedAt: now } },
    { new: true },
  );

  if (!consumed) {
    throw badRequest(ERROR_CODES.OTP_ALREADY_USED, 'OTP has already been used');
  }

  return consumed;
};
