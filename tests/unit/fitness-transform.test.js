import test from 'node:test';
import assert from 'node:assert/strict';

import {
  transformLegacyFitness,
  transformMeasurement,
} from '../../migration/transformers/fitness.transformer.js';

test('real measurements are preserved exactly', () => {
  assert.equal(transformMeasurement(171), 171);
  assert.equal(transformMeasurement(60.1), 60.1);
  assert.equal(transformMeasurement(16.923), 16.923);
});

test('NULL and empty legacy values become null', () => {
  assert.equal(transformMeasurement(null), null);
  assert.equal(transformMeasurement(undefined), null);
  assert.equal(transformMeasurement(''), null);
});

test('a legacy zero is read as missing, never stored as 0', () => {
  // 0 cm / 0 kg / 0% are not measurements; the legacy system used them for
  // "never filled in", and the new model forbids 0 as a stand-in for null.
  assert.equal(transformMeasurement(0), null);
  assert.equal(transformMeasurement(-5), null);
});

test('legacy rows map onto the canonical fitness shape', () => {
  const fitness = transformLegacyFitness({
    height: 174,
    weight: 65,
    fat: 16.923,
    bmr: 1520,
    tdee: 2356,
  });

  assert.deepEqual(fitness, {
    height: 174,
    weight: 65,
    // Stored to two decimals.
    bodyFatPercentage: 16.92,
    activityLevel: null,
    foodType: null,
    goal: null,
    bmr: 1520,
    // Legacy tdee is stored under this system's name.
    tdee: 2356,
  });
});

test('the three unsourced preferences are always null, never guessed', () => {
  const fitness = transformLegacyFitness({ height: 180, weight: 91, fat: 21.184 });

  assert.equal(fitness.activityLevel, null);
  assert.equal(fitness.foodType, null);
  assert.equal(fitness.goal, null);
});

test('an all-null legacy row produces an all-null fitness profile', () => {
  assert.deepEqual(
    transformLegacyFitness({ height: null, weight: null, fat: null, bmr: null, tdee: null }),
    {
      height: null,
      weight: null,
      bodyFatPercentage: null,
      activityLevel: null,
      foodType: null,
      goal: null,
      bmr: null,
      tdee: null,
    },
  );
});

test('body fat is rounded to two decimal places for storage', () => {
  assert.equal(transformLegacyFitness({ fat: 17.612980578676176 }).bodyFatPercentage, 17.61);
  assert.equal(transformLegacyFitness({ fat: 16.923 }).bodyFatPercentage, 16.92);
  assert.equal(transformLegacyFitness({ fat: 21.184 }).bodyFatPercentage, 21.18);
});

test('values at or under two decimals are unchanged by rounding', () => {
  // 15.90 and 15.9 are the same number; a trailing zero is display, not storage.
  assert.equal(transformLegacyFitness({ fat: 15.9 }).bodyFatPercentage, 15.9);
  assert.equal(transformLegacyFitness({ fat: 16 }).bodyFatPercentage, 16);
});

test('rounding never turns a missing value into a number', () => {
  assert.equal(transformLegacyFitness({ fat: null }).bodyFatPercentage, null);
  assert.equal(transformLegacyFitness({ fat: 0 }).bodyFatPercentage, null);
});

test('height and weight keep their own precision', () => {
  const fitness = transformLegacyFitness({ height: 174, weight: 65.375, fat: 16.923 });
  assert.equal(fitness.height, 174);
  assert.equal(fitness.weight, 65.375);
});

// --- energy figures (legacy bmr / tdee) ------------------------------------

test('legacy bmr and tdee map onto fitnessProfile.bmr and .tdee', () => {
  const fitness = transformLegacyFitness({ bmr: 1613, tdee: 1936 });

  assert.equal(fitness.bmr, 1613);
  assert.equal(fitness.tdee, 1936, 'the legacy tdee column keeps its name');
});

test('the retired rdee key is never produced', () => {
  const fitness = transformLegacyFitness({ bmr: 1613, tdee: 1936 });

  assert.equal(fitness.tdee, 1936);
  assert.equal(Object.prototype.hasOwnProperty.call(fitness, 'rdee'), false);
});

test('a legacy energy zero is the empty marker, stored as null', () => {
  // In staging every zero is a bmr/tdee pair, in a nullable int(4) column whose
  // default is NULL: 0 is how the legacy system recorded "never computed".
  const fitness = transformLegacyFitness({ bmr: 0, tdee: 0 });

  assert.equal(fitness.bmr, null);
  assert.equal(fitness.tdee, null);
});

test('a negative legacy energy value is also read as missing', () => {
  const fitness = transformLegacyFitness({ bmr: -238, tdee: -286 });

  assert.equal(fitness.bmr, null);
  assert.equal(fitness.tdee, null);
});

test('missing energy values are never calculated from height and weight', () => {
  const fitness = transformLegacyFitness({ height: 174, weight: 65, fat: 16.923 });

  assert.equal(fitness.bmr, null);
  assert.equal(fitness.tdee, null);
});

test('an unusual but positive energy figure is preserved, not corrected', () => {
  // Staging holds one such row (bmr 120 / tdee 123). Implausible is not the
  // same as empty, so the stored number is carried across untouched.
  const fitness = transformLegacyFitness({ bmr: 120, tdee: 123 });

  assert.equal(fitness.bmr, 120);
  assert.equal(fitness.tdee, 123);
});

test('tdee is never derived from bmr', () => {
  const fitness = transformLegacyFitness({ bmr: 1520, tdee: null });

  assert.equal(fitness.bmr, 1520);
  assert.equal(fitness.tdee, null);
});
