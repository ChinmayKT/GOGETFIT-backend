import test from 'node:test';
import assert from 'node:assert/strict';

import { energyBalanceStatusOf, totalsOf } from '../../src/services/daily-update.service.js';
import { validateDailyUpdateSubmission } from '../../src/validators/daily-update.validator.js';

const valid = { weightKg: 80, workoutMinutes: 60, steps: 8000, calorieOut: { bmr: 1542, tef: 220, eat: 150, neat: 144 } };
const eaten = (calories) => ({ consumed: { calories, protein: 100, carbs: 200, fat: 60 }, targets: null });

test('a valid body is cleaned to exactly what is accepted', () => {
  const out = validateDailyUpdateSubmission({
    ...valid,
    calorieOut: { ...valid.calorieOut, tef: 219.6, total: 1 },
    clientId: 'x',
    coachId: 'y',
    date: '2020-01-01',
    calorieIn: { calories: 99999 },
  });
  assert.deepEqual(out, { weightKg: 80, workoutMinutes: 60, steps: 8000, calorieOut: { bmr: 1542, tef: 220, eat: 150, neat: 144 }, submissionId: null });
});

test('unavailable parts are null, never 0', () => {
  const out = validateDailyUpdateSubmission({ ...valid, calorieOut: { bmr: 1542, tef: null } });
  assert.deepEqual(out.calorieOut, { bmr: 1542, tef: null, eat: null, neat: null });
});

test('the app\'s ranges and types are enforced', () => {
  const bad = [
    {},
    { ...valid, weightKg: 29.9 },
    { ...valid, weightKg: 250.1 },
    { ...valid, weightKg: '80' },
    { ...valid, workoutMinutes: 30.5 },
    { ...valid, workoutMinutes: 1441 },
    { ...valid, steps: -1 },
    { ...valid, steps: 200001 },
    { ...valid, calorieOut: null },
    { ...valid, calorieOut: { ...valid.calorieOut, bmr: -1 } },
    { ...valid, calorieOut: { ...valid.calorieOut, eat: Number.NaN } },
    { ...valid, calorieOut: { ...valid.calorieOut, neat: 20001 } },
    { ...valid, submissionId: 5 },
    { ...valid, submissionId: ' ' },
    { ...valid, submissionId: 'x'.repeat(101) },
  ];
  for (const body of bad) {
    assert.throws(() => validateDailyUpdateSubmission(body), (e) => e.code === 'VALIDATION_ERROR', JSON.stringify(body));
  }
});

test('total and balance only with every part and a Calorie In', () => {
  assert.deepEqual(totalsOf(valid.calorieOut, eaten(2000)), { total: 2056, energyBalance: { kcal: -56, status: 'negative' } });
  assert.deepEqual(totalsOf(valid.calorieOut, eaten(2056.4)), { total: 2056, energyBalance: { kcal: 0, status: 'neutral' } });
  assert.deepEqual(totalsOf(valid.calorieOut, eaten(2600)), { total: 2056, energyBalance: { kcal: 544, status: 'positive' } });
  // A missing part: no total, no balance - not a partial sum.
  assert.deepEqual(totalsOf({ ...valid.calorieOut, tef: null }, eaten(2000)), { total: null, energyBalance: { kcal: null, status: null } });
  // No food log (or nothing eaten): a total, but no balance.
  assert.deepEqual(totalsOf(valid.calorieOut, null), { total: 2056, energyBalance: { kcal: null, status: null } });
  assert.deepEqual(totalsOf(valid.calorieOut, eaten(0)), { total: 2056, energyBalance: { kcal: null, status: null } });
  assert.equal(energyBalanceStatusOf(-1), 'negative');
  assert.equal(energyBalanceStatusOf(0), 'neutral');
  assert.equal(energyBalanceStatusOf(1), 'positive');
});
