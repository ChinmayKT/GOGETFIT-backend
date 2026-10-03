import { query } from '../config/mariadb.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Read-only extraction of the legacy food picture filenames.
 *
 * m_food.image_file_name is all the legacy database ever held - a GUID filename
 * written by the legacy Add Food upload (docs/add-food-legacy.md). The bytes
 * live in the legacy admin's wwwroot/Images and are fetched over HTTP by the
 * loader; nothing about the image itself is stored in MariaDB.
 *
 * Deleted rows are left out: a food the food migration skipped must not gain a
 * picture here either.
 */
export const extractFoodImageNames = async (
  table = migrationEnv.foodTable,
  energyTable = migrationEnv.foodEnergyTable,
) => {
  const columns = new Set((await query('SHOW COLUMNS FROM ??', [table])).map((row) => row.Field));
  if (!columns.has('image_file_name')) {
    throw new Error(`Legacy table "${table}" has no image_file_name column`);
  }

  // delete_flg exists on staging but not on production, so the filter is only
  // applied where the column is actually there.
  const deleteFilter = columns.has('delete_flg') ? ' AND a.delete_flg <> 1' : '';

  return query(
    'SELECT a.food_id, a.food_name, a.image_file_name'
      + ' FROM ?? a INNER JOIN ?? b ON a.food_id = b.food_id'
      + ` WHERE a.image_file_name IS NOT NULL AND a.image_file_name <> ''${deleteFilter}`
      + ' ORDER BY a.food_id ASC',
    [table, energyTable],
  );
};

export const countFoodsWithoutImageName = async (
  table = migrationEnv.foodTable,
  energyTable = migrationEnv.foodEnergyTable,
) =>
  Number(
    (
      await query(
        'SELECT COUNT(*) AS total FROM ?? a INNER JOIN ?? b ON a.food_id = b.food_id'
          + " WHERE a.image_file_name IS NULL OR a.image_file_name = ''",
        [table, energyTable],
      )
    )[0].total,
  );

export default extractFoodImageNames;
