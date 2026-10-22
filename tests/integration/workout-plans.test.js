import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import Workout from '../../src/models/workout.model.js';
import WorkoutPlan from '../../src/models/workout-plan.model.js';
import { startOfBusinessDay } from '../../src/utils/business-date.js';
import { transformWorkoutPlan } from '../../migration/transformers/workout-plan.transformer.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * workoutplans: the legacy-id unique index (a re-run cannot duplicate a
 * plan), the day lookup (only selected days; newest wins), and the member's
 * read - GET /api/users/me/workout-plan - their own plan only.
 */
let server;
let member;
let other;
let admin;
let squat;
let plank;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9177200${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};
const read = (qs = '', user = member) => server.request('GET', `/api/users/me/workout-plan${qs}`, { token: tokenFor(user) });

/** A migrated plan for [owner], as the transformer builds it. */
const migrated = (id, owner, { created = '2024-05-10 09:00:00', days = ['2024-05-14', '2024-05-17'], exercises } = {}) =>
  transformWorkoutPlan(
    {
      plan: { workout_plan_id: id, workout_plan_name: `Plan ${id}`, user_id: 400 + id, created_by: 9, create_date: created, last_update_date: created },
      categories: [{ workout_category_id: 70, workout_category_name: 'Warm up' }, { workout_category_id: 77, workout_category_name: 'Resistance' }],
      exercises: exercises ?? [
        { workout_category_id: 70, workout_id: 12, sets_count: '1', reps_count: '20' },
        { workout_category_id: 77, workout_id: 40, sets_count: '3', reps_count: '30sec' },
        { workout_category_id: 77, workout_id: 999, sets_count: '3', reps_count: '12-15' },
      ],
      days,
    },
    {
      clientIdByLegacyUserId: new Map([[400 + id, owner._id]]),
      coachIdByLegacyUserId: new Map(),
      workoutsByLegacyId: new Map([[12, squat], [40, plank]]),
    },
  ).document;

