import env from '../config/env.js';

/**
 * Calendar days in the business timezone (Asia/Kolkata by default).
 *
 * Enrollment dates are stored as the instant the day begins in the business
 * timezone - the convention every migrated enrollment already follows (an IST
 * day "2023-11-10" is stored as 2023-11-09T18:30:00.000Z). A yyyy-mm-dd from
 * the portal is therefore never shifted by the server's own timezone.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Offset of [timeZone] from UTC at [instant], in milliseconds. */
const offsetAt = (instant, timeZone) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
};

/** Is [value] a real calendar date written as yyyy-mm-dd? */
export const isCalendarDay = (value) => {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

/** The instant [yyyy-mm-dd] begins in [timeZone]. */
export const startOfBusinessDay = (value, timeZone = env.businessTimezone) => {
  const [y, m, d] = value.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  let instant = new Date(utcMidnight - offsetAt(new Date(utcMidnight), timeZone));
  // Second pass in case the first guess crossed a DST boundary.
  instant = new Date(utcMidnight - offsetAt(instant, timeZone));
  return instant;
};

export default { isCalendarDay, startOfBusinessDay };
