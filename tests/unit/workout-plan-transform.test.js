import test from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import WorkoutPlan, { WORKOUT_PLAN_MAX_BLOCKS } from '../../src/models/workout-plan.model.js';
import { businessDayOf } from '../../src/utils/business-date.js';
import { parseReps, parseSets } from '../../src/utils/workout-prescription.js';
import {
  ISSUE,
  clientReadiness,
  competingDays,
  orphanAssignments,
  transformWorkoutPlan,
} from '../../migration/transformers/workout-plan.transformer.js';

/**
 * Legacy workout plans into the `workoutplans` shape - pure transform, the
 * prescription parser, and the model's own validation (no database).
 */

const clientId = new mongoose.Types.ObjectId();
const coachId = new mongoose.Types.ObjectId();
const squat = { _id: new mongoose.Types.ObjectId(), name: 'Squat', status: 'active' };
const plank = { _id: new mongoose.Types.ObjectId(), name: 'Plank', status: 'archived' };
const refs = () => ({
  clientIdByLegacyUserId: new Map([[417, clientId]]),
  coachIdByLegacyUserId: new Map([[9, coachId]]),
  workoutsByLegacyId: new Map([[12, squat], [40, plank]]),
});

const rows = (o = {}) => ({
  plan: {
    workout_plan_id: 101,
    workout_plan_name: 'Push day ',
    user_id: 417,
    created_by: 9,
    create_date: '2024-05-10 20:16:07',
    last_update_date: '2024-05-10 20:16:07',
    ...o.plan,
  },
  // Out of id order on purpose: the plan shows them by category id.
  categories: o.categories ?? [
    { workout_category_id: 77, workout_category_name: 'Resistance' },
    { workout_category_id: 70, workout_category_name: 'Warm up' },
  ],
  exercises: o.exercises ?? [
    { workout_category_id: 77, workout_id: 40, sets_count: '3', reps_count: '30sec' },
    { workout_category_id: 77, workout_id: 12, sets_count: '3', reps_count: '12-15' },
    { workout_category_id: 70, workout_id: 12, sets_count: '1 ', reps_count: '20' },
  ],
  days: o.days ?? ['2024-05-14', '2024-05-17', '2024-05-14', '2024-05-21'],
});

const codes = (r) => r.issues.map((i) => i.code);

test('sets: whole numbers only', () => {
  assert.equal(parseSets('3'), 3);
  assert.equal(parseSets('1 '), 1, 'trailing space as stored');
  for (const v of ['3-4', 'I ', '', null, undefined, '3x', '-1']) assert.equal(parseSets(v), null, String(v));
});

test('reps: integers, ranges, seconds, reps, minutes - else nothing', () => {
  assert.deepEqual(parseReps('12'), { measure: 'reps', amount: 12, amountMax: null });
  assert.deepEqual(parseReps('12-15'), { measure: 'reps', amount: 12, amountMax: 15 });
  assert.deepEqual(parseReps('10 - 12'), { measure: 'reps', amount: 10, amountMax: 12 });
  assert.deepEqual(parseReps('15sec'), { measure: 'time', amount: 15, amountMax: null });
  assert.deepEqual(parseReps('15 secs'), { measure: 'time', amount: 15, amountMax: null });
  assert.deepEqual(parseReps('10reps'), { measure: 'reps', amount: 10, amountMax: null });
  assert.deepEqual(parseReps('01min'), { measure: 'time', amount: 60, amountMax: null });
  for (const v of ['15-12', '30cc', 'I ', 'r', '10/3', '50/10', '', null]) {
    assert.deepEqual(parseReps(v), { measure: null, amount: null, amountMax: null }, String(v));
  }
});

