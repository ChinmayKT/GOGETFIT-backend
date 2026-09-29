import { query } from '../config/mariadb.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Read-only extraction of the legacy GoGetFit Plans (m_package). Column list is
 * exactly what the legacy admin wrote (GGF.DAL/PackageDAL.cs) plus its audit
 * columns. m_package has no create_date column.
 */
export const PACKAGE_COLUMNS = [
  'package_id',
  'package_type',
  'package_name',
  'coach_level',
  'duration',
  'person_allowed',
  'base_price',
  'reward',
  'description',
  'inclusions',
  'what_next',
  'tandc',
  'eligibility',
  'created_by',
  'last_update_date',
  'last_update_by',
];

export const resolvePackageColumns = async (table = migrationEnv.packageTable) => {
  const rows = await query('SHOW COLUMNS FROM ??', [table]);
  const available = new Set(rows.map((row) => row.Field));
  if (!available.has('package_id')) {
    throw new Error(`Legacy table "${table}" has no package_id column; cannot migrate plans`);
  }
  return {
    present: PACKAGE_COLUMNS.filter((column) => available.has(column)),
    missing: PACKAGE_COLUMNS.filter((column) => !available.has(column)),
  };
};

export const countPackages = async (table = migrationEnv.packageTable) => {
  const rows = await query('SELECT COUNT(*) AS total FROM ??', [table]);
  return Number(rows[0].total);
};

/** Every package, in package_id order - the legacy list's own order. */
export const extractPackages = async (table = migrationEnv.packageTable) => {
  const { present } = await resolvePackageColumns(table);
  return query('SELECT ?? FROM ?? ORDER BY package_id ASC', [present, table]);
};

export default { extractPackages, countPackages, resolvePackageColumns };
