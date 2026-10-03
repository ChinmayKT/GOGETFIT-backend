import { normalizeCouponCode } from '../../src/models/coupon.model.js';

/**
 * Pure transform: one m_coupon row -> Coupon fields, or the reasons it is
 * malformed. Nothing is guessed: a date or discount that does not parse the way
 * the legacy system itself read it is reported, not repaired.
 */

/**
 * Legacy dates are dd/MM/yyyy text read with STR_TO_DATE('%d/%m/%Y'), which also
 * accepts 1-digit day/month - so this does too, and nothing looser. The result
 * is that calendar day at UTC midnight: the same representation Coupon CRUD
 * stores for a date input. The validity window is inclusive by calendar day.
 */
export const parseLegacyDate = (value) => {
  if (value === null || value === undefined) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value).trim());
  if (!match) return null;
  const [, d, m, y] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Round-trip check rejects 31/02/2024 etc. instead of rolling it over.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
};

/** Legacy discount is varchar(3) holding a whole percentage. 1-100 only. */
export const parseLegacyDiscount = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 100 ? n : null;
};

const text = (value) => {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.trim() === '' ? null : s;
};

const toInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
};

export const transformLegacyCoupon = (row, { source }) => {
  const problems = [];
  const couponId = toInt(row.coupon_id);
  if (couponId === null) problems.push('coupon_id is not an integer');

  const code = normalizeCouponCode(row.coupon_code);
  if (code === '') problems.push('coupon_code is empty');

  const discount = parseLegacyDiscount(row.discount);
  if (discount === null) problems.push(`discount "${row.discount}" is not a whole percentage 1-100`);

  const validFrom = parseLegacyDate(row.valid_from);
  const validTo = parseLegacyDate(row.valid_to);
  if (!validFrom) problems.push(`valid_from "${row.valid_from}" is not a dd/mm/yyyy date`);
  if (!validTo) problems.push(`valid_to "${row.valid_to}" is not a dd/mm/yyyy date`);
  if (validFrom && validTo && validFrom > validTo) problems.push('valid_from is after valid_to');

  return {
    couponId,
    code,
    rawCode: row.coupon_code ?? null,
    problems,
    malformedDate: !validFrom || !validTo,
    malformedDiscount: discount === null,
    coupon: {
      code,
      description: text(row.description),
      discount: { type: 'percent', value: discount },
      validFrom,
      validTo,
      // Legacy everyone='1' = listed to all members; anything else = not listed.
      visibility: String(row.everyone ?? '').trim() === '1' ? 'public' : 'private',
      // No status is stored: it is computed from the dates at request time.
      // delete_flg is kept only as legacy.deleted, for history.
      // Legacy audit values are not Mongo User ids: no verified mapping exists.
      createdBy: null,
      updatedBy: null,
      legacy: {
        source,
        couponId,
        auditCreatedBy: text(row.created_by),
        auditUpdatedBy: text(row.last_update_by),
        auditUpdatedAt: row.last_update_date ? new Date(row.last_update_date) : null,
        deleted: String(row.delete_flg ?? '').trim() === '1',
      },
    },
  };
};
