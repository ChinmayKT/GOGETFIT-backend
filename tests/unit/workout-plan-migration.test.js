import test from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import {
  UNDATED_REPORT_ONLY,
  planWorkoutMigration,
  replayWorkoutPlans,
  selectWorkoutPlanForDay,
  validateWorkoutPlans,
  verifyWorkoutPlanFields,
} from '../../migration/loaders/workout-plan.loader.js';
import { assertSource, humanReport, parseArgs } from '../../migration/scripts/migrate-workout-plans.js';

/**
 * The workout-plan dry run without any database: classification (undated
 * plans report only; one held plan holds its client), the in-memory day rule,
 * the replay against fake legacy reads, and the command's guards.
 */
const alice = new mongoose.Types.ObjectId();
const bob = new mongoose.Types.ObjectId();
const squat = { _id: new mongoose.Types.ObjectId(), name: 'Squat', status: 'active' };
const plank = { _id: new mongoose.Types.ObjectId(), name: 'Plank', status: 'active' };

const refs = {
  clientIdByLegacyUserId: new Map([[501, alice], [502, bob]]),
  coachIdByLegacyUserId: new Map(),
  enrollmentsByClient: new Map(),
  workoutsByLegacyId: new Map([[12, squat], [40, plank]]),
};
const plan = (id, userId, created) => ({
  workout_plan_id: id, workout_plan_name: `P${id}`, user_id: userId, created_by: 9, create_date: created, last_update_date: created,
});
const fixture = () => ({
  plans: [
    plan(1, 501, '2024-05-10 09:00:00'),
    plan(2, 501, '2024-05-12 09:00:00'), // newer: wins the shared day
    plan(3, 501, '2024-05-13 09:00:00'), // undated
    plan(4, 502, '2024-05-10 09:00:00'), // missing exercise 999 -> holds bob
    plan(5, 0, '2024-05-10 09:00:00'), // client 0 -> blocked
  ],
  categories: [1, 2, 3, 4, 5].map((id) => ({ workout_plan_id: id, workout_category_id: 70 + id, workout_category_name: 'Warm up' })),
  exercises: [
    { workout_plan_id: 1, workout_category_id: 71, workout_id: 40, sets_count: '3', reps_count: '30sec', workout_exists: 1 },
    { workout_plan_id: 1, workout_category_id: 71, workout_id: 12, sets_count: '1', reps_count: '20', workout_exists: 1 },
    { workout_plan_id: 2, workout_category_id: 72, workout_id: 12, sets_count: '2', reps_count: '12-15', workout_exists: 1 },
    { workout_plan_id: 3, workout_category_id: 73, workout_id: 12, sets_count: '2', reps_count: '10', workout_exists: 1 },
    { workout_plan_id: 4, workout_category_id: 74, workout_id: 999, sets_count: '2', reps_count: '10', workout_exists: 0 },
    { workout_plan_id: 5, workout_category_id: 75, workout_id: 12, sets_count: '2', reps_count: '10', workout_exists: 1 },
  ],
  dateRows: [
    { workout_plan_id: 1, day: '2024-05-14' },
    { workout_plan_id: 1, day: '2024-05-17' },
    { workout_plan_id: 1, day: '2024-05-17' }, // duplicate row: collapses
    { workout_plan_id: 2, day: '2024-05-17' },
    { workout_plan_id: 4, day: '2024-05-14' },
    { workout_plan_id: 5, day: '2024-05-14' },
    { workout_plan_id: 0, day: '2024-05-14' }, // orphan
  ],
});

