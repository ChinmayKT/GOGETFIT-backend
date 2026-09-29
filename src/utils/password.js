import argon2 from 'argon2';

/**
 * Argon2id parameters. These follow the OWASP Password Storage baseline
 * (19 MiB memory, 2 iterations, 1 lane). They are recorded inside the encoded
 * hash, so raising them later does not invalidate existing hashes - an old
 * hash still verifies with its own parameters.
 */
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/** Minimum length accepted when a password is set. */
export const MIN_PASSWORD_LENGTH = 8;

export const hashPassword = (plain) => argon2.hash(String(plain), HASH_OPTIONS);

/**
 * Constant-time comparison performed inside argon2.verify. Returns false rather
 * than throwing on a malformed or absent hash, so a user without a password can
 * never be logged in by accident.
 */
export const verifyPassword = async (hash, plain) => {
  if (!hash || !plain) return false;
  try {
    return await argon2.verify(String(hash), String(plain));
  } catch {
    return false;
  }
};

/**
 * Deliberately minimal: length only. Composition rules push people toward
 * predictable substitutions, and this credential is a bootstrap artefact - the
 * real protection is the hash, the lockout and the rate limiter.
 */
export const assertPasswordAcceptable = (plain) => {
  const value = String(plain ?? '');
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return value;
};
