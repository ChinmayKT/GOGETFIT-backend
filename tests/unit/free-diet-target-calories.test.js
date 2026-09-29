import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dietTypeForFoodType,
  targetCaloriesFor,
} from '../../src/services/free-diet-plan-match.service.js';

const target = (bmr, tdee, goal) => targetCaloriesFor({ bmr, tdee, goal });

// --- fat loss ---------------------------------------------------------------

test('a normal gap takes the 250 kcal deficit', () => {
  // BMR 1500 / TDEE 2100: diff 600, and 1850 stays above BMR.
  assert.equal(target(1500, 2100, 'fatLoss'), 1850);
});

test('a deficit that would fall to or below BMR becomes BMR + 50', () => {
  // BMR 1500 / TDEE 1700: 1450 <= 1500, so the floor applies.
  assert.equal(target(1500, 1700, 'fatLoss'), 1550);
});

test('a gap of 800 or more takes the flat 400 kcal cut', () => {
  // BMR 1500 / TDEE 2300 -> 1900. Not 1800: the legacy rule subtracts 400 from
  // TDEE, and the figure quoted in the product note was wrong.
  assert.equal(target(1500, 2300, 'fatLoss'), 1900);
});

test('the 800 gap rule is evaluated before the BMR floor', () => {
  assert.equal(target(1500, 2300, 'fatLoss'), 1900);
  // One kcal under the threshold falls through to the 250 deficit.
  assert.equal(target(1500, 2299, 'fatLoss'), 2049);
});

test('the BMR boundary is inclusive, as the legacy code had it', () => {
  // TDEE - 250 == BMR exactly: the legacy test was `(b - 250) <= a`.
  assert.equal(target(1500, 1750, 'fatLoss'), 1550);
  assert.equal(target(1500, 1751, 'fatLoss'), 1501);
});

// --- gain and maintenance ---------------------------------------------------

test('muscle gain adds 150 to TDEE', () => {
  assert.equal(target(1500, 2100, 'muscleGain'), 2250);
});

test('maintenance adds 10 to TDEE', () => {
  assert.equal(target(1500, 2100, 'maintainPhysique'), 2110);
});

test('gain and maintenance ignore BMR entirely', () => {
  assert.equal(target(1000, 2300, 'muscleGain'), 2450);
  assert.equal(target(1000, 2300, 'maintainPhysique'), 2310);
});

test('an unknown goal yields no target rather than a default', () => {
  assert.equal(target(1500, 2100, 'getShredded'), null);
});

// --- food preference --------------------------------------------------------

test('each preference maps to the legacy template vocabulary', () => {
  assert.equal(dietTypeForFoodType('vegetarian'), 'Veg.');
  assert.equal(dietTypeForFoodType('nonVegetarian'), 'Veg/NonVeg');
  assert.equal(dietTypeForFoodType('vegetarianPlusEgg'), 'Veg/Egg');
  // Both spellings of the egg option resolve to the same diet type.
  assert.equal(dietTypeForFoodType('vegetarianEgg'), 'Veg/Egg');
});

test('the dead legacy spellings are never produced', () => {
  const produced = new Set(
    ['vegetarian', 'nonVegetarian', 'vegetarianPlusEgg', 'vegetarianEgg'].map(dietTypeForFoodType),
  );

  assert.equal(produced.has('NonVeg'), false);
  assert.equal(produced.has('VegEgg'), false);
  assert.deepEqual([...produced].sort(), ['Veg.', 'Veg/Egg', 'Veg/NonVeg']);
});

test('an unknown preference resolves to nothing, never a guess', () => {
  assert.equal(dietTypeForFoodType('pescatarian'), null);
  assert.equal(dietTypeForFoodType(null), null);
});
