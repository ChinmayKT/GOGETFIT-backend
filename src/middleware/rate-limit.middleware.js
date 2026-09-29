import { ERROR_CODES, tooManyRequests } from '../utils/errors.js';

/**
 * Fixed-window rate limiter held in process memory.
 *
 * Scope and limits: this protects ONE Node process. Behind several instances
 * each keeps its own counters, so the effective limit multiplies by the number
 * of instances. That is acceptable for the admin login path, which is a single
 * low-traffic endpoint, and it avoids adding a Redis dependency for it. If the
 * API is ever horizontally scaled, move this to a shared store.
 *
 * Counters are swept lazily on access, so an idle process does not grow without
 * bound and no timer is left running to keep the event loop alive.
 */
const buckets = new Map();

const sweep = (now) => {
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
};

export const consume = (key, { limit, windowMs, now = Date.now() }) => {
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  const allowed = existing.count <= limit;

  return {
    allowed,
    remaining: Math.max(0, limit - existing.count),
    retryAfterSeconds: allowed ? 0 : Math.ceil((existing.resetAt - now) / 1000),
  };
};

/** Test/bootstrap helper - never called by request handling. */
export const resetRateLimits = () => buckets.clear();

/**
 * Builds a limiter middleware.
 *
 * `keys` derives one or more bucket keys from the request; every key is
 * consumed, and the request is rejected if ANY of them is exhausted. The admin
 * login uses two - the client IP and the submitted email - so that one attacker
 * cannot spray many accounts from one address, and a distributed attack cannot
 * grind a single account.
 */
export const rateLimit = ({ limit, windowMs, keys }) => {
  return (req, res, next) => {
    const now = Date.now();
    sweep(now);

    const derived = keys(req).filter(Boolean);
    let worst = null;

    for (const key of derived) {
      const result = consume(key, { limit, windowMs, now });
      if (!result.allowed && (!worst || result.retryAfterSeconds > worst.retryAfterSeconds)) {
        worst = result;
      }
    }

    if (worst) {
      res.set('Retry-After', String(worst.retryAfterSeconds));
      next(
        tooManyRequests(
          ERROR_CODES.TOO_MANY_REQUESTS,
          'Too many attempts, please try again later',
          { retryAfterSeconds: worst.retryAfterSeconds },
        ),
      );
      return;
    }

    next();
  };
};
