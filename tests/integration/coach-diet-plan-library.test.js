import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Coach from '../../src/models/coach.model.js';
import DietPlan from '../../src/models/diet-plan.model.js';
import Food from '../../src/models/food.model.js';
import User from '../../src/models/user.model.js';
import { startOfBusinessDay } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * The coach's Diet Plan library (Add Meal Plan → ALL GOGETFIT DIET PLANS):
 * GET /api/coach/diet-plans?scope=you|all and GET /api/coach/diet-plans/:planId.
 * One item per planId, active only, newest first, the coach from the token.
 */
let server;
let me; // coach user
let meCoach;
let otherUser;
let otherCoach;
let admin;
let client;
let member;
let oats;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9199000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};
const day = (d) => startOfBusinessDay(d);
const plan = (o) =>
  DietPlan.create({
    clientId: client._id,
    fromDate: day('2026-10-01'),
    toDate: day('2026-10-07'),
    assignedAt: new Date('2026-09-30'),
    targets: { calories: 1800, protein: 120, carbs: 200, fat: 60 },
    meals: [{ meal: 1, foods: [{ foodId: oats._id, qty: 100, portion: 100, servingUnit: 'Grams', calories: 389, fat: 7, carbs: 66, protein: 17 }] }],
    ...o,
  });
const list = (qs, user = me) => server.request('GET', `/api/coach/diet-plans${qs}`, { token: tokenFor(user) });
const one = (planId, user = me) => server.request('GET', `/api/coach/diet-plans/${encodeURIComponent(planId)}`, { token: tokenFor(user) });
const names = (res) => res.body.data.items.map((i) => i.name);

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  me = await seedUser(['user', 'coach'], 'Prajwal');
  meCoach = await Coach.create({ userId: me._id, profile: { level: 'LEVEL 1' } });
  otherUser = await seedUser(['user', 'coach'], 'Siri');
  otherCoach = await Coach.create({ userId: otherUser._id, profile: { level: 'LEVEL 2' } });
  admin = await seedUser(['user', 'admin'], 'Admin');
  client = await seedUser(['user', 'client'], 'Chethan');
  member = await seedUser(['user', 'client'], 'Bob');
  oats = await Food.create({ name: 'Oats', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 389, fat: 7, carbs: 66, protein: 17 });

  // Mine, written in the app.
  await plan({ planId: 'app:1', name: 'Mine new', coachId: meCoach._id, createdBy: me._id, createdAt: new Date('2026-10-10') });
  // Mine, migrated: two date-run documents of one plan, the legacy date.
  const legacy = (i) => ({ source: 'mysql', dietPlanId: 70, createdBy: 5, createDate: new Date('2023-09-16'), segment: { index: i, of: 2 } });
  await plan({ planId: 'gogetfit:70', name: 'ChinmayDP70.5', coachId: meCoach._id, createdBy: null, legacy: legacy(0) });
  await plan({ planId: 'gogetfit:70', name: 'ChinmayDP70.5', coachId: meCoach._id, createdBy: null, legacy: legacy(1), fromDate: day('2026-10-09'), toDate: day('2026-10-10') });
  // For my client, but written by an admin: not mine.
  await plan({ planId: 'app:2', name: 'Admin wrote', coachId: meCoach._id, createdBy: admin._id, createdAt: new Date('2026-10-12') });
  // Another coach's.
  await plan({ planId: 'app:3', name: 'Siri plan', clientId: member._id, coachId: otherCoach._id, createdBy: otherUser._id, createdAt: new Date('2026-10-11') });
  // Archived: never listed.
  await plan({ planId: 'app:4', name: 'Archived', coachId: meCoach._id, createdBy: me._id, status: 'archived', createdAt: new Date('2026-10-13') });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('YOU: only plans this coach wrote, one per plan, newest first', async () => {
  const res = await list('?scope=you');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(names(res), ['Mine new', 'ChinmayDP70.5']);
  const migrated = res.body.data.items[1];
  assert.equal(migrated.planId, 'gogetfit:70');
  assert.equal(migrated.createdOn, '2023-09-16T00:00:00.000Z', 'the legacy create date');
  assert.deepEqual(migrated.coach, { id: String(meCoach._id), name: 'Prajwal' });
  assert.ok(!('meals' in migrated) && !('clientId' in migrated), 'list fields only');
  // The other coach's YOU is theirs, whatever is asked for.
  assert.deepEqual(names(await list(`?scope=you&coachId=${meCoach._id}`, otherUser)), ['Siri plan']);
});

test('ALL: every coach\'s active plans, newest first, no duplicates', async () => {
  const res = await list('?scope=all');
  assert.deepEqual(names(res), ['Admin wrote', 'Siri plan', 'Mine new', 'ChinmayDP70.5']);
  assert.equal(res.body.data.items[1].coach.name, 'Siri');
  assert.deepEqual(res.body.data.pagination, { page: 1, pageSize: 20, total: 4, hasMore: false });
});

