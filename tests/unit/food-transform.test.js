import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDeleted,
  parseLegacyQuantity,
  parseNutritionValue,
  transformLegacyFood,
} from '../../migration/transformers/food.transformer.js';
import { canonicalFoodUnit } from '../../src/models/food.model.js';

/** A joined m_food + r_food_energy row, as the extractor hands it over. */
const legacyFood = (overrides = {}) => ({
  food_id: 500,
  food_name: 'Paneer Cubes',
  food_type: 'Veg.',
  brand_name: 'Farm Fresh',
  unit: 'Grams',
  qty: '100',
  comments: null,
  image_file_name: '400c45ad-f8f2-456f-9e93-a6c855c37242.png',
  delete_flg: 0,
  energy_calories: 114,
  energy_fat: 2.6,
  energy_carbs: 0,
  energy_protein: 21,
  ...overrides,
});

const transform = (overrides) => transformLegacyFood(legacyFood(overrides), { source: 'gogetfit' });

test('a clean legacy row maps onto the new Food shape', () => {
  const t = transform();

  assert.deepEqual(t.problems, []);
  assert.deepEqual(t.food, {
    name: 'Paneer Cubes',
    foodType: 'Vegetarian',
    brand: 'Farm Fresh',
    serving: { unit: 'Grams', quantity: 100 },
    nutrition: { calories: 114, fat: 2.6, carbs: 0, protein: 21 },
    notes: null,
    image: null,
    legacy: { source: 'gogetfit', foodId: 500 },
  });
});

test('the only legacy data kept is source and foodId', () => {
  const t = transform({ created_by: '123', last_update_by: '123', delete_flg: 0 });

  assert.deepEqual(Object.keys(t.food.legacy), ['source', 'foodId']);
  assert.equal(t.food.createdBy, undefined);
  assert.equal(t.food.deleteFlg, undefined);
});

test('nutrition comes from r_food_energy, never from the m_food columns', () => {
  // m_food's own macro columns are abandoned and usually NULL; if a row carries
  // them they must still be ignored.
  const t = transform({ calories: 9999, fat: 9999, carbs: 9999, protein: 9999 });

  assert.deepEqual(t.food.nutrition, { calories: 114, fat: 2.6, carbs: 0, protein: 21 });
});

test('nutrition is preserved as entered: not scaled by quantity, not normalised to 100g', () => {
  const t = transform({ qty: '250', unit: 'ML', energy_calories: 45 });

  assert.equal(t.food.serving.quantity, 250);
  assert.equal(t.food.nutrition.calories, 45);
});

test('food types map only where legacy is explicit', () => {
  assert.equal(transform({ food_type: 'Veg.' }).food.foodType, 'Vegetarian');
  assert.equal(transform({ food_type: 'NonVeg' }).food.foodType, 'Non-Vegetarian');

  const stray = transform({ food_type: 'Veg' });
  assert.equal(stray.food.foodType, null);
  assert.match(stray.problems.join(), /food_type "Veg" is not one of/);
});

test('unit case is resolved, but an unknown unit is reported rather than guessed', () => {
  const lower = transform({ unit: 'grams' });
  assert.equal(lower.food.serving.unit, 'Grams');
  assert.equal(lower.unitNormalised, true);
  assert.deepEqual(lower.problems, []);

  const unknown = transform({ unit: 'Katori' });
  assert.equal(unknown.food.serving.unit, null);
  assert.match(unknown.problems.join(), /unit "Katori" is not a supported portion unit/);
});

test('one unit is never converted into another', () => {
  assert.equal(canonicalFoodUnit('ml'), 'ML');
  assert.equal(canonicalFoodUnit('Grams'), 'Grams');
  assert.equal(canonicalFoodUnit('gm'), null);
  assert.equal(canonicalFoodUnit('g'), null);
});

test('quantity accepts plain numbers only', () => {
  assert.equal(parseLegacyQuantity('100'), 100);
  assert.equal(parseLegacyQuantity('1.5'), 1.5);
  assert.equal(parseLegacyQuantity('0'), 0);
  assert.equal(parseLegacyQuantity('100g'), null);
  assert.equal(parseLegacyQuantity(''), null);
  assert.equal(parseLegacyQuantity(null), null);
  assert.equal(parseLegacyQuantity('-5'), null);
});

test('missing nutrition is a problem, zero is a legitimate value', () => {
  assert.equal(parseNutritionValue(0), 0);
  assert.equal(parseNutritionValue(null), null);
  assert.equal(parseNutritionValue('abc'), null);
  assert.equal(parseNutritionValue(-1), null);

  const missing = transform({ energy_fat: null });
  assert.match(missing.problems.join(), /fat "null" is missing or not a number/);

  const zeros = transform({ energy_calories: 0, energy_fat: 0, energy_carbs: 0, energy_protein: 0 });
  assert.deepEqual(zeros.problems, []);
  assert.equal(zeros.zeroNutrition, true);
});

test('empty name is a problem; blank brand and comments become null', () => {
  assert.match(transform({ food_name: '   ' }).problems.join(), /food_name is empty/);

  const t = transform({ brand_name: '   ', comments: '' });
  assert.equal(t.food.brand, null);
  assert.equal(t.food.notes, null);
});

test('the legacy image filename is reported but never written to the document', () => {
  const t = transform();

  assert.equal(t.food.image, null);
  assert.equal(t.legacyImageFileName, '400c45ad-f8f2-456f-9e93-a6c855c37242.png');
});

test('delete_flg = 1 is recognised in every form the column takes', () => {
  assert.equal(isDeleted('1'), true);
  assert.equal(isDeleted(1), true);
  assert.equal(isDeleted('0'), false);
  assert.equal(isDeleted(0), false);
  // Production has no delete_flg column at all: absent means live.
  assert.equal(isDeleted(undefined), false);
  assert.equal(transform({ delete_flg: 1 }).deleted, true);
});
