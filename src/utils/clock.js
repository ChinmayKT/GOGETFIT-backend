/**
 * The current time, behind one seam so tests can pin "now" and date-driven
 * behaviour (coupon validity) is deterministic. Production always uses the
 * real clock.
 */
let fixed = null;

export const now = () => (fixed ? new Date(fixed.getTime()) : new Date());

/** Test seam: pin the clock (or pass null to release it). */
export const setNow = (date) => {
  fixed = date ? new Date(date) : null;
};