test('one document per plan: blocks and exercises nested, in legacy order, ids kept', () => {
  const r = transformWorkoutPlan(rows(), refs(), { runId: 'run-1', version: 1 });
  const doc = r.document;
  assert.equal(doc.planId, 'gogetfit:101');
  assert.equal(doc.name, 'Push day ', 'verbatim');
  assert.equal(String(doc.clientId), String(clientId));
  assert.equal(String(doc.coachId), String(coachId));
  assert.deepEqual(doc.blocks.map((b) => [b.blockId, b.legacyCategoryId, b.name, b.order]), [
    ['gogetfit:cat:70', 70, 'Warm up', 0],
    ['gogetfit:cat:77', 77, 'Resistance', 1],
  ]);
  // Exercises by workout id within a block (the documented fallback).
  assert.deepEqual(doc.blocks[1].exercises.map((e) => e.legacyWorkoutId), [12, 40]);
  assert.equal(String(doc.blocks[1].exercises[0].workoutId), String(squat._id));
  assert.equal(doc.blocks[1].exercises[0].name, 'Squat');
  assert.deepEqual(doc.legacy, {
    source: 'gogetfit',
    workoutPlanId: 101,
    clientId: 417,
    createdBy: 9,
    coachSource: 'creator',
    createDate: new Date('2024-05-10T14:46:07.000Z'),
    lastUpdateDate: new Date('2024-05-10T14:46:07.000Z'),
  });
  assert.equal(doc.assignedAt.toISOString(), '2024-05-10T14:46:07.000Z', 'legacy precedence: creation');
  assert.deepEqual(doc.migration, { runId: 'run-1', migratedAt: null, version: 1 });
});

test('sets and reps kept exactly as written, read only where safe', () => {
  const r = transformWorkoutPlan(
    rows({ exercises: [
      { workout_category_id: 70, workout_id: 12, sets_count: '1 ', reps_count: '12-15' },
      { workout_category_id: 77, workout_id: 40, sets_count: 'I ', reps_count: '30cc' },
    ] }),
    refs(),
  );
  const [range] = r.document.blocks[0].exercises;
  assert.deepEqual(
    [range.setsRaw, range.repsRaw, range.sets, range.measure, range.amount, range.amountMax, range.note],
    ['1 ', '12-15', 1, 'reps', 12, 15, null],
  );
  const [odd] = r.document.blocks[1].exercises;
  assert.deepEqual([odd.setsRaw, odd.repsRaw, odd.sets, odd.measure, odd.amount], ['I ', '30cc', null, null, null]);
  assert.ok(codes(r).includes(ISSUE.SETS_UNREAD));
  assert.ok(codes(r).includes(ISSUE.REPS_UNREAD));
});

test('days: exact calendar days, gaps kept, repeats collapsed and reported, no timezone shift', () => {
  const r = transformWorkoutPlan(rows(), refs());
  const days = r.document.selectedDates.map((d) => businessDayOf(d));
  assert.deepEqual(days, ['2024-05-14', '2024-05-17', '2024-05-21'], 'gaps preserved');
  // The start of the IST day, which is the evening before in UTC.
  assert.equal(r.document.selectedDates[0].toISOString(), '2024-05-13T18:30:00.000Z');
  assert.equal(r.document.fromDate.toISOString(), '2024-05-13T18:30:00.000Z');
  assert.equal(r.document.toDate.toISOString(), '2024-05-20T18:30:00.000Z');
  assert.deepEqual(r.issues.find((i) => i.code === ISSUE.DUPLICATE_DATES), {
    code: ISSUE.DUPLICATE_DATES,
    severity: 'info',
    duplicates: 1,
  });
  assert.equal(r.status, 'ready');
  // A day straddling UTC midnight is still its own IST day.
  const edge = transformWorkoutPlan(rows({ days: ['2024-12-31', '2025-01-01'] }), refs());
  assert.deepEqual(edge.document.selectedDates.map((d) => businessDayOf(d)), ['2024-12-31', '2025-01-01']);
});

