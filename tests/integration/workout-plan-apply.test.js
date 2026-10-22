import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import mongoose from 'mongoose';

import User from '../../src/models/user.model.js';
import Workout from '../../src/models/workout.model.js';
import WorkoutPlan from '../../src/models/workout-plan.model.js';
import { startOfBusinessDay } from '../../src/utils/business-date.js';
import { applyWorkoutPlans, rollbackWorkoutPlanRun } from '../../migration/loaders/workout-plan.loader.js';
import { prepareWorkoutPlanRun, runWorkoutPlanDryRun } from '../../migration/scripts/migrate-workout-plans.js';
import { runWorkoutPlanApply } from '../../migration/scripts/apply-workout-plans.js';
import { clearTestDb, connectTestDb, disconnectTestDb } from '../helpers/test-server.js';

/**
 * The workout-plan migration end to end against gogetfit_test, with the
 * legacy database replaced by fixed rows and a fake of its runtime queries:
 * dry run writes nothing; apply creates only, tags its run, keeps a true
 * manifest, refuses stale reports and conflicts, survives a partial failure
 * and reruns idempotently; rollback removes one run and nothing else.
 */
const target = () => ({ database: mongoose.connection.name });
let dir;
let clientA;
let clientB;

const plan = (id, userId, created) => ({
  workout_plan_id: id, workout_plan_name: `Plan ${id}`, user_id: userId, created_by: 9, create_date: created, last_update_date: created,
});
/** Legacy rows. Client 501: plans 1 and 2 (2 newer, shares 05-17). Client 502: old plan 5 and newer, EMPTY dated plan 3 (the staging plan-60 case). 601: no MongoDB user. */
const legacy = () => ({
  plans: [
    plan(1, 501, '2024-05-10 09:00:00'),
    plan(2, 501, '2024-05-12 09:00:00'),
    plan(3, 502, '2024-05-12 09:00:00'),
    plan(4, 601, '2024-05-10 09:00:00'),
    plan(5, 502, '2024-05-10 09:00:00'),
  ],
  categories: [1, 2, 3, 4, 5].map((id) => ({ workout_plan_id: id, workout_category_id: 70 + id, workout_category_name: 'Warm up' })),
  dangling: [],
  exercises: [
    { workout_plan_id: 1, workout_category_id: 71, workout_id: 12, sets_count: '3', reps_count: '12-15', workout_exists: 1 },
    { workout_plan_id: 2, workout_category_id: 72, workout_id: 40, sets_count: '1', reps_count: '30sec', workout_exists: 1 },
    { workout_plan_id: 4, workout_category_id: 74, workout_id: 12, sets_count: '1', reps_count: '10', workout_exists: 1 },
    { workout_plan_id: 5, workout_category_id: 75, workout_id: 12, sets_count: '2', reps_count: '8 ', workout_exists: 1 },
  ],
  dateRows: [
    ['1', '2024-05-14'], ['1', '2024-05-17'], ['2', '2024-05-17'],
    ['3', '2024-05-20'], ['3', '2024-05-22'], ['4', '2024-05-14'],
    ['5', '2024-05-18'], ['5', '2024-05-20'],
  ].map(([id, day]) => ({ workout_plan_id: Number(id), day, time: '00:00:00' })),
  legacyUsers: [],
  legacyCoaches: [],
});

/** The legacy runtime over those rows: newest create_date wins a day; blocks by id; exercises as stored. */
const runtimeOver = (rows) => ({
  legacySelect: async (userId, day) => {
    const hit = [...rows.plans]
      .sort((a, b) => b.create_date.localeCompare(a.create_date))
      .find((p) => p.user_id === userId && rows.dateRows.some((r) => r.workout_plan_id === p.workout_plan_id && r.day === day));
    return hit ? { workout_plan_id: hit.workout_plan_id, workout_plan_name: hit.workout_plan_name } : null;
  },
  legacyContent: async (planId) =>
    rows.categories.filter((c) => c.workout_plan_id === planId).map((c) => ({
      id: c.workout_category_id,
      name: c.workout_category_name,
      exercises: rows.exercises
        .filter((e) => e.workout_plan_id === planId && e.workout_category_id === c.workout_category_id && e.workout_exists)
        .map((e) => ({ workout_id: e.workout_id, workout_name: e.workout_id === 12 ? 'Squat' : 'Plank', sets_count: e.sets_count, reps_count: e.reps_count })),
    })),
});

