import test from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import {
  BLOCKED_AMBIGUOUS_ENROLLMENT,
  BLOCKED_FOOD_SNAPSHOT,
  BLOCKED_MISSING_FOOD,
  BLOCKED_MISSING_USER,
  NOT_MIGRATED_NO_DATES,
  dateRuns,
  enrollmentForDay,
  legacyInstant,
  splitRunByEnrollment,
  transformDietPlan,
} from '../../migration/transformers/diet-plan.transformer.js';
import { gateByClient, selectForDay, shown, verifyPlanFields } from '../../migration/loaders/diet-plan.loader.js';

const clientId = new mongoose.Types.ObjectId();
const coachId = new mongoose.Types.ObjectId();
const rice = { _id: new mongoose.Types.ObjectId(), servingUnit: 'Grams', servingQuantity: 100 };
const egg = { _id: new mongoose.Types.ObjectId(), servingUnit: 'Piece', servingQuantity: 1 };
const foods = new Map([[14, rice], [27, egg]]);

const plan = (overrides = {}) => ({
  diet_plan_id: 61,
  diet_plan_name: 'Vinayak 35 meals plan ',
  user_id: 417,
  total_calories: 1601,
  fat: 36,
  carbs: 200,
  protein: 120,
  create_date: '2024-06-23 20:16:07',
  created_by: 332,
  last_update_date: '2024-06-23 20:16:07',
  bmr: 1543.15,
  tdee: 1851.78,
  goal: 'Fat/Weight Loss',
  ...overrides,
});

const row = (overrides = {}) => ({
  meal_id: 1,
  food_id: 14,
  quantity: 200,
  calories: 113,
  fats: 3.5,
  carbs: 19,
  proteins: 2,
  originalqty: 100,
  unit: 'grams',
  ...overrides,
});

const ctx = (overrides = {}) => ({
  source: 'gogetfit',
  days: ['2024-06-24', '2024-06-25'],
  mealRows: [row()],
  clientId,
  coachId,
  creatorLegacyCoachId: 17,
  enrollments: [],
  foods,
  ...overrides,
});

// ─── dates ───────────────────────────────────────────────────────────────────

test('sparse days become separate inclusive runs; duplicates collapse', () => {
  assert.deepEqual(dateRuns(['2026-01-05', '2026-01-01', '2026-01-02', '2026-01-02', '2026-01-06']), [
    { from: '2026-01-01', to: '2026-01-02' },
    { from: '2026-01-05', to: '2026-01-06' },
  ]);
  assert.deepEqual(dateRuns(['2024-02-28', '2024-02-29', '2024-03-01']), [{ from: '2024-02-28', to: '2024-03-01' }]);
  assert.deepEqual(dateRuns([]), []);
});

test('a sparse plan yields one document per run, sharing planId, and covers no gap day', () => {
  const r = transformDietPlan(plan(), ctx({ days: ['2026-01-01', '2026-01-02', '2026-01-05'] }));

  assert.equal(r.status, 'migratable');
  assert.equal(r.documents.length, 2);
  assert.deepEqual(r.documents.map((d) => d.planId), ['gogetfit:61', 'gogetfit:61']);
  // IST business days: 2026-01-01 starts at 2025-12-31T18:30Z.
  assert.equal(r.documents[0].fromDate.toISOString(), '2025-12-31T18:30:00.000Z');
  assert.equal(r.documents[0].toDate.toISOString(), '2026-01-01T18:30:00.000Z');
  assert.equal(r.documents[1].fromDate.toISOString(), '2026-01-04T18:30:00.000Z');
  assert.equal(r.documents[1].toDate.toISOString(), '2026-01-04T18:30:00.000Z');
  assert.deepEqual(r.documents.map((d) => d.legacy.segment), [{ index: 0, of: 2 }, { index: 1, of: 2 }]);
  for (const day of ['2026-01-03', '2026-01-04']) assert.equal(selectForDay(r.documents, clientId, day), null, day);
  for (const day of ['2026-01-01', '2026-01-02', '2026-01-05']) assert.ok(selectForDay(r.documents, clientId, day), day);
});

test('a dateless plan is not migrated and produces no document', () => {
  const r = transformDietPlan(plan(), ctx({ days: [] }));
  assert.equal(r.status, NOT_MIGRATED_NO_DATES);
  assert.deepEqual(r.documents, []);
});

test('legacy create_date is read as IST wall-clock time', () => {
  assert.equal(legacyInstant('2024-06-23 20:16:07').toISOString(), '2024-06-23T14:46:07.000Z');
  assert.equal(legacyInstant(null), null);
});

// ─── field mapping and snapshots ─────────────────────────────────────────────

