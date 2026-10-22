/**
 * Reading a workout prescription written as free text ("3", "12-15",
 * "15sec") - the legacy sets_count / reps_count, varchar(5) each.
 *
 * Only unambiguous shapes are read; anything else gives nulls, and the raw
 * text is always kept beside the result by the caller. Nothing is inferred
 * from the exercise (a "plank" with reps "30" stays 30 reps). Shapes, from
 * the staging data (docs/workout-plans-migration-audit.md §7.6):
 *
 *   "12"          -> reps 12
 *   "12-15"       -> reps 12 to 15        (min <= max, else unread)
 *   "15sec"/"15s" -> time 15 (seconds)    also "15 secs"
 *   "10rep(s)"    -> reps 10
 *   "1min"        -> time 60              also "01min", "2 mins"
 *   anything else -> nulls ("30cc", "I ", "10/3", "")
 */

const MAX_AMOUNT = 9999;

const whole = (text) => {
  const n = Number.parseInt(text, 10);
  return Number.isInteger(n) && n >= 0 && n <= MAX_AMOUNT ? n : null;
};

/** Sets: a whole number only, else null. */
export const parseSets = (raw) => {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return /^\d{1,4}$/.test(text) ? whole(text) : null;
};

const UNREAD = Object.freeze({ measure: null, amount: null, amountMax: null });

/** Reps or time: { measure, amount, amountMax }, all null when not safely read. */
export const parseReps = (raw) => {
  if (typeof raw !== 'string') return UNREAD;
  const text = raw.trim().toLowerCase();
  let m;
  if ((m = /^(\d{1,4})$/.exec(text))) return { measure: 'reps', amount: whole(m[1]), amountMax: null };
  if ((m = /^(\d{1,4})\s*-\s*(\d{1,4})$/.exec(text))) {
    const [lo, hi] = [whole(m[1]), whole(m[2])];
    return lo != null && hi != null && lo <= hi ? { measure: 'reps', amount: lo, amountMax: hi } : UNREAD;
  }
  if ((m = /^(\d{1,4})\s*(?:s|sec|secs)$/.exec(text))) return { measure: 'time', amount: whole(m[1]), amountMax: null };
  if ((m = /^(\d{1,4})\s*(?:rep|reps)$/.exec(text))) return { measure: 'reps', amount: whole(m[1]), amountMax: null };
  if ((m = /^(\d{1,3})\s*(?:min|mins)$/.exec(text))) {
    const minutes = whole(m[1]);
    return minutes != null ? { measure: 'time', amount: minutes * 60, amountMax: null } : UNREAD;
  }
  return UNREAD;
};

export default { parseSets, parseReps };