test('classification: undated report only, one held plan holds its client, client 0 blocked, orphans reported', () => {
  const f = fixture();
  const { results, documents, orphans } = planWorkoutMigration({ ...f, refs });
  const by = Object.fromEntries(results.map((r) => [r.legacyWorkoutPlanId, r.disposition]));
  assert.deepEqual(by, { 1: 'migrate', 2: 'migrate', 3: UNDATED_REPORT_ONLY, 4: 'held_needs_decision', 5: 'blocked' });
  assert.deepEqual(documents.map((d) => d.planId), ['gogetfit:1', 'gogetfit:2'], 'nothing undated, held or blocked is written');
  assert.equal(documents[0].selectedDates.length, 2, 'duplicate date rows collapse');
  assert.ok(documents.every((d) => d.enrollmentId === null));
  assert.deepEqual(orphans.map((r) => r.workout_plan_id), [0]);

  // Accepting the decision releases bob; nothing else changes.
  const accepted = planWorkoutMigration({ ...f, refs, accepted: new Set(['exercise_missing']) });
  assert.deepEqual(accepted.documents.map((d) => d.planId), ['gogetfit:1', 'gogetfit:2', 'gogetfit:4']);
});

test('a client with two dated plans, one held, migrates neither', () => {
  const f = fixture();
  f.exercises.push({ workout_plan_id: 2, workout_category_id: 72, workout_id: 999, sets_count: '1', reps_count: '1', workout_exists: 0 });
  const { results, documents } = planWorkoutMigration({ ...f, refs });
  assert.equal(results.find((r) => r.legacyWorkoutPlanId === 1).disposition, 'held_by_client');
  assert.equal(results.find((r) => r.legacyWorkoutPlanId === 2).disposition, 'held_needs_decision');
  assert.deepEqual(documents, []);
});

test('documents validate and their header fields match the legacy rows', async () => {
  const f = fixture();
  const { documents } = planWorkoutMigration({ ...f, refs });
  assert.deepEqual(await validateWorkoutPlans(documents), []);
  const fields = verifyWorkoutPlanFields(documents, f.plans, f.dateRows);
  assert.deepEqual(fields.mismatches, []);
  const broken = [{ ...documents[0], name: 'renamed' }];
  assert.equal(verifyWorkoutPlanFields(broken, f.plans, f.dateRows).mismatches[0].field, 'workout_plan_name -> name');
});

test('the in-memory day rule: exact days only, newest wins, then higher legacy id', () => {
  const { documents } = planWorkoutMigration({ ...fixture(), refs });
  const on = (day) => selectWorkoutPlanForDay(documents, alice, day)?.planId ?? null;
  assert.equal(on('2024-05-14'), 'gogetfit:1');
  assert.equal(on('2024-05-17'), 'gogetfit:2');
  assert.equal(on('2024-05-15'), null);
  assert.equal(selectWorkoutPlanForDay(documents, bob, '2024-05-14'), null);
});

/** A fake legacy runtime that answers like the verbatim SQL would. */
const legacyRuntime = (f) => {
  const newestFirst = [...f.plans].sort((a, b) => b.create_date.localeCompare(a.create_date));
  return {
    legacySelect: async (userId, day) => {
      const hit = newestFirst.find((p) => p.user_id === userId && f.dateRows.some((r) => r.workout_plan_id === p.workout_plan_id && r.day === day));
      return hit ? { workout_plan_id: hit.workout_plan_id, workout_plan_name: hit.workout_plan_name } : null;
    },
    legacyContent: async (planId) =>
      f.categories.filter((c) => c.workout_plan_id === planId).map((c) => ({
        id: c.workout_category_id,
        name: c.workout_category_name,
        // As returned (no ORDER BY): here, reverse id order.
        exercises: f.exercises
          .filter((e) => e.workout_plan_id === planId && e.workout_category_id === c.workout_category_id && e.workout_exists)
          .map((e) => ({ workout_id: e.workout_id, workout_name: e.workout_id === 12 ? 'Squat' : 'Plank', sets_count: e.sets_count, reps_count: e.reps_count })),
      })),
    shownInLegacy: new Set(f.exercises.filter((e) => e.workout_exists).map((e) => e.workout_id)),
  };
};