before(async () => {
  await connectTestDb();
  await WorkoutPlan.init(); // its indexes, before the duplicate test
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  // (gogetfit_test only - see tests/helpers/test-server.js)
  await Promise.all([WorkoutPlan.deleteMany({}), Workout.deleteMany({})]);
  member = await seedUser(['user', 'client'], 'Chethan');
  other = await seedUser(['user', 'client'], 'Bob');
  admin = await seedUser(['user', 'admin'], 'Admin');
  const base = { equipment: 'Body Weight', primaryMuscle: 'Legs', level: 2, description: 'x', createdBy: admin._id, updatedBy: admin._id };
  squat = await Workout.create({ ...base, name: 'Squat', type: 'General', thumbnail: { url: 'http://x/t.jpg', storageKey: 't.jpg' } });
  plank = await Workout.create({ ...base, name: 'Plank', type: 'Home', status: 'archived' });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('a legacy plan can exist once: a re-run cannot duplicate it', async () => {
  await WorkoutPlan.create(migrated(1, member));
  await assert.rejects(WorkoutPlan.create(migrated(1, member)), (e) => e.code === 11000);
  assert.equal(await WorkoutPlan.countDocuments(), 1);
  // App-created plans (no legacy block) are not caught by that index.
  const fresh = { ...migrated(2, member), legacy: undefined, planId: 'app:x' };
  await WorkoutPlan.create(fresh);
  await WorkoutPlan.create({ ...fresh, planId: 'app:y' });
  assert.equal(await WorkoutPlan.countDocuments(), 3);
});

test('the day lookup: only selected days, the newest plan where several share one', async () => {
  await WorkoutPlan.create(migrated(1, member, { created: '2024-05-10 09:00:00', days: ['2024-05-14', '2024-05-17'] }));
  await WorkoutPlan.create(migrated(2, member, { created: '2024-05-12 09:00:00', days: ['2024-05-17'] }));
  const on = async (day) => (await WorkoutPlan.findForDay(member._id, startOfBusinessDay(day)).lean())?.planId ?? null;
  assert.equal(await on('2024-05-14'), 'gogetfit:1');
  assert.equal(await on('2024-05-17'), 'gogetfit:2', 'newest created wins');
  assert.equal(await on('2024-05-15'), null, 'a gap is a gap');
  assert.equal(await on('2024-05-13'), null);
  // An archived plan stands down.
  await WorkoutPlan.updateOne({ planId: 'gogetfit:2' }, { $set: { status: 'archived' } });
  assert.equal(await on('2024-05-17'), 'gogetfit:1');
});

test('the member reads their plan for a day: blocks in order, exercises as written', async () => {
  await WorkoutPlan.create(migrated(1, member));
  const res = await read('?date=2024-05-17');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const plan = res.body.data.workoutPlan;
  assert.equal(plan.planId, 'gogetfit:1');
  assert.deepEqual(plan.days, ['2024-05-14', '2024-05-17']);
  assert.deepEqual(plan.blocks.map((b) => b.name), ['Warm up', 'Resistance']);
  const [first] = plan.blocks[0].exercises;
  assert.equal(first.name, 'Squat');
  assert.deepEqual(first.thumbnail, { url: 'http://x/t.jpg' });
  // The library's details, for the member's workout video screen.
  assert.deepEqual([first.description, first.level, first.primaryMuscle, first.secondaryMuscle], ['x', 2, 'Legs', null]);
  assert.deepEqual([first.setsRaw, first.repsRaw, first.sets, first.measure, first.amount], ['1', '20', 1, 'reps', 20]);
  const [archived, missing] = plan.blocks[1].exercises;
  assert.equal(archived.name, 'Plank', 'an archived exercise still shows');
  assert.equal(archived.missingWorkout, false);
  assert.equal(archived.archived, true, 'the member sees it marked archived, not removed');
  assert.equal(first.archived, false);
  assert.deepEqual([archived.repsRaw, archived.measure, archived.amount], ['30sec', 'time', 30]);
  assert.equal(missing.missingWorkout, true);
  assert.equal(missing.name, null);
  assert.deepEqual([missing.description, missing.level], [null, null], 'nothing invented for a missing workout');
  assert.deepEqual([missing.repsRaw, missing.amount, missing.amountMax], ['12-15', 12, 15]);
  for (const k of ['clientId', 'legacy', 'migration', 'coachId']) assert.ok(!(k in plan), k);
  // A day without one: null, not another day's plan.
  assert.equal((await read('?date=2024-05-15')).body.data.workoutPlan, null);
});

test('only the member\'s own plans, whatever is asked; bad dates and no token refused', async () => {
  await WorkoutPlan.create(migrated(1, other));
  assert.equal((await read('?date=2024-05-17')).body.data.workoutPlan, null);
  assert.equal((await read(`?date=2024-05-17&clientId=${other._id}`)).body.data.workoutPlan, null);
  assert.equal((await read('?date=2024-05-17', other)).body.data.workoutPlan.planId, 'gogetfit:1');
  for (const qs of ['?date=17-05-2024', '?date=2024-02-30']) {
    const res = await read(qs);
    assert.equal(res.status, 400, qs);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal((await server.request('GET', '/api/users/me/workout-plan')).status, 401);
});

test('reading writes nothing', async () => {
  await WorkoutPlan.create(migrated(1, member));
  const before = await WorkoutPlan.find().lean();
  await read('?date=2024-05-17');
  assert.deepEqual(await WorkoutPlan.find().lean(), before);
});

// ─── Admin: GET /api/admin/users/:id/workout-plans ─────────────────────────

const adminRead = (id, user = admin) => server.request('GET', `/api/admin/users/${id}/workout-plans`, { token: user ? tokenFor(user) : undefined });

test('admin reads every plan of one member, in precedence order, with what the member sees on shared days', async () => {
  await WorkoutPlan.create(migrated(1, member, { created: '2024-05-10 09:00:00', days: ['2024-05-14', '2024-05-17', '2024-05-21'] }));
  await WorkoutPlan.create(migrated(2, member, { created: '2024-05-12 09:00:00', days: ['2024-05-17'] }));
  await WorkoutPlan.create(migrated(3, other)); // another member: never in this answer
  const coachUser = await seedUser(['user', 'coach'], 'Coach Kiran');
  const coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  await WorkoutPlan.updateOne({ planId: 'gogetfit:2' }, { $set: { coachId: coach._id } });

  const res = await adminRead(member._id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { client, workoutPlans: plans } = res.body.data;
  assert.equal(client.id, String(member._id));
  assert.deepEqual(plans.map((p) => p.planId), ['gogetfit:2', 'gogetfit:1'], 'newest first; the other member\'s plan is absent');

  const [newer, older] = plans;
  assert.deepEqual(newer.coach, { id: String(coach._id), name: 'Coach Kiran', level: 'LEVEL 1' });
  assert.equal(older.coach, null, 'no coach linked: null, not invented');
  assert.deepEqual(older.legacy, { workoutPlanId: 1, createdBy: 9, coachSource: null });
  // Exact selected days with the gap kept; the shared day goes to the newer plan.
  assert.deepEqual(older.days, ['2024-05-14', '2024-05-17', '2024-05-21']);
  assert.deepEqual(older.shownDays, ['2024-05-14', '2024-05-21']);
  assert.deepEqual(newer.shownDays, ['2024-05-17']);
  assert.deepEqual([older.fromDate, older.toDate, older.period, older.status], ['2024-05-14', '2024-05-21', 'past', 'active']);
  assert.deepEqual(older.counts, { blocks: 2, exercises: 3, days: 3 });

  // Blocks in order; exercises as written - raw prescription kept, archived and missing shown.
  assert.deepEqual(older.blocks.map((b) => [b.order, b.name]), [[0, 'Warm up'], [1, 'Resistance']]);
  const [squatRow] = older.blocks[0].exercises;
  assert.deepEqual([squatRow.name, squatRow.setsRaw, squatRow.repsRaw, squatRow.thumbnail?.url], ['Squat', '1', '20', 'http://x/t.jpg']);
  const [plankRow, missing] = older.blocks[1].exercises;
  assert.deepEqual([plankRow.name, plankRow.repsRaw, plankRow.missingWorkout, plankRow.archived], ['Plank', '30sec', false, true], 'archived exercise still shown, flagged');
  assert.equal(squatRow.archived, false);
  assert.deepEqual([missing.missingWorkout, missing.repsRaw, missing.amount, missing.amountMax], [true, '12-15', 12, 15]);
  assert.ok(!('clientId' in older) && !('migration' in older));
});

test('an archived plan is listed but shows on no day; the active one takes its days back', async () => {
  await WorkoutPlan.create(migrated(1, member, { created: '2024-05-10 09:00:00', days: ['2024-05-17'] }));
  await WorkoutPlan.create(migrated(2, member, { created: '2024-05-12 09:00:00', days: ['2024-05-17'] }));
  await WorkoutPlan.updateOne({ planId: 'gogetfit:2' }, { $set: { status: 'archived' } });
  const plans = (await adminRead(member._id)).body.data.workoutPlans;
  assert.deepEqual(plans.map((p) => [p.planId, p.status, p.shownDays]), [['gogetfit:2', 'archived', []], ['gogetfit:1', 'active', ['2024-05-17']]]);
});

test('admin only; unknown or malformed ids are 404; a member with no plans is an empty list', async () => {
  assert.equal((await adminRead(member._id, null)).status, 401);
  assert.equal((await adminRead(member._id, member)).status, 403, 'a member cannot read anyone\'s plans here, even their own');
  const coachUser = await seedUser(['user', 'coach'], 'Coach');
  assert.equal((await adminRead(member._id, coachUser)).status, 403);
  for (const id of ['not-an-id', '64b000000000000000000000']) {
    const res = await adminRead(id);
    assert.equal(res.status, 404, id);
    assert.equal(res.body.error.code, 'USER_NOT_FOUND');
  }
  const empty = await adminRead(member._id);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data.workoutPlans, []);
});

// ─── Coach: GET /api/coach/enrollments/:enrollmentId/workout-plans ─────────

test('a coach reads the workout plans of a client in their own enrollment - and no one else\'s', async () => {
  const pkg = await GogetfitPlan.create({ name: '12 WEEKS', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1, pricing: { basePrice: 1, reward: 0 } });
  const coachUser = await seedUser(['user', 'coach'], 'Prajwal');
  const coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  const otherCoachUser = await seedUser(['user', 'coach'], 'Siri');
  const otherCoach = await Coach.create({ userId: otherCoachUser._id, profile: { level: 'LEVEL 1' } });
  const enroll = (user, c, extra = {}) => EnrolledClient.create({ userId: user._id, planId: pkg._id, coachId: c._id, enrollDate: new Date('2026-09-01'), hasStarted: true, isDeleted: false, ...extra });
  const mine = await enroll(member, coach);
  const theirs = await enroll(other, otherCoach);
  const deleted = await enroll(other, coach, { isDeleted: true });
  await WorkoutPlan.create(migrated(1, member, { days: ['2024-05-14', '2024-05-17'] }));
  await WorkoutPlan.create(migrated(2, member, { created: '2024-05-12 09:00:00', days: ['2024-05-17'] }));
  await WorkoutPlan.create(migrated(3, other));
  const read = (enrollmentId, user = coachUser) => server.request('GET', `/api/coach/enrollments/${enrollmentId}/workout-plans`, { token: user ? tokenFor(user) : undefined });

  const res = await read(mine._id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.client.id, String(member._id));
  const plans = res.body.data.workoutPlans;
  assert.deepEqual(plans.map((p) => p.planId), ['gogetfit:2', 'gogetfit:1']);
  assert.deepEqual(plans[1].days, ['2024-05-14', '2024-05-17']);
  assert.deepEqual(plans[1].shownDays, ['2024-05-14'], 'newest wins the shared day');
  assert.deepEqual(plans[1].blocks[1].exercises.map((e) => e.repsRaw), ['30sec', '12-15']);

  // Another coach's client, a deleted enrollment, a bad id: not found - never the plans.
  for (const id of [theirs._id, deleted._id, 'not-an-id', '64b000000000000000000000']) {
    const denied = await read(id);
    assert.equal(denied.status, 404, String(id));
    assert.equal(denied.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
    assert.equal(denied.body.data, undefined);
  }
  // Not a coach, or no token.
  assert.equal((await read(mine._id, member)).status, 403);
  assert.equal((await read(mine._id, admin)).status, 403);
  assert.equal((await read(mine._id, null)).status, 401);
  // A coach role without a Coach profile.
  const bare = await seedUser(['user', 'coach'], 'No profile');
  assert.equal((await read(mine._id, bare)).status, 404);
});

// ─── Member history: GET /api/users/me/workout-plans ───────────────────────

const history = (user = member, qs = '') => server.request('GET', `/api/users/me/workout-plans${qs}`, { token: user ? tokenFor(user) : undefined });

test('history: the member\'s own active plans, latest assigned day first, no legacy ids', async () => {
  await WorkoutPlan.create(migrated(1, member, { created: '2024-05-10 09:00:00', days: ['2024-05-14', '2024-05-17'] }));
  await WorkoutPlan.create(migrated(2, member, { created: '2024-05-12 09:00:00', days: ['2024-05-17'] }));
  await WorkoutPlan.create(migrated(3, member, { created: '2024-05-01 09:00:00', days: ['2024-06-03'] }));
  await WorkoutPlan.create(migrated(4, member, { created: '2024-05-13 09:00:00', days: ['2024-06-10'] }));
  await WorkoutPlan.updateOne({ planId: 'gogetfit:4' }, { $set: { status: 'archived' } });
  await WorkoutPlan.create(migrated(5, other, { days: ['2024-07-01'] }));

  const res = await history();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const plans = res.body.data.workoutPlans;
  // Latest last day first; on an equal last day, the newer assignment first. Archived and others' plans absent.
  assert.deepEqual(plans.map((p) => p.planId), ['gogetfit:3', 'gogetfit:2', 'gogetfit:1']);
  assert.equal(res.body.data.client.id, String(member._id));
  const one = plans[2];
  assert.deepEqual([one.days, one.shownDays, one.period], [['2024-05-14', '2024-05-17'], ['2024-05-14'], 'past']);
  assert.deepEqual(one.counts, { blocks: 2, exercises: 3, days: 2 });
  assert.deepEqual(one.blocks[1].exercises.map((e) => [e.repsRaw, e.archived, e.missingWorkout]), [['30sec', true, false], ['12-15', false, true]]);
  for (const p of plans) assert.ok(!('legacy' in p) && !('clientId' in p), 'no legacy or client ids');
});

test('history: only ever the token\'s member; empty is an empty list; no token is refused', async () => {
  await WorkoutPlan.create(migrated(1, other));
  assert.deepEqual((await history()).body.data.workoutPlans, [], 'another member\'s plan is never listed');
  assert.deepEqual((await history(member, `?clientId=${other._id}&userId=${other._id}`)).body.data.workoutPlans, [], 'ids in the request are ignored');
  assert.deepEqual((await history(other)).body.data.workoutPlans.map((p) => p.planId), ['gogetfit:1']);
  assert.equal((await history(null)).status, 401);
});

// ─── Coach library: GET /api/coach/workout-plans ──────────────────────────

test('library: YOU is the coach\'s own, ALL is everyone\'s; search by name, any case, trimmed, literal; paged', async () => {
  const coachUser = await seedUser(['user', 'coach'], 'Prajwal');
  const coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  const otherCoachUser = await seedUser(['user', 'coach'], 'Siri');
  const otherCoach = await Coach.create({ userId: otherCoachUser._id, profile: { level: 'LEVEL 1' } });
  const make = async (id, owner, c, name, created, extra = {}) => {
    const doc = migrated(id, owner, { created });
    await WorkoutPlan.create({ ...doc, name, coachId: c?._id ?? null, ...extra });
  };
  await make(1, member, coach, 'Push Day A', '2024-05-10 09:00:00');
  await make(2, member, coach, 'Leg day', '2024-05-12 09:00:00');
  await make(3, other, otherCoach, 'PUSH power', '2024-05-11 09:00:00');
  await make(4, other, coach, 'Push (written by someone else)', '2024-05-13 09:00:00', { createdBy: otherCoachUser._id });
  await make(5, member, coach, 'Push archived', '2024-05-14 09:00:00', { status: 'archived' });
  await make(6, other, null, 'Orphan push', '2024-05-09 09:00:00');

  const lib = (qs, user = coachUser) => server.request('GET', `/api/coach/workout-plans${qs}`, { token: user ? tokenFor(user) : undefined });
  const names = async (qs) => (await lib(qs)).body.data.items.map((i) => i.name);

  assert.deepEqual(await names('?scope=you'), ['Leg day', 'Push Day A'], 'own plans, newest first; not another writer\'s, not archived');
  assert.deepEqual(await names('?scope=all'), ['Push (written by someone else)', 'Leg day', 'PUSH power', 'Push Day A', 'Orphan push']);
  assert.deepEqual(await names('?scope=you&search=%20push%20'), ['Push Day A'], 'trimmed, any case, YOU only');
  assert.deepEqual(await names('?scope=all&search=push'), ['Push (written by someone else)', 'PUSH power', 'Push Day A', 'Orphan push']);
  assert.deepEqual(await names(`?scope=all&search=${encodeURIComponent('(written')}`), ['Push (written by someone else)'], 'literal, not a pattern');
  assert.deepEqual(await names('?scope=all&search=zzz'), []);

  const first = await lib('?scope=all&pageSize=2');
  assert.deepEqual(first.body.data.pagination, { page: 1, pageSize: 2, total: 5, hasMore: true });
  const item = first.body.data.items[1];
  assert.deepEqual(Object.keys(item).sort(), ['coach', 'counts', 'createdOn', 'name', 'planId']);
  assert.deepEqual(item.coach, { id: String(coach._id), name: 'Prajwal' });
  assert.deepEqual(item.counts, { blocks: 2, exercises: 3 });
  const second = await lib('?scope=all&pageSize=2&page=2');
  assert.deepEqual(second.body.data.items.map((i) => i.name), ['PUSH power', 'Push Day A']);

  assert.equal((await lib('?scope=mine')).status, 400);
  assert.equal((await lib('?scope=you', member)).status, 403);
  assert.equal((await lib('?scope=you', null)).status, 401);
});

test('library: one plan in full for its preview - blocks and exercises as written, no client', async () => {
  const coachUser = await seedUser(['user', 'coach'], 'Prajwal');
  await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  await WorkoutPlan.create(migrated(1, member));
  const get = (id) => server.request('GET', `/api/coach/workout-plans/${encodeURIComponent(id)}`, { token: tokenFor(coachUser) });

  const res = await get('gogetfit:1');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const plan = res.body.data.workoutPlan;
  assert.equal(plan.name, 'Plan 1');
  assert.deepEqual(plan.blocks.map((b) => b.name), ['Warm up', 'Resistance']);
  assert.deepEqual(plan.blocks[1].exercises.map((e) => [e.setsRaw, e.repsRaw, e.archived, e.missingWorkout]), [['3', '30sec', true, false], ['3', '12-15', false, true]]);
  for (const k of ['clientId', 'days', 'client', 'legacy']) assert.ok(!(k in plan), k);

  const missing = await get('gogetfit:999');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'WORKOUT_PLAN_NOT_FOUND');
});

// ─── Coach: POST /api/coach/enrollments/:enrollmentId/workout-plans ───────

test('a coach saves a workout plan for their client: stored as written, seen by coach and client on its days', async () => {
  const pkg = await GogetfitPlan.create({ name: '12 WEEKS', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1, pricing: { basePrice: 1, reward: 0 } });
  const coachUser = await seedUser(['user', 'coach'], 'Prajwal');
  const coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  const otherCoachUser = await seedUser(['user', 'coach'], 'Siri');
  const otherCoach = await Coach.create({ userId: otherCoachUser._id, profile: { level: 'LEVEL 1' } });
  const mine = await EnrolledClient.create({ userId: member._id, planId: pkg._id, coachId: coach._id, enrollDate: new Date('2026-09-01'), hasStarted: true, isDeleted: false });
  const theirs = await EnrolledClient.create({ userId: other._id, planId: pkg._id, coachId: otherCoach._id, enrollDate: new Date('2026-09-01'), hasStarted: true, isDeleted: false });
  const save = (enrollmentId, body, user = coachUser) =>
    server.request('POST', `/api/coach/enrollments/${enrollmentId}/workout-plans`, { token: tokenFor(user), body });
  const body = {
    name: '  Chinmay WP 1 ',
    blocks: [
      { name: 'Warm up', exercises: [{ workoutId: String(squat._id), setsRaw: '3', repsRaw: '12', note: 'Slow down' }] },
      { name: '', exercises: [] }, // an empty slot is dropped
      { name: 'Core', exercises: [{ workoutId: String(squat._id), setsRaw: '2', repsRaw: '30sec' }] },
    ],
    dates: ['2026-10-24', '2026-10-21', '2026-10-21'],
  };

  const res = await save(mine._id, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const saved = await WorkoutPlan.findOne({ clientId: member._id }).lean();
  assert.equal(saved.name, 'Chinmay WP 1');
  assert.equal(String(saved.coachId), String(coach._id));
  assert.equal(String(saved.enrollmentId), String(mine._id));
  assert.equal(String(saved.createdBy), String(coachUser._id));
  assert.match(saved.planId, /^app:/);
  assert.deepEqual(saved.selectedDates.map((d) => d.toISOString()), ['2026-10-21', '2026-10-24'].map((d) => startOfBusinessDay(d).toISOString()));
  assert.deepEqual(saved.blocks.map((b) => [b.order, b.name, b.exercises.length]), [[0, 'Warm up', 1], [1, 'Core', 1]]);
  const [first] = saved.blocks[0].exercises;
  assert.deepEqual([first.name, first.setsRaw, first.repsRaw, first.sets, first.measure, first.amount, first.note], ['Squat', '3', '12', 3, 'reps', 12, 'Slow down']);
  assert.deepEqual([saved.blocks[1].exercises[0].measure, saved.blocks[1].exercises[0].amount], ['time', 30]);

  // The coach's View Assigned Plans and the client's own day both show it.
  const list = await server.request('GET', `/api/coach/enrollments/${mine._id}/workout-plans`, { token: tokenFor(coachUser) });
  assert.deepEqual(list.body.data.workoutPlans.map((p) => p.name), ['Chinmay WP 1']);
  assert.equal((await read('?date=2026-10-21')).body.data.workoutPlan.name, 'Chinmay WP 1');
  assert.equal((await read('?date=2026-10-22')).body.data.workoutPlan, null, 'a gap is a gap');

  // A newer plan on a shared day wins it.
  await save(mine._id, { ...body, name: 'Newer', dates: ['2026-10-24'] });
  assert.equal((await read('?date=2026-10-24')).body.data.workoutPlan.name, 'Newer');
  assert.equal((await read('?date=2026-10-21')).body.data.workoutPlan.name, 'Chinmay WP 1');

  // Never for another coach's client; bad input refused; nothing else written.
  const count = await WorkoutPlan.countDocuments();
  assert.equal((await save(theirs._id, body)).status, 404);
  for (const bad of [
    { ...body, name: '' },
    { ...body, dates: [] },
    { ...body, dates: ['2026-02-30'] },
    { ...body, blocks: [{ name: 'x', exercises: [] }] },
    { ...body, blocks: [{ name: 'x', exercises: [{ workoutId: 'nope', setsRaw: '3', repsRaw: '12' }] }] },
    { ...body, blocks: [{ name: 'x', exercises: [{ workoutId: String(squat._id), setsRaw: '', repsRaw: '12' }] }] },
    { ...body, blocks: Array.from({ length: 9 }, () => body.blocks[0]) },
    { ...body, blocks: [{ name: 'x', exercises: [{ workoutId: String(plank._id), setsRaw: '3', repsRaw: '12' }] }] }, // archived
  ]) {
    const r = await save(mine._id, bad);
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 80));
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal((await save(mine._id, body, member)).status, 403);
  assert.equal(await WorkoutPlan.countDocuments(), count);
});
