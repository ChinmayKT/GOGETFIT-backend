import test from 'node:test';
import assert from 'node:assert/strict';

import { renamedMeal } from '../../src/utils/food-log-rename.js';

const rice = { entryId: 'a', qty: 100, calories: 113 };

test('entries become foods, with no image', () => {
  assert.deepEqual(renamedMeal({ meal: 1, entries: [rice] }), { meal: 1, image: null, foods: [rice] });
});

test('foods already there win; stale entries are dropped, never added', () => {
  assert.deepEqual(renamedMeal({ meal: 1, foods: [rice], entries: [rice, rice] }), { meal: 1, image: null, foods: [rice] });
});

test('an image is kept; a meal already in shape is left alone', () => {
  const image = { url: 'u', storageKey: 'k' };
  assert.deepEqual(renamedMeal({ meal: 2, image, entries: [] }), { meal: 2, image, foods: [] });
  assert.equal(renamedMeal({ meal: 2, image: null, foods: [rice] }), null);
});
