import { query } from '../config/mariadb.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Read-only extraction of the legacy food master (docs/foods-legacy.md).
 *
 * The join is the legacy admin's own: m_food INNER JOIN r_food_energy ON
 * food_id. That inner join is what makes a food visible in the legacy system at
 * all, so a food it excludes was never usable there either.
 *
 * Nothing here filters out deleted rows - the counts have to show them before
 * the loader skips them, which is why delete_flg is extracted rather than
 * applied in SQL.
 */

/** m_food columns the new Food document needs, plus the ones the report counts. */
export const FOOD_COLUMNS = [
  'food_id',
  'food_name',
  'food_type',
  'brand_name',
  'unit',
  'qty',
  'comments',
  'image_file_name',
  'delete_flg',
];

/** r_food_energy is the authoritative nutrition source; m_food's own macro columns are never read. */
export const ENERGY_COLUMNS = ['calories', 'fat', 'carbs', 'protein'];

export const resolveFoodColumns = async (
  table = migrationEnv.foodTable,
  energyTable = migrationEnv.foodEnergyTable,
) => {
  const foodColumns = new Set((await query('SHOW COLUMNS FROM ??', [table])).map((row) => row.Field));
  const energyColumns = new Set((await query('SHOW COLUMNS FROM ??', [energyTable])).map((row) => row.Field));

  if (!foodColumns.has('food_id')) throw new Error(`Legacy table "${table}" has no food_id column`);
  if (!energyColumns.has('food_id')) throw new Error(`Legacy table "${energyTable}" has no food_id column`);

  const missingEnergy = ENERGY_COLUMNS.filter((c) => !energyColumns.has(c));
  if (missingEnergy.length > 0) {
    throw new Error(`Legacy table "${energyTable}" is missing nutrition column(s): ${missingEnergy.join(', ')}`);
  }

  return {
    present: FOOD_COLUMNS.filter((c) => foodColumns.has(c)),
    // delete_flg exists on staging and NOT on production: its absence is
    // reported, never silently treated as "nothing is deleted".
    missing: FOOD_COLUMNS.filter((c) => !foodColumns.has(c)),
  };
};

export const countFoods = async (table = migrationEnv.foodTable) =>
  Number((await query('SELECT COUNT(*) AS total FROM ??', [table]))[0].total);

export const countEnergyRows = async (energyTable = migrationEnv.foodEnergyTable) =>
  Number((await query('SELECT COUNT(*) AS total FROM ??', [energyTable]))[0].total);

/** The exact row count of the legacy list join, counted rather than inferred. */
export const countJoinedFoods = async (
  table = migrationEnv.foodTable,
  energyTable = migrationEnv.foodEnergyTable,
) =>
  Number(
    (
      await query('SELECT COUNT(*) AS total FROM ?? a INNER JOIN ?? b ON a.food_id = b.food_id', [
        table,
        energyTable,
      ])
    )[0].total,
  );

/** m_food rows with no r_food_energy row: invisible in legacy, and not migrated. */
export const findFoodsWithoutEnergy = async (
  table = migrationEnv.foodTable,
  energyTable = migrationEnv.foodEnergyTable,
) =>
  query(
    'SELECT a.food_id, a.food_name FROM ?? a LEFT JOIN ?? b ON a.food_id = b.food_id WHERE b.food_id IS NULL ORDER BY a.food_id ASC',
    [table, energyTable],
  );

/** r_food_energy rows whose food no longer exists. Nothing can be migrated from them. */
export const findOrphanEnergyRows = async (
  table = migrationEnv.foodTable,
  energyTable = migrationEnv.foodEnergyTable,
) =>
  query(
    'SELECT b.food_id FROM ?? b LEFT JOIN ?? a ON a.food_id = b.food_id WHERE a.food_id IS NULL ORDER BY b.food_id ASC',
    [energyTable, table],
  );

/**
 * The joined rows, food_id ascending so a run is reproducible. Deleted rows are
 * included on purpose: the loader skips and reports them by id.
 *
 * Nutrition is aliased (energy_*) so that m_food's identically named, abandoned
 * macro columns can never be read by mistake.
 */
export const extractFoods = async (
  table = migrationEnv.foodTable,
  energyTable = migrationEnv.foodEnergyTable,
) => {
  const { present } = await resolveFoodColumns(table, energyTable);
  return query(
    'SELECT ??, b.calories AS energy_calories, b.fat AS energy_fat, b.carbs AS energy_carbs, b.protein AS energy_protein'
      + ' FROM ?? a INNER JOIN ?? b ON a.food_id = b.food_id ORDER BY a.food_id ASC',
    [present.map((column) => `a.${column}`), table, energyTable],
  );
};
