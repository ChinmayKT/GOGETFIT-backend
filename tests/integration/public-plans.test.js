import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * GET /api/plans/public - the plans catalogue with no token (the guest Plans
 * tab): the same GoGetFit Plan documents, rows and order a Level 1 coach shows a
 * signed-in member, and nothing private.
 */
let server;

const IMAGE = { url: 'http://example.test/uploads/plans/p/cover.jpg', storageKey: 'plans/p/cover.jpg' };
const MEMBER_PLAN_KEYS = ['coachLevel', 'content', 'durationWeeks', 'id', 'image', 'name', 'personsAllowed', 'planType', 'pricing'];

let seq = 0;
const seedPlan = (coachLevel, { status = 'active', name, image = IMAGE } = {}) => {
  seq += 1;
  return GogetfitPlan.create({
    name: name ?? `${coachLevel} PLAN ${seq}`,
    planType: 'Enrollment',
    coachLevel,
    durationWeeks: 12,
    personsAllowed: 1,
    pricing: { basePrice: 4999, reward: 0 },
    content: { description: 'd', inclusions: '* a\n* b' },
    image,
    status,
    createdBy: new mongoose.Types.ObjectId(),
    updatedBy: new mongoose.Types.ObjectId(),
    migration: { runId: 'secret-run', migratedAt: new Date(), version: 1 },
    legacy: { source: 'gogetfit', packageId: 2000 + seq, createdBy: '123' },
  });
};

const publicPlans = (qs = '') => server.request('GET', `/api/plans/public${qs}`);

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('no token needed: the active entry-tier plans, nothing archived, no other level', async () => {
  const a = await seedPlan('LEVEL 1', { name: '12 WEEKS GOGETFIT PLAN' });
  const b = await seedPlan('LEVEL 1', { name: '24 WEEKS GOGETFIT PLAN' });
  await seedPlan('LEVEL 1', { name: 'OLD CHALLENGE', status: 'archived' });
  await seedPlan('LEVEL 2', { name: 'LEVEL 2 PLAN' });

  const res = await publicPlans();

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.plans.map((p) => p.id), [String(a._id), String(b._id)]);
  assert.equal(res.body.data.pagination.total, 2);
});

test('exactly what a Level 1 coach shows a signed-in member: same rows, same order', async () => {
  for (let i = 0; i < 4; i += 1) await seedPlan('LEVEL 1');
  const user = await User.create({ phone: { raw: '917100000001', normalized: '917100000001' }, profile: { name: 'Coach' }, roles: ['user', 'coach'], status: 'active' });
  const coach = await Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' }, status: 'active' });
  const member = await User.create({ phone: { raw: '917100000002', normalized: '917100000002' }, profile: { name: 'M' }, roles: ['user'], status: 'active' });
  const token = jwt.sign({ sub: String(member._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const signedIn = await server.request('GET', `/api/coaches/${coach._id}/plans`, { token });
  const guest = await publicPlans();

  assert.equal(signedIn.status, 200, 'the authenticated endpoint is unchanged');
  assert.deepEqual(guest.body.data.plans, signedIn.body.data.plans);
});

test('plan facts only: no user, coach, enrollment, cart, admin or migration field', async () => {
  await seedPlan('LEVEL 1');

  const [plan] = (await publicPlans()).body.data.plans;

  assert.deepEqual(Object.keys(plan).sort(), MEMBER_PLAN_KEYS);
  assert.equal('coach' in (await publicPlans()).body.data, false);
  const text = JSON.stringify(plan);
  for (const secret of ['secret-run', 'createdBy', 'updatedBy', 'legacy', 'status', 'userId']) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('the plan image is returned as stored; a plan without one has null', async () => {
  await seedPlan('LEVEL 1', { name: 'A' });
  await seedPlan('LEVEL 1', { name: 'B', image: null });

  const [withImage, without] = (await publicPlans()).body.data.plans;

  assert.deepEqual(withImage.image, IMAGE);
  assert.equal(without.image, null);
});

test('paging works and a bad page is a 400; a token, if sent, changes nothing', async () => {
  for (let i = 0; i < 3; i += 1) await seedPlan('LEVEL 1');

  const page2 = await publicPlans('?page=2&pageSize=2');
  assert.equal(page2.body.data.plans.length, 1);
  assert.deepEqual(page2.body.data.pagination, { page: 2, pageSize: 2, total: 3, totalPages: 2 });
  assert.equal((await publicPlans('?page=0')).status, 400);
});

test('read-only: nothing to write here', async () => {
  const plan = await seedPlan('LEVEL 1');
  assert.equal((await server.request('POST', '/api/plans/public', { body: { name: 'x' } })).status, 404);
  assert.equal((await server.request('DELETE', `/api/plans/public/${plan._id}`)).status, 404);
  assert.equal(await GogetfitPlan.countDocuments(), 1);
});
