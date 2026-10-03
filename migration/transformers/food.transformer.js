import { canonicalFoodUnit } from '../../src/models/food.model.js';

/**
 * Pure transform: one joined m_food + r_food_energy row -> Food fields, or the
 * reasons it cannot be migrated. Nothing is repaired and nothing is guessed - a
 * row that does not map cleanly is reported by food_id and left behind.
 *
 * The nutrition always comes from r_food_energy (the `energy_*` aliases). The
 * m_food.calories/fat/carbs/protein columns are never read: the legacy Add Food
 * insert stopped writing them years ago, so they are NULL on every recent row.
 */

/** The two legacy food types, and the new value each one means. Nothing else maps. */
export const FOOD_TYPE_MAP = new Map([
  ['Veg.', 'Vegetarian'],
  ['NonVeg', 'Non-Vegetarian'],
]);

const text = (value) => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
};

const toInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
};

/**
 * Legacy qty is varchar. Accepts a plain decimal number only - anything else
 * (empty, text, "100g", a negative) is a problem to report, not to interpret.
 */
export const parseLegacyQuantity = (value) => {
  const s = text(value);
  if (s === null) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** A nutrition value must be present and a finite number >= 0. 0 is a real legacy value. */
export const parseNutritionValue = (value) => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Legacy delete_flg is '1' for a deleted food; anything else (including a missing column) is live. */
export const isDeleted = (value) => String(value ?? '').trim() === '1';

export const transformLegacyFood = (row, { source }) => {
  const problems = [];

  const foodId = toInt(row.food_id);
  if (foodId === null) problems.push('food_id is not an integer');

  const name = text(row.food_name);
  if (name === null) problems.push('food_name is empty');

  const rawType = text(row.food_type);
  const foodType = rawType === null ? null : FOOD_TYPE_MAP.get(rawType) ?? null;
  if (foodType === null) {
    problems.push(`food_type "${row.food_type}" is not one of ${[...FOOD_TYPE_MAP.keys()].join(', ')}`);
  }

  // Case is resolved ("grams" -> "Grams"); an unknown word is never guessed at.
  const rawUnit = text(row.unit);
  const unit = canonicalFoodUnit(rawUnit);
  if (unit === null) problems.push(`unit "${row.unit}" is not a supported portion unit`);

  const quantity = parseLegacyQuantity(row.qty);
  if (quantity === null) problems.push(`qty "${row.qty}" is not a number`);

  const nutrition = {};
  for (const [field, column] of [
    ['calories', 'energy_calories'],
    ['fat', 'energy_fat'],
    ['carbs', 'energy_carbs'],
    ['protein', 'energy_protein'],
  ]) {
    const value = parseNutritionValue(row[column]);
    if (value === null) problems.push(`${field} "${row[column]}" is missing or not a number >= 0`);
    nutrition[field] = value;
  }

  const deleted = isDeleted(row.delete_flg);

  return {
    foodId,
    name,
    deleted,
    problems,
    /** True when the unit only needed its case corrected - reported, not hidden. */
    unitNormalised: unit !== null && rawUnit !== null && rawUnit !== unit,
    rawUnit,
    /** Every macro is 0: legitimate legacy data, but worth seeing in the report. */
    zeroNutrition:
      problems.length === 0 &&
      nutrition.calories === 0 &&
      nutrition.fat === 0 &&
      nutrition.carbs === 0 &&
      nutrition.protein === 0,
    /** The legacy filename, for reporting only - never written to the Food document. */
    legacyImageFileName: text(row.image_file_name),
    food: {
      name,
      foodType,
      brand: text(row.brand_name),
      serving: { unit, quantity },
      // Straight from r_food_energy: not recalculated, not normalised to 100g,
      // not scaled by quantity. It describes exactly this serving.
      nutrition,
      notes: text(row.comments),
      // A filename is not an image. Migrated foods start with none; the bytes
      // are not available from the legacy database.
      image: null,
      // The only legacy data kept.
      legacy: { source, foodId },
    },
  };
};

export default transformLegacyFood;