test('pages neither repeat nor skip a plan', async () => {
  const seen = [];
  for (let page = 1; page <= 4; page += 1) {
    const res = await list(`?scope=all&pageSize=1&page=${page}`);
    seen.push(...names(res));
    assert.equal(res.body.data.pagination.hasMore, page < 4);
  }
  assert.deepEqual(seen, ['Admin wrote', 'Siri plan', 'Mine new', 'ChinmayDP70.5']);
  assert.deepEqual((await list('?scope=all&page=9')).body.data.items, []);
});

test('an empty library is an empty page', async () => {
  await DietPlan.deleteMany({});
  const res = await list('?scope=you');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.items, []);
  assert.deepEqual(res.body.data.pagination, { page: 1, pageSize: 20, total: 0, hasMore: false });
});

test('bad parameters are a 400', async () => {
  for (const qs of ['?scope=mine', '?scope=all&page=0', '?scope=all&page=x', '?scope=all&pageSize=-1', '?scope=all&page=1.5']) {
    const res = await list(qs);
    assert.equal(res.status, 400, qs);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal((await list('?scope=all&pageSize=999')).body.data.pagination.pageSize, 50, 'capped');
});

test('one plan in full for its preview - its meals, nothing about the client', async () => {
  const res = await one('gogetfit:70');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const p = res.body.data.dietPlan;
  assert.equal(p.name, 'ChinmayDP70.5');
  assert.equal(p.createdOn, '2023-09-16T00:00:00.000Z');
  assert.equal(p.meals[0].foods[0].qty, 100);
  assert.equal(p.meals[0].foods[0].perPortion.calories, 389);
  assert.equal(p.meals[0].foods[0].food.name, 'Oats');
  for (const k of ['clientId', 'client', 'enrollment', 'gender', 'age', 'height', 'weight']) assert.ok(!(k in p), k);
  // Another coach's plan is readable too (ALL lists it); archived and unknown are not.
  assert.equal((await one('app:3')).status, 200);
  assert.equal((await one('app:4')).status, 404);
  assert.equal((await one('nope')).status, 404);
});

test('reading changes nothing', async () => {
  const before = await DietPlan.find().sort({ _id: 1 }).lean();
  await list('?scope=all');
  await list('?scope=you');
  await one('gogetfit:70');
  assert.deepEqual(await DietPlan.find().sort({ _id: 1 }).lean(), before);
});

test('signed out is 401; members and coach-less users are refused', async () => {
  assert.equal((await server.request('GET', '/api/coach/diet-plans?scope=all')).status, 401);
  assert.equal((await list('?scope=all', client)).status, 403);
  assert.equal((await one('app:1', client)).status, 403);
  const noProfile = await seedUser(['user', 'coach'], 'New coach');
  const res = await list('?scope=you', noProfile);
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'COACH_NOT_FOUND');
});

test('search: by name, any case, trimmed - in YOU only the coach\'s own', async () => {
  assert.deepEqual(names(await list('?scope=you&search=%20%20cHiNmAy%20')), ['ChinmayDP70.5']);
  assert.deepEqual(names(await list('?scope=you&search=siri')), [], 'another coach\'s plan is not in YOU');
  assert.deepEqual(names(await list('?scope=all&search=SIRI')), ['Siri plan']);
  // Archived plans stay out, searched for or not.
  assert.deepEqual(names(await list('?scope=all&search=archived')), []);
});

test('search narrows before paging and the total', async () => {
  const first = await list('?scope=all&search=e&pageSize=1');
  assert.deepEqual(names(first), ['Admin wrote']);
  assert.deepEqual(first.body.data.pagination, { page: 1, pageSize: 1, total: 2, hasMore: true });
  const second = await list('?scope=all&search=e&pageSize=1&page=2');
  assert.deepEqual(names(second), ['Mine new']);
  assert.equal(second.body.data.pagination.hasMore, false);
});

test('search text is matched literally, never as a pattern', async () => {
  assert.deepEqual(names(await list('?scope=all&search=.*')), []);
  assert.deepEqual(names(await list(`?scope=all&search=${encodeURIComponent('DP70.5')}`)), ['ChinmayDP70.5']);
  assert.deepEqual(names(await list(`?scope=all&search=${encodeURIComponent('DP70x5')}`)), [], 'the dot is a dot');
  for (const s of ['(', '[', '\\', '$where', '{"$ne":null}']) {
    const res = await list(`?scope=all&search=${encodeURIComponent(s)}`);
    assert.equal(res.status, 200, s);
    assert.deepEqual(names(res), [], s);
  }
});

test('an empty search is no search; an over-long one is a 400', async () => {
  const all = names(await list('?scope=all'));
  assert.deepEqual(names(await list('?scope=all&search=')), all);
  assert.deepEqual(names(await list('?scope=all&search=%20%20%20')), all);
  const res = await list(`?scope=all&search=${'a'.repeat(101)}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});