test('replay: 0 mismatches against the legacy runtime; order as returned is reported, not gating', async () => {
  const f = fixture();
  const { documents } = planWorkoutMigration({ ...f, refs });
  const out = await replayWorkoutPlans({ documents, clients: [{ legacyUserId: 501, clientId: alice, days: ['2024-05-14', '2024-05-17'] }], ...legacyRuntime(f) });
  assert.deepEqual(out.mismatches, []);
  assert.equal(out.days, 6); // 13,14,15 + 16,17,18
  assert.equal(out.assignedDays, 2);
  assert.equal(out.plansCompared, 2);
  assert.equal(out.orderAsReturnedDiffers, 1, 'plan 1 came back 40,12; stored 12,40');
});

test('replay catches a wrong winner and changed content', async () => {
  const f = fixture();
  const { documents } = planWorkoutMigration({ ...f, refs });
  const wrongWinner = documents.map((d) => (d.planId === 'gogetfit:1' ? { ...d, assignedAt: new Date('2025-01-01') } : d));
  const a = await replayWorkoutPlans({ documents: wrongWinner, clients: [{ legacyUserId: 501, clientId: alice, days: ['2024-05-17'] }], ...legacyRuntime(f) });
  assert.deepEqual(a.mismatches.map((m) => [m.day, m.field, m.legacy, m.mongo]), [['2024-05-17', 'selectedPlan', 2, 1]]);

  const changed = documents.map((d) => (d.planId === 'gogetfit:2'
    ? { ...d, blocks: [{ ...d.blocks[0], exercises: [{ ...d.blocks[0].exercises[0], repsRaw: '12' }] }] }
    : d));
  const b = await replayWorkoutPlans({ documents: changed, clients: [{ legacyUserId: 501, clientId: alice, days: ['2024-05-17'] }], ...legacyRuntime(f) });
  assert.equal(b.mismatches.length, 1);
  assert.match(b.mismatches[0].field, /exercises/);
});

test('the command: staging only, no apply, configured database must match', () => {
  assert.throws(() => parseArgs([]), /--source/);
  assert.throws(() => parseArgs(['--source=production']), /--source/);
  assert.throws(() => parseArgs(['--source=staging', '--apply']), /dry-run only/);
  const o = parseArgs(['--source=staging', '--report=/tmp/x', '--accept=exercise_missing, no_exercises']);
  assert.deepEqual([o.source, o.reportDir, [...o.accepted]], ['staging', '/tmp/x', ['exercise_missing', 'no_exercises']]);
  assert.doesNotThrow(() => assertSource('staging', 'staging-ggf'));
  assert.throws(() => assertSource('staging', 'gogetfit'), /Refusing/);
});

test('the human report never carries a plan name', () => {
  const md = humanReport({
    runId: 'r', source: 'staging', legacyDatabase: 'staging-ggf', target: { database: 'gogetfit' }, result: 'DRY RUN PASS',
    acceptedDecisionCodes: [], counts: { legacyPlans: 1 }, byDisposition: { migrate: 1 }, plans: [], issuesByCode: {}, coachSources: {},
    enrollmentIdSet: 0, validationErrors: [], planFields: { mismatches: [] },
    replay: { days: 0, assignedDays: 0, emptyDays: 0, plansCompared: 0, exercisesCompared: 0, orderAsReturnedAgrees: 0, orderAsReturnedDiffers: 0, nameDiffs: 0, mismatches: [{ legacyUserId: 1, day: 'd', field: 'name', legacy: '<redacted>', mongo: '<redacted>' }] },
    orphanDateRows: [], danglingBlockLinks: [], ties: [],
  });
  assert.match(md, /Writes: none/);
  assert.match(md, /<redacted>/);
});

