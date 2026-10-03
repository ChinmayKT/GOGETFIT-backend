/**
 * Maps one joined legacy row (t_enrollment LEFT JOIN t_payment) onto the
 * EnrolledClient shape. Relationship ids are resolved by the loader; this deals
 * only with the values.
 *
 * Nothing is invented, normalized away or back-computed. In particular
 * original_amount and discount_percent are 0 on every legacy row, even where a
 * coupon code was entered, and they are stored as those zeros - see
 * docs/enrolledclients-legacy.md.
 */

const text = (value) => {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
};

export const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * A legacy datetime. Returns null for a value that cannot be parsed, so the
 * loader can report the row rather than storing an Invalid Date.
 */
export const toDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
};

/** char(1) legacy flag: only '1' is true. */
export const toFlag = (value) => String(value ?? '').trim() === '1';

/** The date columns, so the loader can report exactly which one failed to parse. */
export const DATE_FIELDS = {
  enroll_date: 'enrollDate',
  start_date: 'startDate',
  end_date: 'endDate',
  p_payment_date: 'payment.paidAt',
  last_update_date: 'legacy.updatedAt',
  p_last_update_date: 'payment.updatedAt',
};

/** Which legacy date columns hold a value that will not parse. */
export const unparseableDates = (row) =>
  Object.entries(DATE_FIELDS)
    .filter(([column]) => row[column] !== null && row[column] !== undefined && row[column] !== '')
    .filter(([column]) => toDate(row[column]) === null)
    .map(([column, field]) => ({ column, field, value: String(row[column]) }));

/**
 * The value half of an EnrolledClient. `source` is the logical legacy source,
 * as every other migration records it.
 */
export const transformLegacyEnrollment = (row, { source }) => ({
  enrollDate: toDate(row.enroll_date),
  // Written only when the member started the plan; null before that.
  startDate: toDate(row.start_date),
  endDate: toDate(row.end_date),
  hasStarted: toFlag(row.start_flg),
  isDeleted: toFlag(row.delete_flg),

  payment: {
    // The legacy join key. The enrollment's own copy is the authority here: a
    // row with no matching payment still keeps its transaction id.
    transactionId: text(row.transaction_id) ?? '',
    amount: toNumber(row.p_amount),
    currency: text(row.p_currency) ?? text(row.currency),
    originalAmount: toNumber(row.p_original_amount),
    discountPercent: toNumber(row.p_discount_percent),
    status: text(row.p_status),
    paidAt: toDate(row.p_payment_date),
    referenceId: text(row.p_reference_id),
    description: text(row.p_description),
    customerName: text(row.p_customer_name),
    contact: text(row.p_contact),
    email: text(row.p_email_id),
    updatedAt: toDate(row.p_last_update_date),
  },

  legacy: {
    source,
    enrollmentId: toNumber(row.enrollment_id),
    userId: toNumber(row.user_id),
    packageId: toNumber(row.package_id),
    coachId: toNumber(row.coach_id),
    coachResolvedBy: null,
    couponCode: text(row.p_coupon_code),
    couponUnresolvedReason: null,
    // The enrollment's own amount column, kept verbatim as the varchar it is,
    // so the duplication with the payment amount stays visible.
    enrollmentAmount: text(row.amount),
    deleteFlg: text(row.delete_flg),
    startFlg: text(row.start_flg),
    createdBy: text(row.created_by),
    updatedAt: toDate(row.last_update_date),
    updatedBy: text(row.last_update_by),
  },
});

export default transformLegacyEnrollment;
