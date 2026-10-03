import { query } from '../config/mariadb.js';
import { migrationEnv } from '../config/migration.env.js';

/** Read-only extraction of m_coupon (docs/coupons-legacy.md). Deleted rows included. */
export const COUPON_COLUMNS = [
  'coupon_id',
  'coupon_name',
  'coupon_code',
  'description',
  'discount',
  'valid_from',
  'valid_to',
  'everyone',
  'delete_flg',
  'created_by',
  'last_update_date',
  'last_update_by',
];

export const resolveCouponColumns = async (table = migrationEnv.couponTable) => {
  const available = new Set((await query('SHOW COLUMNS FROM ??', [table])).map((row) => row.Field));
  if (!available.has('coupon_id')) throw new Error(`Legacy table "${table}" has no coupon_id column`);
  return {
    present: COUPON_COLUMNS.filter((c) => available.has(c)),
    missing: COUPON_COLUMNS.filter((c) => !available.has(c)),
  };
};

export const countCoupons = async (table = migrationEnv.couponTable) =>
  Number((await query('SELECT COUNT(*) AS total FROM ??', [table]))[0].total);

/** coupon_id order, so a run is reproducible and duplicate conflicts resolve deterministically. */
export const extractCoupons = async (table = migrationEnv.couponTable) => {
  const { present } = await resolveCouponColumns(table);
  return query('SELECT ?? FROM ?? ORDER BY coupon_id ASC', [present, table]);
};