test('an unknown client blocks the plan - never guessed; an unknown coach is null and kept', () => {
  const r = transformWorkoutPlan(rows({ plan: { user_id: 0, created_by: 55 } }), refs());
  assert.equal(r.status, 'blocked');
  assert.equal(r.document, null);
  assert.deepEqual(r.issues.find((i) => i.code === ISSUE.CLIENT_UNRESOLVED), {
    code: ISSUE.CLIENT_UNRESOLVED,
    severity: 'blocking',
    legacyUserId: 0,
  });
  const coachless = transformWorkoutPlan(rows({ plan: { created_by: 55 } }), refs());
  assert.equal(coachless.document.coachId, null);
  assert.equal(coachless.document.legacy.createdBy, 55);
  assert.equal(coachless.status, 'ready', 'an unresolved coach is reported, not blocking');
});

test('the coach: the verified author as for diet plans, else the client\'s own coach', () => {
  const theirCoach = new mongoose.Types.ObjectId();
  const later = new mongoose.Types.ObjectId();
  const withEnrollments = (enrollments) => ({ ...refs(), enrollmentsByClient: new Map([[String(clientId), enrollments]]) });
  const covering = [
    { coachId: theirCoach, from: '2024-04-01', to: '2024-06-30' },
    { coachId: later, from: '2024-07-01', to: '2024-09-30' },
  ];

  // 1. The diet-plan rule: the author, verified as a coach (created_by 9).
  const authored = transformWorkoutPlan(rows(), withEnrollments(covering));
  assert.equal(String(authored.document.coachId), String(coachId));
  assert.equal(authored.document.legacy.coachSource, 'creator');

  // 2. Author not a verified coach (55): the client's enrollment covering
  //    the plan's creation day.
  const covered = transformWorkoutPlan(rows({ plan: { created_by: 55 } }), withEnrollments(covering));
  assert.equal(String(covered.document.coachId), String(theirCoach));
  assert.equal(covered.document.legacy.coachSource, 'client_enrollment');
  assert.equal(covered.document.legacy.createdBy, 55, 'the author is still kept');

  // ... else the one covering the first assigned day.
  const byDay = transformWorkoutPlan(
    rows({ plan: { created_by: 55, create_date: '2024-03-20 10:00:00' } }),
    withEnrollments([
      { coachId: later, from: '2024-05-01', to: '2024-06-30' },
      { coachId: theirCoach, from: '2023-01-01', to: '2023-12-31' },
    ]),
  );
  assert.equal(String(byDay.document.coachId), String(later));

  // 3. None covering, but the client only ever had one coach.
  const only = transformWorkoutPlan(rows({ plan: { created_by: 55 } }), withEnrollments([
    { coachId: theirCoach, from: '2023-01-01', to: '2023-03-31' },
    { coachId: theirCoach, from: null, to: null },
  ]));
  assert.equal(String(only.document.coachId), String(theirCoach));
  assert.equal(only.document.legacy.coachSource, 'client_only_coach');

  // Two coaches on that day: not guessed, reported.
  const ambiguous = transformWorkoutPlan(rows({ plan: { created_by: 55 } }), withEnrollments([
    { coachId: theirCoach, from: '2024-05-01', to: '2024-05-31' },
    { coachId: later, from: '2024-05-01', to: '2024-05-31' },
  ]));
  assert.equal(ambiguous.document.coachId, null);
  assert.ok(codes(ambiguous).includes(ISSUE.COACH_AMBIGUOUS));

  // Nothing known: null, reported - never a made-up coach.
  const none = transformWorkoutPlan(rows({ plan: { created_by: 55 } }), withEnrollments([]));
  assert.equal(none.document.coachId, null);
  assert.equal(none.document.legacy.coachSource, null);
  assert.ok(codes(none).includes(ISSUE.COACH_UNRESOLVED));
});

