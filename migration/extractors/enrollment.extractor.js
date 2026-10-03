import { query } from '../config/mariadb.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Read-only extraction of the legacy enrollment/purchase flow: t_enrollment
 * joined to t_payment.
 *
 * The join key is transaction_id, which the legacy admin list proves
 * (admin/GGF.DAL/UserDAL.cs: "t_payment a inner join t_enrollment b on
 * a.transaction_id = b.transaction_id"). It is a LEFT join here so an
 * enrollment whose payment row is missing is still extracted and reported
 * rather than silently disappearing from the result set.
 */

export const ENROLLMENT_COLUMNS = [
  'enrollment_id',
  'package_id',
  'coach_id',
  'user_id',
  'enroll_date',
  'start_date',
  'end_date',
  'delete_flg',
  'created_by',
  'last_update_date',
  'last_update_by',
  'start_flg',
  'transaction_id',
  'amount',
  'currency',
];

export const PAYMENT_COLUMNS = [
  'transaction_id',
  'user_id',
  'payment_date',
  'original_amount',
  'discount_percent',
  'coupon_code',
  'amount',
  'currency',
  'reference_id',
  'description',
  'customer_name',
  'contact',
  'email_id',
  'status',
  'last_update_date',
];

const describe = async (table) => {
  const rows = await query('SHOW COLUMNS FROM ??', [table]);
  return new Set(rows.map((row) => row.Field));
};

/** Which of the wanted columns the live tables actually have. */
export const resolveEnrollmentColumns = async ({
  enrollmentTable = migrationEnv.enrollmentTable,
  paymentTable = migrationEnv.paymentTable,
} = {}) => {
  const [enrollment, payment] = await Promise.all([
    describe(enrollmentTable),
    describe(paymentTable),
  ]);

  if (!enrollment.has('enrollment_id')) {
    throw new Error(`Legacy table "${enrollmentTable}" has no enrollment_id column`);
  }
  if (!enrollment.has('transaction_id') || !payment.has('transaction_id')) {
    throw new Error('transaction_id is missing; the enrollment/payment join cannot be made');
  }

  return {
    enrollment: ENROLLMENT_COLUMNS.filter((c) => enrollment.has(c)),
    enrollmentMissing: ENROLLMENT_COLUMNS.filter((c) => !enrollment.has(c)),
    payment: PAYMENT_COLUMNS.filter((c) => payment.has(c)),
    paymentMissing: PAYMENT_COLUMNS.filter((c) => !payment.has(c)),
  };
};

export const countEnrollments = async (table = migrationEnv.enrollmentTable) =>
  Number((await query('SELECT COUNT(*) AS total FROM ??', [table]))[0].total);

export const countPayments = async (table = migrationEnv.paymentTable) =>
  Number((await query('SELECT COUNT(*) AS total FROM ??', [table]))[0].total);

/**
 * Every enrollment with its payment, ordered by enrollment_id so a run is
 * reproducible. Payment columns are aliased with a `p_` prefix; the two tables
 * share several column names (user_id, amount, currency, last_update_date) and
 * an unaliased join would silently drop one side.
 */
export const extractEnrollments = async (options = {}) => {
  const enrollmentTable = options.enrollmentTable ?? migrationEnv.enrollmentTable;
  const paymentTable = options.paymentTable ?? migrationEnv.paymentTable;
  const { enrollment, payment } = await resolveEnrollmentColumns(options);

  const left = enrollment.map((c) => `e.\`${c}\``).join(', ');
  const right = payment.map((c) => `p.\`${c}\` AS \`p_${c}\``).join(', ');

  return query(
    `SELECT ${left}, ${right}
       FROM \`${enrollmentTable}\` e
       LEFT JOIN \`${paymentTable}\` p ON p.transaction_id = e.transaction_id
      ORDER BY e.enrollment_id ASC`,
  );
};

/** The legacy coupon rows, for resolving a payment's coupon_code to one coupon. */
export const extractCoupons = async (table = migrationEnv.couponTable) =>
  query('SELECT coupon_id, coupon_code FROM ?? ORDER BY coupon_id ASC', [table]);

/** The legacy coaches, for the opt-in email-based coach link. */
export const extractCoaches = async (table = migrationEnv.coachTable) =>
  query('SELECT coach_id, first_name, last_name, email, phone FROM ?? ORDER BY coach_id ASC', [
    table,
  ]);

export default { extractEnrollments, extractCoupons, extractCoaches };
