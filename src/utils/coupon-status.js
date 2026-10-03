import env from '../config/env.js';
import { now as clockNow } from './clock.js';

/**
 * THE coupon status rule - the only place it is decided.
 *
 * A coupon is active on every calendar day from validFrom to validTo, both
 * inclusive, and inactive before and after. Validity dates are stored as the
 * calendar day at UTC midnight; "today" is the calendar day in the business
 * timezone (Asia/Kolkata by default), so a coupon ending on the 10th stays
 * active until midnight India time, not until 05:30 IST.
 *
 * Nothing is scheduled: every read evaluates this against the current date, so
 * a coupon is inactive the moment its last day ends, and time passing never
 * touches updatedBy/updatedAt.
 */
export const COUPON_STATUSES = ['active', 'inactive'];

/** Today's calendar date in [timeZone], as that date at UTC midnight. */
export const calendarDay = (at = clockNow(), timeZone = env.businessTimezone) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
};

export const getCouponStatus = (validFrom, validTo, at = clockNow()) => {
  if (!validFrom || !validTo) return 'inactive';
  const today = calendarDay(at).getTime();
  return new Date(validFrom).getTime() <= today && today <= new Date(validTo).getTime() ? 'active' : 'inactive';
};

/** The same rule as a MongoDB filter, for listing and counting by status. */
export const couponStatusFilter = (status, at = clockNow()) => {
  const today = calendarDay(at);
  if (status === 'active') return { validFrom: { $lte: today }, validTo: { $gte: today } };
  if (status === 'inactive') return { $or: [{ validFrom: { $gt: today } }, { validTo: { $lt: today } }] };
  return {};
};

/** The same rule as an aggregation expression (1 = active, 0 = inactive), for ordering. */
export const couponActiveExpr = (at = clockNow()) => {
  const today = calendarDay(at);
  return { $cond: [{ $and: [{ $lte: ['$validFrom', today] }, { $gte: ['$validTo', today] }] }, 1, 0] };
};
