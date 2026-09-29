import { tryNormalizePhone } from '../../src/utils/phone.js';

/**
 * Wraps the runtime normalizer so migration and login agree on exactly one
 * definition of a phone identity. Migration must classify unusable values
 * rather than throwing, so the non-throwing variant is used here.
 */
export const transformLegacyPhone = (legacyPhoneNumber) => {
  if (legacyPhoneNumber === null || legacyPhoneNumber === undefined || String(legacyPhoneNumber).trim() === '') {
    return { ok: false, raw: null, normalized: null, reason: 'MISSING' };
  }

  const raw = String(legacyPhoneNumber).trim();
  const result = tryNormalizePhone(raw);

  return {
    ok: result.ok,
    raw,
    normalized: result.normalized,
    reason: result.ok ? null : result.reason,
  };
};

export default transformLegacyPhone;
