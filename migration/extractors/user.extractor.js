import { query } from '../config/mariadb.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Legacy columns the migration is allowed to read. Authentication columns
 * (password, login_token, otp, otp_expiry, registration_otp) are deliberately
 * absent - they are never selected, so they can never leak into the new system.
 */
export const READABLE_COLUMNS = [
  'user_id',
  'first_name',
  'last_name',
  'gender',
  'dob',
  'email_id',
  'phone_number',
  'city_name',
  'state_name',
  'country_name',
  'zip_code',
  'address',
  'height',
  'weight',
  'waist',
  'neck',
  'hips',
  'fat',
  'bmr',
  'tdee',
  'age',
  'points',
  'renewal_code',
  'brand_ambassador_code',
  'user_type',
  'coach_id',
  'wakeup',
  'sleep',
  'hydration_goal',
  'create_date',
  'created_by',
  'last_update_date',
  'last_update_by',
];

/** Columns that must never be read, asserted against the live schema. */
export const FORBIDDEN_COLUMNS = [
  'password',
  'login_token',
  'otp',
  'otp_expiry',
  'registration_otp',
];

export const describeUserTable = async (table = migrationEnv.userTable) => {
  const rows = await query('SHOW COLUMNS FROM ??', [table]);
  return rows.map((row) => ({ name: row.Field, type: row.Type, nullable: row.Null === 'YES' }));
};

/**
 * Intersects the wanted column list with what the table actually has, so the
 * same code runs against staging and production schemas that drift slightly.
 */
export const resolveSelectableColumns = async (table = migrationEnv.userTable) => {
  const columns = await describeUserTable(table);
  const available = new Set(columns.map((column) => column.name));

  const selected = READABLE_COLUMNS.filter((column) => available.has(column));
  const missing = READABLE_COLUMNS.filter((column) => !available.has(column));
  const forbiddenPresent = FORBIDDEN_COLUMNS.filter((column) => available.has(column));

  if (!available.has('user_id')) {
    throw new Error(`Legacy table "${table}" has no user_id column; cannot migrate identity`);
  }

  return { selected, missing, forbiddenPresent, allColumns: columns };
};

export const countUsers = async (table = migrationEnv.userTable) => {
  const rows = await query('SELECT COUNT(*) AS total FROM ??', [table]);
  return Number(rows[0].total);
};

/**
 * Batched, ordered read. Keyset pagination on user_id keeps the read stable and
 * avoids the cost of large OFFSETs.
 */
export async function* extractUsers({
  table = migrationEnv.userTable,
  batchSize = migrationEnv.batchSize,
  limit = null,
} = {}) {
  const { selected } = await resolveSelectableColumns(table);

  let lastId = 0;
  let emitted = 0;

  for (;;) {
    const remaining = limit === null ? batchSize : Math.min(batchSize, limit - emitted);
    if (remaining <= 0) return;

    const rows = await query(
      'SELECT ?? FROM ?? WHERE user_id > ? ORDER BY user_id ASC LIMIT ?',
      [selected, table, lastId, remaining],
    );

    if (rows.length === 0) return;

    for (const row of rows) {
      yield row;
      emitted += 1;
    }

    lastId = Number(rows[rows.length - 1].user_id);
  }
}

/**
 * Read-only projection of just the legacy identity and email, for the email
 * backfill. Goes through the same guarded, parameterized query layer as every
 * other extraction, so MariaDB stays read-only.
 */
export const extractUserEmails = async ({ table = migrationEnv.userTable } = {}) => {
  const { selected } = await resolveSelectableColumns(table);

  if (!selected.includes('email_id')) {
    throw new Error(`Legacy table "${table}" has no email_id column; nothing to backfill`);
  }

  const rows = await query(
    'SELECT user_id, email_id FROM ?? ORDER BY user_id ASC',
    [table],
  );

  return rows.map((row) => ({
    legacyUserId: Number(row.user_id),
    rawEmail: row.email_id,
  }));
};

/**
 * Legacy fitness columns read for profile.fitnessProfile. bmr and tdee are
 * int(4) nullable in m_user; both keep their names in the new system
 * (fitnessProfile.bmr / fitnessProfile.tdee). activityLevel, foodType and goal have no confirmed legacy source, so
 * they are deliberately absent here rather than guessed.
 */
export const FITNESS_COLUMNS = ['height', 'weight', 'fat', 'bmr', 'tdee'];

/**
 * Which fitness columns the live table actually has. Reported by the backfill
 * so a missing legacy column is visible instead of silently reading as null.
 */
export const resolveFitnessColumns = async (table = migrationEnv.userTable) => {
  const { selected } = await resolveSelectableColumns(table);

  return {
    available: FITNESS_COLUMNS.filter((column) => selected.includes(column)),
    missing: FITNESS_COLUMNS.filter((column) => !selected.includes(column)),
  };
};

/** Read-only projection of the legacy identity plus its fitness columns. */
export const extractUserFitness = async ({ table = migrationEnv.userTable } = {}) => {
  const { available } = await resolveFitnessColumns(table);

  if (available.length === 0) {
    throw new Error(`Legacy table "${table}" has none of ${FITNESS_COLUMNS.join(', ')}`);
  }

  // Only columns that exist are selected, so a table missing bmr/tdee still
  // reads cleanly (those fields come back null) instead of failing the query.
  const rows = await query(
    'SELECT ?? FROM ?? ORDER BY user_id ASC',
    [['user_id', ...available], table],
  );

  return rows.map((row) => ({
    legacyUserId: Number(row.user_id),
    height: row.height ?? null,
    weight: row.weight ?? null,
    fat: row.fat ?? null,
    bmr: row.bmr ?? null,
    tdee: row.tdee ?? null,
  }));
};

export const extractUsersArray = async (options = {}) => {
  const rows = [];
  for await (const row of extractUsers(options)) rows.push(row);
  return rows;
};
