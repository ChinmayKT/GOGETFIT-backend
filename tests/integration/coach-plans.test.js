import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import User from '../../src/models/user.model.js';
import Coach from '../../src/models/coach.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let memberToken;

const LEVELS = ['LEVEL 1', 'LEVEL 2', 'LEVEL 3', 'LEVEL 4', 'LEVEL 5'];

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let phoneSeq = 0;
const seedUser = (roles, status = 'active') => {
  phoneSeq += 1;
  const phone = `9170000${String(phoneSeq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `Coach ${phoneSeq}` }, roles, status });
};

const seedCoach = async (level, { status = 'active', userStatus = 'active' } = {}) => {
  const user = await seedUser(['user', 'coach'], userStatus);
  return Coach.create({ userId: user._id, profile: { level }, status });
};

let planSeq = 0;
const seedPlan = (coachLevel, { status = 'active', name } = {}) => {
  planSeq += 1;
  return GogetfitPlan.create({
    name: name ?? `${coachLevel} PLAN ${planSeq}`,
    planType: 'Enrollment',
    coachLevel,
    durationWeeks: 12,
    personsAllowed: 1,
    pricing: { basePrice: 4999, reward: 0 },
    content: { description: 'd', inclusions: '* a\n* b' },
    status,
    createdBy: new mongoose.Types.ObjectId(),
    updatedBy: new mongoose.Types.ObjectId(),
    migration: { runId: 'secret-run', migratedAt: new Date(), version: 1 },
    legacy: { source: 'gogetfit', packageId: 1000 + planSeq, createdBy: '123' },
  });
};

const plansOf = (coachId, qs = '', token = memberToken) =>
  server.request('GET', `/api/coaches/${coachId}/plans${qs}`, { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  memberToken = tokenFor(await seedUser(['user']));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('IMPORTANT: a Level 1 coach gets the active Level 1 plan only - not archived, not Level 2', async () => {
  const coachA = await seedCoach('LEVEL 1');
  const planA = await seedPlan('LEVEL 1', { name: 'Plan A' });
  await seedPlan('LEVEL 1', { name: 'Plan B', status: 'archived' });
  await seedPlan('LEVEL 2', { name: 'Plan C' });

  const res = await plansOf(coachA._id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.plans.map((p) => p.name), ['Plan A']);
  // 10. The real MongoDB id.
  assert.equal(res.body.data.plans[0].id, String(planA._id));
  assert.deepEqual(res.body.data.coach, { id: String(coachA._id), name: res.body.data.coach.name, level: 'LEVEL 1' });
  assert.equal(res.body.data.pagination.total, 1);
});

test('1-5. every level sees exactly its own active plans', async () => {
  const expected = {};
  for (const level of LEVELS) {
    expected[level] = [];
    for (let i = 0; i < 2; i += 1) expected[level].push(String((await seedPlan(level))._id));
    await seedPlan(level, { status: 'archived' });
  }

  for (const level of LEVELS) {
    const coach = await seedCoach(level);
    const res = await plansOf(coach._id);
    assert.equal(res.status, 200, level);
    assert.deepEqual(res.body.data.plans.map((p) => p.id), expected[level], level);
    assert.ok(res.body.data.plans.every((p) => p.coachLevel === level), level);
  }
});

test('changing the coach level changes the plans, with nothing stored on the coach', async () => {
  const coach = await seedCoach('LEVEL 1');
  await seedPlan('LEVEL 1', { name: 'One' });
  await seedPlan('LEVEL 2', { name: 'Two' });

  assert.deepEqual((await plansOf(coach._id)).body.data.plans.map((p) => p.name), ['One']);
  await Coach.updateOne({ _id: coach._id }, { $set: { 'profile.level': 'LEVEL 2' } });
  assert.deepEqual((await plansOf(coach._id)).body.data.plans.map((p) => p.name), ['Two']);

  const stored = await Coach.findById(coach._id).lean();
  assert.equal(stored.planIds, undefined);
  assert.equal((await GogetfitPlan.findOne({ name: 'Two' }).lean()).coachId, undefined);
});

test('6. archived plans never appear, and an archived-only level is an empty list', async () => {
  const coach = await seedCoach('LEVEL 3');
  await seedPlan('LEVEL 3', { status: 'archived' });
  const res = await plansOf(coach._id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.plans, []);
  assert.equal(res.body.data.pagination.total, 0);
});

test('7-9. inactive coach, inactive account and unknown or malformed coach are 404', async () => {
  await seedPlan('LEVEL 1');
  const inactive = await seedCoach('LEVEL 1', { status: 'inactive' });
  const blocked = await seedCoach('LEVEL 1', { userStatus: 'blocked' });

  for (const id of [inactive._id, blocked._id, new mongoose.Types.ObjectId(), 'not-an-id']) {
    const res = await plansOf(id);
    assert.equal(res.status, 404, String(id));
    assert.equal(res.body.error.code, 'COACH_NOT_FOUND');
  }
});

test('11. the client cannot choose the level', async () => {
  const coach = await seedCoach('LEVEL 1');
  await seedPlan('LEVEL 1', { name: 'Mine' });
  await seedPlan('LEVEL 2', { name: 'Not mine' });

  for (const qs of ['?coachLevel=LEVEL%202', '?level=LEVEL%202', '?planLevel=2', '?status=archived', '?coachLevel=LEVEL%202&level=2']) {
    const res = await plansOf(coach._id, qs);
    assert.equal(res.status, 200, qs);
    assert.deepEqual(res.body.data.plans.map((p) => p.name), ['Mine'], qs);
  }
});

test('12. pagination', async () => {
  const coach = await seedCoach('LEVEL 4');
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(String((await seedPlan('LEVEL 4'))._id));

  const page1 = await plansOf(coach._id, '?page=1&pageSize=2');
  assert.deepEqual(page1.body.data.plans.map((p) => p.id), ids.slice(0, 2));
  assert.deepEqual(page1.body.data.pagination, { page: 1, pageSize: 2, total: 5, totalPages: 3 });
  assert.deepEqual((await plansOf(coach._id, '?page=3&pageSize=2')).body.data.plans.map((p) => p.id), ids.slice(4));
  assert.equal((await plansOf(coach._id, '?page=0')).status, 400);
});

test('the member plan shape carries the plan content and no admin internals', async () => {
  const coach = await seedCoach('LEVEL 1');
  await seedPlan('LEVEL 1');
  const [plan] = (await plansOf(coach._id)).body.data.plans;

  assert.deepEqual(Object.keys(plan).sort(), ['coachLevel', 'content', 'durationWeeks', 'id', 'image', 'name', 'personsAllowed', 'planType', 'pricing']);
  assert.equal(plan.image, null);
  assert.deepEqual(plan.pricing, { basePrice: 4999, reward: 0, currency: 'INR' });
  assert.equal(plan.content.inclusions, '* a\n* b');
  const text = JSON.stringify(plan);
  assert.doesNotMatch(text, /secret-run|createdBy|updatedBy|deletedBy|legacy|migration|status|_id/);
});

test('authentication is required', async () => {
  const coach = await seedCoach('LEVEL 1');
  assert.equal((await plansOf(coach._id, '', null)).status, 401);
});

test('the lookup uses the level index, not a collection scan', async () => {
  await GogetfitPlan.syncIndexes();
  const explain = await GogetfitPlan.find({ status: 'active', coachLevel: 'LEVEL 1' }).sort({ createdAt: 1, _id: 1 }).explain('queryPlanner');
  const text = JSON.stringify(explain.queryPlanner.winningPlan);
  assert.match(text, /gogetfitplan_status_level_created/);
  assert.doesNotMatch(text, /COLLSCAN/);
});