const options = (rows = legacy()) => ({ source: 'staging', extract: async () => rows, runtime: runtimeOver(rows) });
const dryRun = (rows) => runWorkoutPlanDryRun({ ...options(rows), reportDir: dir, assertTarget: target });
const apply = (reportFile, extra = {}) =>
  runWorkoutPlanApply({ ...options(extra.rows), fromReport: reportFile, manifestDir: dir, assertTarget: target, ...extra });

let seq = 0;
const seedUser = (legacyUserId) => {
  seq += 1;
  const phone = `9177300${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `C${legacyUserId}` }, roles: ['user', 'client'], status: 'active', legacy: { source: 'gogetfit', userId: legacyUserId } });
};

/** Every collection's document count - the "nothing was written" witness. */
const snapshot = async () => {
  const out = {};
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    out[name] = await mongoose.connection.db.collection(name).countDocuments();
  }
  return out;
};

before(async () => {
  await connectTestDb();
  await WorkoutPlan.init(); // the unique legacy index the apply requires
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-apply-'));
});

beforeEach(async () => {
  await clearTestDb();
  // (gogetfit_test only - see tests/helpers/test-server.js)
  await Promise.all([WorkoutPlan.deleteMany({}), Workout.deleteMany({})]);
  clientA = await seedUser(501);
  clientB = await seedUser(502);
  const base = { equipment: 'Body Weight', primaryMuscle: 'Legs', level: 2, description: 'x', type: 'General', createdBy: clientA._id, updatedBy: clientA._id };
  await Workout.create({ ...base, name: 'Squat', legacy: { source: 'gogetfit', workoutId: 12 } });
  await Workout.create({ ...base, name: 'Plank', status: 'archived', legacy: { source: 'gogetfit', workoutId: 40 } });
});

after(async () => {
  await disconnectTestDb();
  await fs.rm(dir, { recursive: true, force: true });
});

test('dry run: writes nothing, accounts for every plan, migrates the empty dated plan, replays clean', async () => {
  const beforeRun = await snapshot();
  const report = await dryRun();
  assert.deepEqual(await snapshot(), beforeRun, 'no collection changed');
  assert.equal(report.result, 'DRY RUN PASS', JSON.stringify(report.replay.mismatches));
  assert.equal(report.counts.accountedFor, true);
  assert.deepEqual(report.byDisposition, { migrate: 4, blocked: 1 });
  const blocked = report.plans.find((p) => p.workoutPlanId === 4);
  assert.deepEqual(blocked.issues.map((i) => i.code).filter((c) => c === 'client_unresolved'), ['client_unresolved'], 'missing client: blocked, with its reason');
  assert.equal(report.counts.emptyDatedPlans, 1);
  assert.equal(report.counts.archivedExerciseRefs, 1, 'archived exercise kept as a reference');
  assert.equal(report.replay.mismatches.length, 0);
  // The empty plan wins its shared day 05-20 over the older plan 5, exactly as legacy.
  // 501: 05-14, 05-17; 502: 05-18, 05-20, 05-22 - each with the day either side.
  assert.deepEqual([report.replay.assignedDays, report.replay.days], [5, 13]);
});

test('apply: creates only the planned documents, tags the run, writes a true manifest; a rerun creates nothing', async () => {
  const report = await dryRun();
  const first = await apply(report.reportFile);
  assert.equal(first.status, 'complete');
  assert.equal(first.inserted.length, 4);

  const stored = await WorkoutPlan.find().lean();
  assert.deepEqual(stored.map((d) => d.legacy.workoutPlanId).sort(), [1, 2, 3, 5]);
  assert.ok(stored.every((d) => d.migration.runId === first.runId && d.migration.migratedAt), 'every document carries the run id');
  const manifest = JSON.parse(await fs.readFile(first.manifestFile, 'utf8'));
  assert.equal(manifest.runId, first.runId);
  assert.deepEqual(
    manifest.inserted.map((m) => `${m._id}:${m.workoutPlanId}`).sort(),
    stored.map((d) => `${d._id}:${d.legacy.workoutPlanId}`).sort(),
    'manifest = what was written',
  );
  assert.ok(!JSON.stringify(manifest).includes('Plan 1'), 'no plan names in the manifest');

  // Preserved as legacy had it: raw sets/reps, exact days, the empty plan, newest-wins.
  const one = stored.find((d) => d.legacy.workoutPlanId === 1);
  assert.deepEqual([one.blocks[0].exercises[0].setsRaw, one.blocks[0].exercises[0].repsRaw], ['3', '12-15']);
  const five = stored.find((d) => d.legacy.workoutPlanId === 5);
  assert.equal(five.blocks[0].exercises[0].repsRaw, '8 ', 'trailing space kept');
  const empty = stored.find((d) => d.legacy.workoutPlanId === 3);
  assert.deepEqual(empty.blocks.map((b) => b.exercises.length), [0]);
  assert.deepEqual(empty.selectedDates.map((d) => d.toISOString()), ['2024-05-20', '2024-05-22'].map((d) => startOfBusinessDay(d).toISOString()));
  const on = async (client, day) => (await WorkoutPlan.findForDay(client._id, startOfBusinessDay(day)).lean())?.legacy.workoutPlanId ?? null;
  assert.equal(await on(clientB, '2024-05-20'), 3, 'empty newer plan wins, as in legacy');
  assert.equal(await on(clientB, '2024-05-18'), 5);
  assert.equal(await on(clientA, '2024-05-17'), 2);

  // Rerun: a fresh dry run sees them present and identical; apply inserts nothing.
  const again = await dryRun();
  assert.equal(again.result, 'DRY RUN PASS');
  assert.equal(again.counts.alreadyPresent, 4);
  const second = await apply(again.reportFile);
  assert.equal(second.status, 'complete');
  assert.equal(second.inserted.length, 0);
  assert.equal(second.alreadyPresent.length, 4);
  assert.equal(await WorkoutPlan.countDocuments(), 4);
});

test('a stale, failing, foreign or out-of-date report is refused before any write', async () => {
  const report = await dryRun();
  const variant = async (change) => {
    const file = path.join(dir, `variant-${Math.random()}.json`);
    await fs.writeFile(file, JSON.stringify(change(JSON.parse(await fs.readFile(report.reportFile, 'utf8')))));
    return file;
  };
  const refused = async (file, pattern, extra) => {
    await assert.rejects(apply(file, extra), pattern);
    assert.equal(await WorkoutPlan.countDocuments(), 0);
  };
  await refused(await variant((r) => ({ ...r, finishedAt: new Date(Date.now() - 30 * 3_600_000).toISOString() })), /old/);
  await refused(await variant((r) => ({ ...r, result: 'DRY RUN FAIL' })), /result/);
  await refused(await variant((r) => ({ ...r, legacyDatabase: 'gogetfit' })), /legacyDatabase differs/);
  await refused(await variant((r) => ({ ...r, kind: 'diet-plans' })), /not a workout-plan dry-run/);
  // The legacy data changed after the dry run.
  const changed = legacy();
  changed.exercises[0].reps_count = '10';
  await refused(report.reportFile, /source fingerprint differs/, { rows: changed });
  // The target changed after the dry run.
  await WorkoutPlan.create({ ...(await prepareWorkoutPlanRun({ ...options(), runId: 'x', targetDatabase: 'gogetfit_test' })).documents[0] });
  await assert.rejects(apply(report.reportFile), /target fingerprint differs/);
  assert.equal(await WorkoutPlan.countDocuments(), 1, 'only the document this test put there');
});

test('a conflicting document already in the target stops the run and is left untouched', async () => {
  const { documents } = await prepareWorkoutPlanRun({ ...options(), runId: 'x', targetDatabase: 'gogetfit_test' });
  const theirs = await WorkoutPlan.create({ ...documents[0], name: 'Edited in the new app' });
  const report = await dryRun();
  assert.equal(report.result, 'DRY RUN FAIL');
  assert.deepEqual(report.targetConflicts, [{ workoutPlanId: 1, existingId: String(theirs._id) }]);

  const state = await applyWorkoutPlans(documents, { runId: 'r-conflict' });
  assert.equal(state.status, 'refused_conflicts');
  assert.deepEqual(state.inserted, []);
  assert.equal(await WorkoutPlan.countDocuments(), 1);
  assert.equal((await WorkoutPlan.findById(theirs._id).lean()).name, 'Edited in the new app');
});

test('the same legacy plan twice in one batch is refused outright', async () => {
  const { documents } = await prepareWorkoutPlanRun({ ...options(), runId: 'x', targetDatabase: 'gogetfit_test' });
  await assert.rejects(applyWorkoutPlans([documents[0], documents[0]], { runId: 'r-dup' }), /Duplicate legacy workout plan id/);
  assert.equal(await WorkoutPlan.countDocuments(), 0);
});

test('a partial failure reports exactly what was written; a rerun completes it without duplicates', async () => {
  const { documents } = await prepareWorkoutPlanRun({ ...options(), runId: 'x', targetDatabase: 'gogetfit_test' });
  const broken = documents.map((d, i) => (i === 1 ? { ...d, blocks: [...d.blocks, { ...d.blocks[0] }] } : d)); // duplicate block order: invalid
  const progress = [];
  const state = await applyWorkoutPlans(broken, { runId: 'r-partial', onProgress: async (s) => progress.push(JSON.parse(JSON.stringify(s))) });
  assert.equal(state.status, 'partial');
  assert.deepEqual(state.inserted.map((i) => i.workoutPlanId), [documents[0].legacy.workoutPlanId]);
  assert.deepEqual(state.failed.map((f) => f.workoutPlanId), [documents[1].legacy.workoutPlanId]);
  assert.deepEqual(state.notAttempted, documents.slice(2).map((d) => d.legacy.workoutPlanId));
  assert.equal(progress.at(-1).status, 'partial', 'the manifest writer saw the final state');
  assert.equal(await WorkoutPlan.countDocuments(), 1);

  const rerun = await applyWorkoutPlans(documents, { runId: 'r-partial-2' });
  assert.equal(rerun.status, 'complete');
  assert.deepEqual(rerun.alreadyPresent.map((a) => a.workoutPlanId), [documents[0].legacy.workoutPlanId]);
  assert.equal(rerun.inserted.length, documents.length - 1);
  assert.equal(await WorkoutPlan.countDocuments(), documents.length);
});

test('rollback removes only the named run, only when manifest and database agree, only when confirmed', async () => {
  const { documents } = await prepareWorkoutPlanRun({ ...options(), runId: 'x', targetDatabase: 'gogetfit_test' });
  const appMade = await WorkoutPlan.create({ ...documents[0], planId: 'app:1', legacy: undefined, migration: undefined });
  const runA = await applyWorkoutPlans(documents.slice(0, 2), { runId: 'r-A' });
  const runB = await applyWorkoutPlans(documents.slice(2), { runId: 'r-B' });
  const manifestA = { runId: 'r-A', inserted: runA.inserted };

  const check = await rollbackWorkoutPlanRun({ runId: 'r-A', manifest: manifestA });
  assert.deepEqual([check.wouldDelete, check.deleted, check.problems], [2, 0, []], 'unconfirmed: report only');
  assert.equal(await WorkoutPlan.countDocuments(), 5); // app-made + A(2) + B(2)

  // Refusals delete nothing.
  const wrongRun = await rollbackWorkoutPlanRun({ runId: 'r-A', manifest: { ...manifestA, runId: 'r-B' }, confirm: true });
  assert.ok(wrongRun.problems.length);
  const foreign = await rollbackWorkoutPlanRun({ runId: 'r-A', manifest: { runId: 'r-A', inserted: [...runA.inserted, runB.inserted[0]] }, confirm: true });
  assert.match(foreign.problems.join(), /not in the database with this run id/);
  const partialManifest = await rollbackWorkoutPlanRun({ runId: 'r-A', manifest: { runId: 'r-A', inserted: runA.inserted.slice(1) }, confirm: true });
  assert.match(partialManifest.problems.join(), /not in the manifest/);
  await WorkoutPlan.updateOne({ _id: runA.inserted[0]._id }, { $set: { name: 'coach edited' } });
  const edited = await rollbackWorkoutPlanRun({ runId: 'r-A', manifest: manifestA, confirm: true });
  assert.match(edited.problems.join(), /modified after the run/);
  assert.equal(await WorkoutPlan.countDocuments(), 5);

  // Unmodified run: deleted exactly.
  await WorkoutPlan.deleteMany({ 'migration.runId': 'r-A' });
  const runA2 = await applyWorkoutPlans(documents.slice(0, 2), { runId: 'r-A2' });
  const done = await rollbackWorkoutPlanRun({ runId: 'r-A2', manifest: { runId: 'r-A2', inserted: runA2.inserted }, confirm: true });
  assert.deepEqual([done.deleted, done.problems], [2, []]);
  const left = await WorkoutPlan.find().lean();
  assert.deepEqual(left.map((d) => d.migration?.runId ?? 'app').sort(), ['app', 'r-B', 'r-B'].sort());
  assert.ok(left.some((d) => String(d._id) === String(appMade._id)), 'pre-existing document untouched');
});