test('a missing exercise is kept by its legacy id and needs a decision; an archived one is a normal reference', () => {
  const r = transformWorkoutPlan(
    rows({ exercises: [
      { workout_category_id: 70, workout_id: 999, sets_count: '3', reps_count: '10' },
      { workout_category_id: 77, workout_id: 40, sets_count: '3', reps_count: '30sec' },
    ] }),
    refs(),
  );
  const missing = r.document.blocks[0].exercises[0];
  assert.deepEqual([missing.workoutId, missing.legacyWorkoutId, missing.name], [null, 999, null]);
  assert.equal(r.status, 'needs_decision');
  const archived = r.document.blocks[1].exercises[0];
  assert.equal(String(archived.workoutId), String(plank._id));
  assert.ok(r.issues.some((i) => i.code === ISSUE.EXERCISE_ARCHIVED && i.severity === 'info'));
});

test('no days, no blocks, no exercises, empty blocks: built, reported, never invented', () => {
  const undated = transformWorkoutPlan(rows({ days: [] }), refs());
  assert.deepEqual(undated.document.selectedDates, []);
  assert.equal(undated.document.fromDate, null);
  assert.equal(undated.document.toDate, null);
  assert.ok(codes(undated).includes(ISSUE.NO_DATES));
  assert.equal(undated.status, 'needs_decision');

  const bare = transformWorkoutPlan(rows({ categories: [], exercises: [] }), refs());
  assert.deepEqual(bare.document.blocks, []);
  assert.ok(codes(bare).includes(ISSUE.NO_BLOCKS));

  const emptied = transformWorkoutPlan(rows({ exercises: [] }), refs());
  assert.equal(emptied.document.blocks.length, 2, 'empty blocks kept');
  assert.ok(codes(emptied).includes(ISSUE.NO_EXERCISES));
  assert.equal(emptied.issues.filter((i) => i.code === ISSUE.EMPTY_BLOCK).length, 2);
  // Dated: the legacy app selected it and showed it empty - it migrates as is.
  assert.equal(emptied.issues.find((i) => i.code === ISSUE.NO_EXERCISES).severity, 'info');
  assert.equal(emptied.status, 'ready');
  assert.ok(emptied.document.blocks.every((b) => b.exercises.length === 0), 'nothing invented');
  // Undated: still a decision.
  const emptyUndated = transformWorkoutPlan(rows({ exercises: [], days: [] }), refs());
  assert.equal(emptyUndated.issues.find((i) => i.code === ISSUE.NO_EXERCISES).severity, 'decision');
});

test('more than eight blocks: every block kept, reported for a decision', () => {
  const categories = Array.from({ length: 10 }, (_, i) => ({ workout_category_id: 200 + i, workout_category_name: `B${i}` }));
  const r = transformWorkoutPlan(rows({ categories, exercises: [] }), refs());
  assert.equal(r.document.blocks.length, 10, 'no truncation');
  assert.deepEqual(r.issues.find((i) => i.code === ISSUE.TOO_MANY_BLOCKS), {
    code: ISSUE.TOO_MANY_BLOCKS,
    severity: 'decision',
    blocks: 10,
    max: WORKOUT_PLAN_MAX_BLOCKS,
  });
});

test('exercise rows of a block the plan does not hold, and days before creation, are reported', () => {
  const r = transformWorkoutPlan(
    rows({
      exercises: [{ workout_category_id: 5, workout_id: 12, sets_count: '3', reps_count: '10' }],
      days: ['2024-05-09', '2024-05-14'],
    }),
    refs(),
  );
  assert.deepEqual(r.issues.find((i) => i.code === ISSUE.EXERCISE_OUTSIDE_BLOCKS).rows, [{ legacyCategoryId: 5, legacyWorkoutId: 12 }]);
  assert.equal(r.issues.find((i) => i.code === ISSUE.DATES_BEFORE_CREATION).count, 1);
  // Kept as dated - the legacy app showed the plan on that day.
  assert.equal(r.document.selectedDates.length, 2);
});