test('plan fields map one to one from the legacy row', () => {
  const [d] = transformDietPlan(plan(), ctx()).documents;

  assert.equal(d.clientId, clientId);
  assert.equal(d.coachId, coachId);
  assert.equal(d.enrollmentId, null);
  assert.equal(d.name, 'Vinayak 35 meals plan '); // verbatim, trailing space kept
  assert.equal(d.assignedAt.toISOString(), '2024-06-23T14:46:07.000Z');
  assert.equal(d.bmr, 1543.15);
  assert.equal(d.tdee, 1851.78);
  assert.equal(d.goal, 'Fat/Weight Loss');
  assert.deepEqual(d.targets, { calories: 1601, fat: 36, carbs: 200, protein: 120 });
  assert.deepEqual(d.legacy, {
    source: 'gogetfit',
    dietPlanId: 61,
    createdBy: 332,
    createDate: new Date('2024-06-23T14:46:07.000Z'),
    lastUpdateDate: new Date('2024-06-23T14:46:07.000Z'),
    segment: { index: 0, of: 1 },
  });
});

test('food assignments snapshot the meal row, not the Food master', () => {
  const [d] = transformDietPlan(plan(), ctx({
    mealRows: [row(), row({ meal_id: 3, food_id: 27, quantity: 2, calories: 78, fats: 5.3, carbs: 0.6, proteins: 6.3, originalqty: 1, unit: 'Piece' })],
  })).documents;

  assert.deepEqual(d.meals, [
    { meal: 1, foods: [{ foodId: rice._id, qty: 200, portion: 100, servingUnit: 'Grams', calories: 113, fat: 3.5, carbs: 19, protein: 2 }] },
    { meal: 3, foods: [{ foodId: egg._id, qty: 2, portion: 1, servingUnit: 'Piece', calories: 78, fat: 5.3, carbs: 0.6, protein: 6.3 }] },
  ]);
  // Nothing of the Food master's identity is copied.
  for (const key of ['name', 'brand', 'image', 'servingQuantity']) assert.equal(key in d.meals[0].foods[0], false, key);
  // What the member reads: value / portion * qty.
  assert.equal(shown(113, 100, 200), 226);
  assert.equal(shown(5.3, 1, 2), 10.6);
});

test('the same food twice in a meal keeps both assignments in the given order', () => {
  const [d] = transformDietPlan(plan(), ctx({ mealRows: [row({ quantity: 100 }), row({ quantity: 200 })] })).documents;
  assert.deepEqual(d.meals[0].foods.map((f) => f.qty), [100, 200]);
});

test('a plan with dates but no visible food is migrated with no meals (it still wins its days)', () => {
  const r = transformDietPlan(plan(), ctx({ mealRows: [] }));
  assert.equal(r.status, 'migratable');
  assert.deepEqual(r.documents[0].meals, []);
});

test('segments do not share meal arrays', () => {
  const r = transformDietPlan(plan(), ctx({ days: ['2026-01-01', '2026-01-03'] }));
  assert.notEqual(r.documents[0].meals, r.documents[1].meals);
  assert.notEqual(r.documents[0].meals[0].foods[0], r.documents[1].meals[0].foods[0]);
});

// ─── reference failures ──────────────────────────────────────────────────────

test('a missing Mongo user blocks the plan; nothing is written for it', () => {
  const r = transformDietPlan(plan(), ctx({ clientId: null }));
  assert.equal(r.status, BLOCKED_MISSING_USER);
  assert.deepEqual(r.documents, []);
});

test('a food without a Mongo Food blocks the plan and names meal and food', () => {
  const r = transformDietPlan(plan(), ctx({ mealRows: [row({ meal_id: 2, food_id: 999 })] }));
  assert.equal(r.status, BLOCKED_MISSING_FOOD);
  assert.deepEqual(r.reasons[0], { code: BLOCKED_MISSING_FOOD, mealId: 2, foodId: 999, reason: 'legacy food_id 999 has no Mongo Food' });
});

test('a divisor or unit that disagrees with the migrated Food blocks the plan', () => {
  assert.equal(transformDietPlan(plan(), ctx({ mealRows: [row({ originalqty: 50 })] })).status, BLOCKED_FOOD_SNAPSHOT);
  assert.equal(transformDietPlan(plan(), ctx({ mealRows: [row({ unit: 'ML' })] })).status, BLOCKED_FOOD_SNAPSHOT);
  assert.equal(transformDietPlan(plan(), ctx({ mealRows: [row({ originalqty: 0 })] })).status, BLOCKED_FOOD_SNAPSHOT);
});

test('a missing coach leaves coachId null rather than inventing one', () => {
  const [d] = transformDietPlan(plan(), ctx({ coachId: null })).documents;
  assert.equal(d.coachId, null);
  assert.equal(d.legacy.createdBy, 332);
});

// ─── enrollments ─────────────────────────────────────────────────────────────

