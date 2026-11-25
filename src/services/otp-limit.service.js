import env from '../config/env.js';
import OtpLimit from '../models/otp-limit.model.js';
import { addCalendarDays, businessDayOf, startOfBusinessDay } from '../utils/business-date.js';
import { ERROR_CODES, tooManyRequests } from '../utils/errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The calendar day a request is counted in, in the business timezone
 * (Asia/Kolkata by default): "2026-11-20". The allowance resets at local
 * midnight (00:00 IST), not at 00:00 UTC.
 */
export const otpDay = (now) => businessDayOf(now);

const secondsUntil = (when, now) => Math.max(1, Math.ceil((when.getTime() - now.getTime()) / 1000));

/** The instant the next business day begins (next 00:00 IST). */
const nextDayStart = (now) => startOfBusinessDay(addCalendarDays(otpDay(now), 1));

const isDuplicateKey = (error) => error?.code === 11000;

/** Concurrent first inserts of one counter can collide (E11000) while it
 *  still has room; such a collision is retried, never read as a refusal. */
const MAX_ATTEMPTS = 5;

/**
 * Reserves one of the phone's daily OTP requests, atomically enforcing both
 * the daily limit (business day, IST) and the resend cooldown. Throws 429:
 *   OTP_DAILY_LIMIT_REACHED  { retryAfterSeconds (to midnight IST), limit }
 *   OTP_RESEND_COOLDOWN      { retryAfterSeconds }
 *
 * The reservation is charged once the code is handed to the provider; the
 * returned release() gives it back when delivery definitely failed before the
 * provider accepted it.
 */
export const reservePhoneRequest = async (phoneNormalized, now = new Date()) => {
  const { dailyLimit, resendCooldownSeconds } = env.otp;
  const day = otpDay(now);
  const _id = `phone:${phoneNormalized}`;
  const cooldownEdge = new Date(now.getTime() - resendCooldownSeconds * 1000);

  let before;
  for (let attempt = 1; ; attempt++) {
    try {
      // One atomic step: matches only when the cooldown has passed and today
      // still has room (or the stored day is an earlier one). A brand-new
      // phone is inserted. When it does not match, the upsert's insert
      // collides with the existing _id (E11000) - the "refused" signal.
      before = await OtpLimit.findOneAndUpdate(
        {
          _id,
          lastRequestAt: { $lte: cooldownEdge },
          $or: [{ day: { $ne: day } }, { count: { $lt: dailyLimit } }],
        },
        [
          {
            $set: {
              kind: 'phone',
              count: { $cond: [{ $eq: ['$day', day] }, { $add: ['$count', 1] }, 1] },
              day,
              lastRequestAt: now,
              expireAt: new Date(now.getTime() + 2 * DAY_MS),
            },
          },
        ],
        { upsert: true, returnDocument: 'before', updatePipeline: true, lean: true },
      );
      break;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const current = await OtpLimit.findById(_id).lean();
      const full = current?.day === day && current.count >= dailyLimit;
      const cooling = current?.lastRequestAt && current.lastRequestAt > cooldownEdge;
      if (!full && !cooling && attempt < MAX_ATTEMPTS) continue; // lost an insert race
      if (full) {
        throw tooManyRequests(
          ERROR_CODES.OTP_DAILY_LIMIT_REACHED,
          `This number has had its ${dailyLimit} codes for today`,
          { retryAfterSeconds: secondsUntil(nextDayStart(now), now), limit: dailyLimit },
        );
      }
      const resendAt = new Date((current?.lastRequestAt ?? now).getTime() + resendCooldownSeconds * 1000);
      throw tooManyRequests(ERROR_CODES.OTP_RESEND_COOLDOWN, 'Please wait before requesting another code', {
        retryAfterSeconds: secondsUntil(resendAt, now),
      });
    }
  }

  return {
    /** Gives the reservation back (only while it is still the latest one). */
    release: async () => {
      if (!before) {
        await OtpLimit.deleteOne({ _id, lastRequestAt: now });
        return;
      }
      await OtpLimit.updateOne(
        { _id, lastRequestAt: now },
        {
          $set: {
            day: before.day,
            count: before.count,
            lastRequestAt: before.lastRequestAt,
            expireAt: before.expireAt,
          },
        },
      );
    },
  };
};

/**
 * Counts one OTP request from [ip] in the current UTC clock hour; throws 429
 * TOO_MANY_REQUESTS { retryAfterSeconds } beyond the hourly limit. Every
 * attempt counts, whatever happens to it afterwards.
 */
export const consumeIpRequest = async (ip, now = new Date()) => {
  if (!ip) return;
  const limit = env.otp.ipHourlyLimit;
  const hourStart = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const hourEnd = new Date(hourStart.getTime() + HOUR_MS);
  const _id = `ip:${ip}:${hourStart.toISOString().slice(0, 13)}`;
  for (let attempt = 1; ; attempt++) {
    try {
      await OtpLimit.updateOne(
        { _id, count: { $lt: limit } },
        { $inc: { count: 1 }, $setOnInsert: { kind: 'ip', expireAt: new Date(hourEnd.getTime() + HOUR_MS) } },
        { upsert: true },
      );
      return;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const current = await OtpLimit.findById(_id).lean();
      if ((current?.count ?? 0) < limit && attempt < MAX_ATTEMPTS) continue; // lost an insert race
      throw tooManyRequests(ERROR_CODES.TOO_MANY_REQUESTS, 'Too many code requests from this network', {
        retryAfterSeconds: secondsUntil(hourEnd, now),
      });
    }
  }
};