test('apply and rollback refuse production and anything but the dev target', async () => {
  const { assertApplyTarget, parseApplyArgs } = await import('../../migration/scripts/apply-workout-plans.js');
  const { parseRollbackArgs } = await import('../../migration/scripts/rollback-workout-plans.js');
  const dev = { uri: 'mongodb+srv://u:p@gogetfit-dev.abc.mongodb.net/gogetfit', name: 'gogetfit' };
  assert.throws(() => assertApplyTarget({ NODE_ENV: 'production' }, dev), /NODE_ENV/);
  assert.throws(() => assertApplyTarget({}, dev), /NODE_ENV/);
  assert.throws(() => assertApplyTarget({ NODE_ENV: 'development' }, { ...dev, uri: 'mongodb+srv://u:p@gogetfit-prod.abc.mongodb.net/gogetfit' }), /Refusing/);
  assert.throws(() => assertApplyTarget({ NODE_ENV: 'development' }, { ...dev, name: 'gogetfit_prod' }), /Refusing/);
  assert.deepEqual(assertApplyTarget({ NODE_ENV: 'development' }, dev), { host: 'gogetfit-dev.abc.mongodb.net', database: 'gogetfit' });

  assert.throws(() => parseApplyArgs(['--from-report=x.json']), /--source/);
  assert.throws(() => parseApplyArgs(['--source=production', '--from-report=x.json']), /--source/);
  assert.throws(() => parseApplyArgs(['--source=staging']), /--from-report/);
  assert.equal(parseApplyArgs(['--source=staging', '--from-report=x.json']).maxAgeHours, 24);

  assert.throws(() => parseRollbackArgs(['--run-id=a']), /required/);
  assert.throws(() => parseRollbackArgs(['--run-id=a', '--manifest=m', '--confirm=b']), /repeat the run id/);
  assert.equal(parseRollbackArgs(['--run-id=a', '--manifest=m']).confirm, false, 'no --confirm: check only');
  assert.equal(parseRollbackArgs(['--run-id=a', '--manifest=m', '--confirm=a']).confirm, true);
});

test('missing clients: each verdict from the established user-migration rules, never a guess', async () => {
  const { verdictFor } = await import('../../migration/scripts/reconcile-workout-plan-clients.js');
  const ok = { legacyUserId: 7, row: {}, phoneOk: true, invalid: false, sharedPhoneWith: [], load: 'insert' };
  assert.equal(verdictFor(ok), 'would_migrate');
  assert.equal(verdictFor({ ...ok, legacyUserId: 0 }), 'no_owner');
  assert.equal(verdictFor({ ...ok, row: undefined }), 'absent_from_legacy');
  assert.equal(verdictFor({ ...ok, phoneOk: false }), 'unusable_phone');
  assert.equal(verdictFor({ ...ok, invalid: true }), 'invalid_record');
  assert.equal(verdictFor({ ...ok, sharedPhoneWith: [8] }), 'duplicate_legacy_phone');
  assert.equal(verdictFor({ ...ok, load: 'phone_collision' }), 'phone_held_by_other_user');
  assert.equal(verdictFor({ ...ok, load: 'already_migrated' }), 'already_migrated');
});

test('an empty dated plan migrates and keeps its days; it still wins them over an older plan', async () => {
  const f = fixture();
  f.plans.push(plan(6, 501, '2024-05-13 09:00:00'));
  f.categories.push({ workout_plan_id: 6, workout_category_id: 76, workout_category_name: 'Warm up' });
  f.dateRows.push({ workout_plan_id: 6, day: '2024-05-14' });
  const { results, documents } = planWorkoutMigration({ ...f, refs });
  assert.equal(results.find((r) => r.legacyWorkoutPlanId === 6).disposition, 'migrate');
  assert.equal(selectWorkoutPlanForDay(documents, alice, '2024-05-14').planId, 'gogetfit:6');
  assert.equal(selectWorkoutPlanForDay(documents, alice, '2024-05-17').planId, 'gogetfit:2');
  const out = await replayWorkoutPlans({ documents, clients: [{ legacyUserId: 501, clientId: alice, days: ['2024-05-14', '2024-05-17'] }], ...legacyRuntime(f) });
  assert.deepEqual(out.mismatches, []);
});