const e1 = { id: new mongoose.Types.ObjectId(), from: '2024-04-26', to: '2024-07-19', legacyCoachId: 17 };
const e2 = { id: new mongoose.Types.ObjectId(), from: '2024-06-17', to: '2024-09-09', legacyCoachId: 13 };

test('one covering enrollment links; none leaves null; overlap is settled only by the creator coach', () => {
  assert.deepEqual(enrollmentForDay('2024-05-01', [e1, e2], null), { id: e1.id });
  assert.deepEqual(enrollmentForDay('2024-10-01', [e1, e2], null), { id: null });
  assert.deepEqual(enrollmentForDay('2024-06-20', [e1, e2], 13), { id: e2.id, resolvedBy: 'creator_coach' });
  assert.ok(enrollmentForDay('2024-06-20', [e1, e2], null).ambiguous);
  assert.ok(enrollmentForDay('2024-06-20', [e1, e2], 99).ambiguous);
});

test('a run crossing an enrollment boundary is split there', () => {
  const parts = splitRunByEnrollment({ from: '2024-07-18', to: '2024-07-21' }, [e1], null);
  assert.deepEqual(parts.map((p) => [p.from, p.to, p.enrollmentId]), [
    ['2024-07-18', '2024-07-19', e1.id],
    ['2024-07-20', '2024-07-21', null],
  ]);
});

test('an unresolvable enrollment overlap blocks the plan', () => {
  const r = transformDietPlan(plan(), ctx({ days: ['2024-06-20'], enrollments: [e1, e2], creatorLegacyCoachId: null }));
  assert.equal(r.status, BLOCKED_AMBIGUOUS_ENROLLMENT);
});

// ─── precedence ──────────────────────────────────────────────────────────────

test('newest legacy create_date wins on a shared day, regardless of order', () => {
  const older = transformDietPlan(plan({ diet_plan_id: 70, create_date: '2024-01-01 10:00:00' }), ctx({ days: ['2024-06-24', '2024-06-25', '2024-06-26'] })).documents;
  const newer = transformDietPlan(plan({ diet_plan_id: 71, create_date: '2024-02-01 10:00:00' }), ctx({ days: ['2024-06-25'] })).documents;

  for (const docs of [[...older, ...newer], [...newer, ...older]]) {
    assert.equal(selectForDay(docs, clientId, '2024-06-24').legacy.dietPlanId, 70);
    assert.equal(selectForDay(docs, clientId, '2024-06-25').legacy.dietPlanId, 71);
    assert.equal(selectForDay(docs, clientId, '2024-06-26').legacy.dietPlanId, 70);
  }
  // The older plan keeps its shadowed day.
  assert.equal(older[0].toDate.toISOString(), '2024-06-25T18:30:00.000Z');
});

test('a client is migrated whole or not at all', () => {
  const results = gateByClient([
    { planId: 1, legacyUserId: 5, status: 'migratable', documents: [{}] },
    { planId: 2, legacyUserId: 5, status: BLOCKED_MISSING_FOOD, documents: [] },
    { planId: 3, legacyUserId: 6, status: 'migratable', documents: [{}] },
    { planId: 4, legacyUserId: 6, status: NOT_MIGRATED_NO_DATES, documents: [] },
  ]);
  assert.deepEqual(results.map((r) => r.status), ['blocked_client_has_blocked_plan', BLOCKED_MISSING_FOOD, 'migratable', NOT_MIGRATED_NO_DATES]);
});

test('every kept plan-level field is verified against m_diet_plan, and a wrong one is named', () => {
  const docs = transformDietPlan(plan(), ctx({ days: ['2026-01-01', '2026-01-03'] })).documents;
  const ok = verifyPlanFields(docs, [plan()], { legacyInstant });
  assert.deepEqual(ok.mismatches, []);
  for (const field of ['diet_plan_name', 'total_calories', 'fat', 'carbs', 'protein', 'bmr', 'tdee', 'goal', 'created_by']) {
    assert.equal(ok.checked[field], 2, field);
  }

  const wrong = docs.map((d, i) => (i === 1 ? { ...d, bmr: 1543.1, goal: null, targets: { ...d.targets, protein: 0 } } : d));
  assert.deepEqual(
    verifyPlanFields(wrong, [plan()], { legacyInstant }).mismatches.map((m) => [m.segment, m.field]),
    [[1, 'protein'], [1, 'bmr'], [1, 'goal']],
  );

  // NULL in legacy stays null.
  const nulls = transformDietPlan(plan({ bmr: null, tdee: null, goal: null }), ctx()).documents;
  assert.deepEqual(verifyPlanFields(nulls, [plan({ bmr: null, tdee: null, goal: null })], { legacyInstant }).mismatches, []);
  assert.deepEqual([nulls[0].bmr, nulls[0].tdee, nulls[0].goal], [null, null, null]);
});
