import 'dotenv/config';

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const migrationEnv = {
  /**
   * Logical source recorded on every migrated user as legacy.source. This is
   * deliberately separate from the physical database name so that rehearsing
   * against "staging-ggf" still produces production-correct legacy metadata.
   */
  source: process.env.MIGRATION_SOURCE || 'gogetfit',
  version: int(process.env.MIGRATION_VERSION, 1),

  mysql: {
    host: process.env.MIGRATION_MYSQL_HOST,
    port: int(process.env.MIGRATION_MYSQL_PORT, 3306),
    database: process.env.MIGRATION_MYSQL_DATABASE,
    user: process.env.MIGRATION_MYSQL_USER,
    password: process.env.MIGRATION_MYSQL_PASSWORD,
  },

  userTable: process.env.MIGRATION_USER_TABLE || 'm_user',
  // Free Diet Plan templates: the plan row and its food rows.
  planTable: process.env.MIGRATION_PLAN_TABLE || 'm_plan',
  planMealTable: process.env.MIGRATION_PLAN_MEAL_TABLE || 'r_plan_meal',
  // GoGetFit Plans (paid coaching packages).
  packageTable: process.env.MIGRATION_PACKAGE_TABLE || 'm_package',
  // Safety rail: running against the production legacy database must be an
  // explicit, deliberate act rather than a leftover .env value.
  allowProduction: ['1', 'true', 'yes'].includes(
    String(process.env.MIGRATION_ALLOW_PRODUCTION || '').toLowerCase(),
  ),
  productionDatabase: process.env.MIGRATION_PRODUCTION_DATABASE || 'gogetfit',
  nameStrategy: process.env.MIGRATION_NAME_STRATEGY || 'first_name',
  batchSize: int(process.env.MIGRATION_BATCH_SIZE, 500),
};

/**
 * @param {{requireMysql?: boolean}} [options] - a backfill that only reads
 *   MongoDB passes `requireMysql: false`; the production-database guard still
 *   applies, so the safety rail is never skipped.
 */
export const assertMigrationEnv = ({ requireMysql = true } = {}) => {
  const missing = [];
  const { host, database, user, password } = migrationEnv.mysql;

  if (requireMysql) {
    if (!host) missing.push('MIGRATION_MYSQL_HOST');
    if (!database) missing.push('MIGRATION_MYSQL_DATABASE');
    if (!user) missing.push('MIGRATION_MYSQL_USER');
    if (!password) missing.push('MIGRATION_MYSQL_PASSWORD');
  }
  if (!process.env.MONGODB_URI) missing.push('MONGODB_URI');

  if (missing.length > 0) {
    throw new Error(`Missing migration environment variable(s): ${missing.join(', ')}`);
  }

  if (database === migrationEnv.productionDatabase && !migrationEnv.allowProduction) {
    throw new Error(
      `Refusing to connect to the production legacy database "${database}". Set MIGRATION_ALLOW_PRODUCTION=true to override.`,
    );
  }
};

/** Connection details safe to log - never includes the password. */
export const describeMysqlTarget = () =>
  `${migrationEnv.mysql.user}@${migrationEnv.mysql.host}:${migrationEnv.mysql.port}/${migrationEnv.mysql.database}`;

export default migrationEnv;
