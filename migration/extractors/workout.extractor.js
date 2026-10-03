import { query } from '../config/mariadb.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Read-only extraction of m_workout (docs/workouts-legacy.md).
 *
 * Deleted rows are included on purpose: legacy's delete_flg was never written
 * by the application and the admin list ignored it, so those 6 rows are real
 * data. The loader migrates them as archived rather than dropping them.
 *
 * m_workout has no create_date column - last_update_date is the only timestamp
 * the table carries.
 */
export const WORKOUT_COLUMNS = [
  'workout_id',
  'workout_name',
  'workout_type',
  'equipment',
  'primary_muscle',
  'secondary_muscle',
  'workout_level',
  'youtube_link',
  'description',
  'video_file_name',
  'thumbnail_file_name',
  'last_update_date',
  'delete_flg',
];

export const resolveWorkoutColumns = async (table = migrationEnv.workoutTable) => {
  const available = new Set((await query('SHOW COLUMNS FROM ??', [table])).map((row) => row.Field));
  if (!available.has('workout_id')) throw new Error(`Legacy table "${table}" has no workout_id column`);
  return {
    present: WORKOUT_COLUMNS.filter((c) => available.has(c)),
    missing: WORKOUT_COLUMNS.filter((c) => !available.has(c)),
  };
};

export const countWorkouts = async (table = migrationEnv.workoutTable) =>
  Number((await query('SELECT COUNT(*) AS total FROM ??', [table]))[0].total);

/** workout_id order, so a run is reproducible. */
export const extractWorkouts = async (table = migrationEnv.workoutTable) => {
  const { present } = await resolveWorkoutColumns(table);
  return query('SELECT ?? FROM ?? ORDER BY workout_id ASC', [present, table]);
};

/**
 * How many plan rows point at each workout. Reported so that archiving a
 * workout is a visible decision rather than a silent one, and so the migration
 * can show that referenced workouts survived.
 */
export const countPlanReferences = async (
  table = migrationEnv.workoutTable,
  planTable = migrationEnv.workoutPlanLinkTable,
) => {
  const [row] = await query(
    'SELECT COUNT(*) AS links, COUNT(DISTINCT workout_id) AS workouts FROM ??',
    [planTable],
  );
  const [orphans] = await query(
    'SELECT COUNT(*) AS n FROM ?? r WHERE NOT EXISTS (SELECT 1 FROM ?? w WHERE w.workout_id = r.workout_id)',
    [planTable, table],
  );
  return { links: Number(row.links), workouts: Number(row.workouts), orphanLinks: Number(orphans.n) };
};
