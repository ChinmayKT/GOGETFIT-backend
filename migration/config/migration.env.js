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
  // Enrollment / purchase flow.
  enrollmentTable: process.env.MIGRATION_ENROLLMENT_TABLE || 't_enrollment',
  paymentTable: process.env.MIGRATION_PAYMENT_TABLE || 't_payment',
  coachTable: process.env.MIGRATION_COACH_TABLE || 'm_coach',
  // Free Diet Plan templates: the plan row and its food rows.
  planTable: process.env.MIGRATION_PLAN_TABLE || 'm_plan',
  planMealTable: process.env.MIGRATION_PLAN_MEAL_TABLE || 'r_plan_meal',
  // GoGetFit Plans (paid coaching packages).
  packageTable: process.env.MIGRATION_PACKAGE_TABLE || 'm_package',
  // Admin-managed coupons.
  couponTable: process.env.MIGRATION_COUPON_TABLE || 'm_coupon',
  // The food master and its nutrition table, joined exactly as the legacy
  // admin's food list joined them.
  foodTable: process.env.MIGRATION_FOOD_TABLE || 'm_food',
  foodEnergyTable: process.env.MIGRATION_FOOD_ENERGY_TABLE || 'r_food_energy',
  // The workout master, and the plan link table that references it.
  workoutTable: process.env.MIGRATION_WORKOUT_TABLE || 'm_workout',
  workoutPlanLinkTable: process.env.MIGRATION_WORKOUT_PLAN_LINK_TABLE || 'r_workout_plan',
  /** Where the legacy workout media is served from (video and thumbnail subfolders). */
  legacyWorkoutMediaBaseUrl: (process.env.MIGRATION_LEGACY_WORKOUT_MEDIA_BASE_URL
    || 'https://apiimages.gogetfitonline.com/WorkOut/').replace(/\/?$/, '/'),
  /**
   * Where the legacy food pictures are served from. The database only ever held
   * a filename (m_food.image_file_name); the files themselves live in the
   * legacy admin's wwwroot/Images and are fetched over HTTP from here.
   */
  legacyImageBaseUrl: (process.env.MIGRATION_LEGACY_IMAGE_BASE_URL
    || 'https://apiimages.gogetfitonline.com/images/').replace(/\/?$/, '/'),
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
