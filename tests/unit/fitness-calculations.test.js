import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_LEVELS,
  FITNESS_GOALS,
  FOOD_TYPES,
  computeBmr,
  computeBodyFatPercentage,
  computeTdee,
  deriveFitnessFigures,
} from '../../src/utils/fitness-calculations.js';

/**
 * Produced by running the Flutter app's own functions
 * (lib/features/calculators/domain/bmr_tdee_classification.dart:
 * computeBodyFatPercentage, computeBmr, computeTdee) with `dart run`.
 * gender, age, heightCm, weightKg, activityLevel -> bodyFat, bmr, tdee
 */
const DART_VECTORS = [
  ['male', 28, 170.7, 72.5, 'moderate', 20.097415397983905, 1656.875, 2568.15625],
  ['female', 35, 158.5, 61.2, 'light', 31.88305038362408, 1266.625, 1741.609375],
  ['male', 13, 121.9, 30.0, 'sedentary', 11.01674619320426, 1001.875, 1202.25],
  ['female', 100, 243.8, 250.0, 'veryActive', 68.07238790250886, 3362.75, 6389.224999999999],
  ['male', 45, 182.9, 95.4, 'active', 28.371749643747645, 1877.125, 3238.040625],
];

test('body fat, BMR and TDEE are identical to the Flutter app for the same inputs', () => {
  for (const [gender, age, heightCm, weightKg, activityLevel, bodyFat, bmr, tdee] of DART_VECTORS) {
    assert.equal(computeBodyFatPercentage({ gender, weightKg, heightCm, age }), bodyFat);
    assert.equal(computeBmr({ gender, weightKg, heightCm, age }), bmr);
    assert.equal(computeTdee({ bmr, activityLevel }), tdee);
    assert.deepEqual(deriveFitnessFigures({ gender, age, heightCm, weightKg, activityLevel }), { bodyFatPercentage: bodyFat, bmr, tdee });
  }
});

test('the option values are the app enum names', () => {
  assert.deepEqual(ACTIVITY_LEVELS.map((a) => a.value), ['sedentary', 'light', 'moderate', 'active', 'veryActive']);
  assert.deepEqual(ACTIVITY_LEVELS.map((a) => a.multiplier), [1.2, 1.375, 1.55, 1.725, 1.9]);
  assert.deepEqual(FOOD_TYPES, ['vegetarian', 'nonVegetarian', 'vegetarianPlusEgg']);
  assert.deepEqual(FITNESS_GOALS, ['fatLoss', 'muscleGain', 'maintainPhysique']);
});

test('a missing input gives null figures, as the app omits them', () => {
  assert.deepEqual(deriveFitnessFigures({ gender: null, age: 30, heightCm: 170, weightKg: 70, activityLevel: 'light' }), { bodyFatPercentage: null, bmr: null, tdee: null });
  assert.equal(deriveFitnessFigures({ gender: 'male', age: 30, heightCm: 170, weightKg: 70, activityLevel: null }).tdee, null);
});