test('competing plans: the newest wins; a tie is reported, not guessed', () => {
  const older = transformWorkoutPlan(rows(), refs()).document;
  const newer = transformWorkoutPlan(rows({ plan: { workout_plan_id: 102, create_date: '2024-05-12 09:00:00' }, days: ['2024-05-17'] }), refs()).document;
  const [day] = competingDays([older, newer]);
  assert.equal(day.day, '2024-05-16T18:30:00.000Z');
  assert.deepEqual(day.planIds, ['gogetfit:102', 'gogetfit:101']);
  assert.equal(day.winner, 'gogetfit:102');
  assert.equal(day.tie, false);

  const twin = transformWorkoutPlan(rows({ plan: { workout_plan_id: 103 }, days: ['2024-05-21'] }), refs()).document;
  const [tied] = competingDays([older, twin]);
  assert.equal(tied.tie, true);
  assert.equal(tied.winner, 'gogetfit:103', 'higher legacy id first, as findForDay');
});

test('a client is ready only when all its plans are, or their decisions are accepted', () => {
  const ok = transformWorkoutPlan(rows(), refs());
  const undated = transformWorkoutPlan(rows({ plan: { workout_plan_id: 102 }, days: [] }), refs());
  const [held] = clientReadiness([ok, undated]);
  assert.equal(held.ready, false);
  assert.deepEqual(held.heldBy, ['gogetfit:102']);
  const [accepted] = clientReadiness([ok, undated], { accepted: new Set([ISSUE.NO_DATES]) });
  assert.equal(accepted.ready, true);

  const unknown = transformWorkoutPlan(rows({ plan: { user_id: 0 } }), refs());
  const [blocked] = clientReadiness([unknown], { accepted: new Set(Object.values(ISSUE)) });
  assert.equal(blocked.ready, false, 'blocking issues are never accepted away');

  const tie = [{ clientId: String(clientId), tie: true }];
  assert.equal(clientReadiness([ok], { ties: tie })[0].ready, false);
});

test('assignments to no known plan are reported', () => {
  const orphans = orphanAssignments(
    [{ workout_plan_id: 0 }, { workout_plan_id: 101 }, { workout_plan_id: 7 }],
    new Set([101]),
  );
  assert.deepEqual(orphans.map((o) => o.workout_plan_id), [0, 7]);
});

test('the model accepts a migrated plan and enforces its rules', async () => {
  const doc = transformWorkoutPlan(rows(), refs()).document;
  await new WorkoutPlan(doc).validate();

  // New plans: at most eight blocks; migrated ones keep every block.
  const many = Array.from({ length: 9 }, (_, i) => ({ blockId: `b${i}`, name: `B${i}`, order: i, exercises: [] }));
  const fresh = { ...doc, legacy: undefined, blocks: many };
  await assert.rejects(new WorkoutPlan(fresh).validate(), /at most 8 blocks/);
  await new WorkoutPlan({ ...doc, blocks: many }).validate();

  const shuffled = { ...doc, selectedDates: [doc.selectedDates[1], doc.selectedDates[0]] };
  await assert.rejects(new WorkoutPlan(shuffled).validate(), /ascending/);
  await assert.rejects(new WorkoutPlan({ ...doc, toDate: doc.fromDate }).validate(), /first and last/);
  await assert.rejects(new WorkoutPlan({ ...doc, selectedDates: [], fromDate: doc.fromDate, toDate: doc.toDate }).validate(), /no fromDate/);
  const dupBlock = { ...doc, blocks: [doc.blocks[0], { ...doc.blocks[1], order: 0 }] };
  await assert.rejects(new WorkoutPlan(dupBlock).validate(), /order must be unique/);
  const badRange = structuredClone(doc);
  badRange.blocks[1].exercises[0] = { ...badRange.blocks[1].exercises[0], amount: 15, amountMax: 12 };
  await assert.rejects(new WorkoutPlan(badRange).validate(), /amountMax/);
  const noRef = structuredClone(doc);
  noRef.blocks[0].exercises[0] = { ...noRef.blocks[0].exercises[0], workoutId: null, legacyWorkoutId: null };
  await assert.rejects(new WorkoutPlan(noRef).validate(), /workoutId/);
});
