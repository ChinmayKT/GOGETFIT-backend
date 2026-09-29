import test from 'node:test';
import assert from 'node:assert/strict';

import {
  transformLegacyPlan,
  transformNumber,
  transformPlanFood,
} from '../../migration/transformers/plan.transformer.js';

const planRow = {
  plan_id: 5,
  diet_type: 'Veg.',
  range_from: '800',
  range_to: '840',
  create_date: '2022-01-12 18:50:19',
  created_by: '123',
  last_update_date: '2023-05-11 00:25:44',
  last_update_by: '123',
};

const mealRow = (overrides = {}) => ({
  food_id: 13350,
  plan_id: 5,
  meal_id: 1,
  food_name: 'Bread',
  food_type: '',
  unit: 'slice',
  qty: '1',
  calories: 69,
  fat: 1,
  carbs: 12.5,
  protein: 2.5,
  ...overrides,
});

test('legacy varchar ranges become numbers', () => {
  assert.equal(transformNumber('800'), 800);
  assert.equal(transformNumber('1.5'), 1.5);
  assert.equal(transformNumber(840), 840);
});

test('a value that is not a number stays null rather than being guessed', () => {
  assert.equal(transformNumber(null), null);
  assert.equal(transformNumber(''), null);
  assert.equal(transformNumber('abc'), null);
});

test('a plan row maps onto the FreeDietPlan shape', () => {
  const doc = transformLegacyPlan(planRow, [mealRow()], { source: 'gogetfit' });

  assert.equal(doc.dietType, 'Veg.');
  assert.deepEqual(doc.range, { from: 800, to: 840 });
  assert.equal(doc.status, 'active');
  assert.equal(doc.legacy.source, 'gogetfit');
  assert.equal(doc.legacy.planId, 5);
  // The legacy audit columns travel with the document.
  assert.equal(doc.legacy.createdBy, '123');
  assert.ok(doc.legacy.createdAt instanceof Date);
  assert.ok(doc.legacy.updatedAt instanceof Date);
});

test('the legacy diet type is preserved verbatim, including "Select"', () => {
  // Two legacy rows hold the dropdown's placeholder. Migration does not clean it.
  const doc = transformLegacyPlan({ ...planRow, diet_type: 'Select' }, [], { source: 'gogetfit' });

  assert.equal(doc.dietType, 'Select');
});

test('r_plan_meal.food_id is stored as a row id, never as a food reference', () => {
  const food = transformPlanFood(mealRow({ food_id: 229 }));

  assert.equal(food.legacyPlanMealId, 229);
  // Nothing named foodId exists: it is not m_food.food_id.
  assert.equal(Object.prototype.hasOwnProperty.call(food, 'foodId'), false);
});

test('a food row keeps its name, unit, quantity and nutrition', () => {
  const food = transformPlanFood(mealRow());

  assert.equal(food.foodName, 'Bread');
  assert.equal(food.unit, 'slice');
  assert.equal(food.quantity, 1);
  assert.equal(food.calories, 69);
  assert.equal(food.fat, 1);
  assert.equal(food.carbs, 12.5);
  assert.equal(food.protein, 2.5);
});

test('the empty legacy food_type becomes null, not an empty string', () => {
  assert.equal(transformPlanFood(mealRow({ food_type: '' })).foodType, null);
  assert.equal(transformPlanFood(mealRow({ food_type: 'V' })).foodType, 'V');
});

test('a zero-calorie food row is preserved, never dropped or corrected', () => {
  // 457 legacy rows record 0 calories; they are authored data, not a sentinel.
  const food = transformPlanFood(mealRow({ calories: 0 }));

  assert.equal(food.calories, 0);
});

test('meals are grouped by meal_id in ascending order', () => {
  const doc = transformLegacyPlan(
    planRow,
    [
      mealRow({ food_id: 3, meal_id: 2, food_name: 'Dal' }),
      mealRow({ food_id: 1, meal_id: 1, food_name: 'Bread' }),
      mealRow({ food_id: 2, meal_id: 1, food_name: 'Cheese' }),
    ],
    { source: 'gogetfit' },
  );

  assert.deepEqual(
    doc.meals.map((meal) => meal.mealId),
    [1, 2],
  );
});

test('food order inside a meal follows the order the rows arrive in', () => {
  // extractPlanMeals orders by (plan_id, meal_id, food_id), which is the order
  // the legacy grid showed, so the transformer must not re-sort.
  const doc = transformLegacyPlan(
    planRow,
    [
      mealRow({ food_id: 10, food_name: 'Bread' }),
      mealRow({ food_id: 11, food_name: 'Cheese' }),
      mealRow({ food_id: 12, food_name: 'Butter' }),
    ],
    { source: 'gogetfit' },
  );

  assert.deepEqual(
    doc.meals[0].foods.map((food) => food.foodName),
    ['Bread', 'Cheese', 'Butter'],
  );
});

test('an empty template produces no meals rather than five empty ones', () => {
  // 5 legacy templates have no food rows at all. Inventing meal shells would be
  // inventing structure the source does not have.
  const doc = transformLegacyPlan(planRow, [], { source: 'gogetfit' });

  assert.deepEqual(doc.meals, []);
});

test('a missing meal 5 stays missing', () => {
  // 504 legacy templates have no meal 5.
  const doc = transformLegacyPlan(
    planRow,
    [mealRow({ meal_id: 1 }), mealRow({ food_id: 2, meal_id: 4 })],
    { source: 'gogetfit' },
  );

  assert.deepEqual(
    doc.meals.map((meal) => meal.mealId),
    [1, 4],
  );
  assert.equal(
    doc.meals.some((meal) => meal.mealId === 5),
    false,
  );
});

test('a meal over the legacy 8-row cap is migrated whole', () => {
  // Plan 459 meal 2 holds 12 rows: the cap was a UI rule, not a data rule.
  const rows = Array.from({ length: 12 }, (_, i) => mealRow({ food_id: 100 + i }));
  const doc = transformLegacyPlan(planRow, rows, { source: 'gogetfit' });

  assert.equal(doc.meals[0].foods.length, 12);
});

test('no root-level meal, food or plan_id fields are produced', () => {
  const doc = transformLegacyPlan(planRow, [mealRow()], { source: 'gogetfit' });

  for (const field of ['plan_id', 'planId', 'foods', 'meal_id', 'diet_type']) {
    assert.equal(Object.prototype.hasOwnProperty.call(doc, field), false, field);
  }
});
