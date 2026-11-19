import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFoodFilter, foodSearchWords } from '../../src/services/food.service.js';

/** The food search's words: case, punctuation, brackets and spaces normalised. */
test('words: lower-cased, split on punctuation and brackets, spaces collapsed', () => {
  assert.deepEqual(foodSearchWords('  Paneer   (Low-Fat) '), ['paneer', 'low', 'fat']);
  assert.deepEqual(foodSearchWords('Greek [Plain]'), ['greek', 'plain']);
  assert.deepEqual(foodSearchWords('no, added; sugar!'), ['no', 'added', 'sugar']);
  assert.deepEqual(foodSearchWords('दाल 2'), ['दाल', '2'], 'any script, digits kept');
});

test('nothing meaningful is no search: empty, spaces, punctuation or regex characters only', () => {
  for (const q of [undefined, '', '   ', '(( ))', '.*', '[]{}^$|\\']) {
    assert.deepEqual(foodSearchWords(q), [], String(q));
    assert.equal(buildFoodFilter({ search: q }).$and, undefined, String(q));
  }
});

test('filter: every word in name, brand or comments; status and type kept', () => {
  const f = buildFoodFilter({ search: 'Amul paneer', foodType: 'Vegetarian' });
  assert.equal(f.status, 'active');
  assert.equal(f.foodType, 'Vegetarian');
  assert.equal(f.$and.length, 2);
  assert.deepEqual(f.$and[0].$or.map((c) => Object.keys(c)[0]), ['name', 'brand', 'notes']);
  assert.ok(f.$and[0].$or[0].name.test('AMUL'), 'case-insensitive');
});
