import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import User from '../../src/models/user.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import { loadGogetfitPlans, verifyGogetfitPlans } from '../../migration/loaders/gogetfit-plan.loader.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let adminToken;
let admin;
let memberToken;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const seedUser = (phone, roles) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: phone }, roles, status: 'active' });

const validPlan = (overrides = {}) => ({
  name: '12 WEEKS GOGETFIT PLAN',
  planType: 'Enrollment',
  coachLevel: 'LEVEL 1',
  durationWeeks: 12,
  personsAllowed: 1,
  pricing: { basePrice: 4999 },
  content: {
    description: "Healthy isn't a goal, it's a way of living.",
    inclusions: '* A personalised diet plan\n* Weekly check-ins',
  },
  ...overrides,
});

const create = (body, token = adminToken) => server.request('POST', '/api/admin/gogetfit-plans', { token, body });
const list = (qs = '', token = adminToken) => server.request('GET', `/api/admin/gogetfit-plans${qs}`, { token });

/** A legacy m_package row, exactly as mysql2 returns it. */
const legacyRow = (overrides = {}) => ({
  package_id: 15,
  package_type: 'Enrollment',
  package_name: '12 WEEKS GOGETFIT PLAN',
  coach_level: 'LEVEL 1',
  duration: 12,
  person_allowed: 1,
  base_price: 4999,
  reward: 0,
  description: "Healthy isn't a goal.\r\nIt's a way of living.",
  inclusions: '"* A personalised diet plan\n* Weekly check-ins',
  what_next: "* Once enrolled, go to 'My bookings'",
  tandc: '*Money refund is only valid for genuine cases',
  eligibility: 'You must be at least 18 years to enrol',
  created_by: '123',
  last_update_date: new Date('2022-01-24T03:32:59Z'),
  last_update_by: '123',
  ...overrides,
});

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  admin = await seedUser('918000000000', ['user', 'admin']);
  adminToken = tokenFor(admin);
  memberToken = tokenFor(await seedUser('919000000001', ['user', 'client', 'coach']));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// --- CRUD --------------------------------------------------------------------

test('4. an admin creates a plan; audit fields come from the token', async () => {
  const res = await create(validPlan());
  assert.equal(res.status, 201);
  const { plan } = res.body.data;
  assert.equal(plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.deepEqual(plan.pricing, { basePrice: 4999, reward: null, currency: 'INR' });
  assert.equal(plan.content.inclusions, '* A personalised diet plan\n* Weekly check-ins');
  assert.equal(plan.status, 'active');

  const stored = await GogetfitPlan.findById(plan.id).lean();
  assert.equal(String(stored.createdBy), String(admin._id));
  assert.equal(stored.legacy, undefined);
});

test('3, 13, 14. fetch one plan; malformed and unknown ids are 404', async () => {
  const { plan } = (await create(validPlan())).body.data;
  const one = await server.request('GET', `/api/admin/gogetfit-plans/${plan.id}`, { token: adminToken });
  assert.equal(one.status, 200);
  assert.equal(one.body.data.plan.id, plan.id);

  for (const id of ['not-an-id', new mongoose.Types.ObjectId().toString()]) {
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const r = await server.request(method, `/api/admin/gogetfit-plans/${id}`, { token: adminToken, body: method === 'PATCH' ? { name: 'x' } : undefined });
      assert.equal(r.status, 404, `${method} ${id}`);
      assert.equal(r.body.error.code, 'GOGETFIT_PLAN_NOT_FOUND');
    }
  }
});

test('2. non-admins and anonymous callers cannot manage plans', async () => {
  const { plan } = (await create(validPlan())).body.data;
  const calls = [
    ['GET', '/api/admin/gogetfit-plans'],
    ['GET', `/api/admin/gogetfit-plans/${plan.id}`],
    ['POST', '/api/admin/gogetfit-plans', validPlan()],
    ['PATCH', `/api/admin/gogetfit-plans/${plan.id}`, { name: 'Hacked' }],
    ['DELETE', `/api/admin/gogetfit-plans/${plan.id}`],
  ];
  for (const [method, path, body] of calls) {
    assert.equal((await server.request(method, path, { token: memberToken, body })).status, 403, `${method} ${path}`);
    assert.equal((await server.request(method, path, { body })).status, 401, `${method} ${path} anon`);
  }
  const stored = await GogetfitPlan.findById(plan.id).lean();
  assert.equal(stored.name, '12 WEEKS GOGETFIT PLAN');
  assert.equal(stored.status, 'active');
  assert.equal(await GogetfitPlan.countDocuments(), 1);
});

test('5. validation rejects invalid plans', async () => {
  const cases = [
    [{ name: '' }, /name is required/],
    [{ name: 'x'.repeat(46) }, /at most 45/],
    [{ planType: 'Subscription' }, /planType must be one of/],
    [{ coachLevel: 'LEVEL 9' }, /coachLevel must be one of/],
    [{ durationWeeks: 0 }, /durationWeeks must be between/],
    [{ durationWeeks: 12.5 }, /whole number/],
    [{ personsAllowed: -1 }, /personsAllowed/],
    [{ pricing: { basePrice: -5 } }, /basePrice/],
    [{ pricing: {} }, /basePrice must be a number/],
    [{ pricing: { basePrice: '4999' } }, /basePrice must be a number/],
    [{ pricing: { basePrice: 100, reward: 200 } }, /cannot be more than/],
    [{ content: { notes: 'x' } }, /Unknown content field/],
    [{ legacy: { packageId: 1 } }, /not accepted from the client/],
    [{ createdBy: 'x' }, /not accepted from the client/],
    [{ color: 'red' }, /Unknown field/],
  ];
  for (const [overrides, message] of cases) {
    const res = await create(validPlan(overrides));
    assert.equal(res.status, 400, JSON.stringify(overrides));
    assert.match(res.body.error.message, message);
  }
  const { durationWeeks, ...missing } = validPlan();
  assert.equal((await create(missing)).status, 400);
  assert.equal(await GogetfitPlan.countDocuments(), 0);
});

test('6. the legacy business rule: a Challenge must have a reward, on create and on edit', async () => {
  const noReward = await create(validPlan({ planType: 'Challenge' }));
  assert.equal(noReward.status, 400);
  assert.equal(noReward.body.error.message, 'Reward (Refund Amount) is mandatory when challenge is selected');

  const challenge = await create(validPlan({ planType: 'Challenge', pricing: { basePrice: 7999, reward: 3999 } }));
  assert.equal(challenge.status, 201);

  // Turning an Enrollment (no reward) into a Challenge without adding one is refused too.
  const { plan } = (await create(validPlan())).body.data;
  const edit = await server.request('PATCH', `/api/admin/gogetfit-plans/${plan.id}`, { token: adminToken, body: { planType: 'Challenge' } });
  assert.equal(edit.status, 400);
  const ok = await server.request('PATCH', `/api/admin/gogetfit-plans/${plan.id}`, {
    token: adminToken,
    body: { planType: 'Challenge', pricing: { reward: 2000 } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.plan.pricing.reward, 2000);
});

test('6b. no duplicate rule is invented: the same name can exist twice, as in legacy', async () => {
  assert.equal((await create(validPlan())).status, 201);
  assert.equal((await create(validPlan())).status, 201);
});

test('7. an admin updates any field; untouched fields and zero values survive', async () => {
  const { plan } = (await create(validPlan({ pricing: { basePrice: 0 } }))).body.data;
  const other = await seedUser('918000000009', ['user', 'admin']);

  const res = await server.request('PATCH', `/api/admin/gogetfit-plans/${plan.id}`, {
    token: tokenFor(other),
    body: { name: '24 WEEKS GOGETFIT PLAN', durationWeeks: 24, content: { eligibility: '18+' } },
  });
  assert.equal(res.status, 200);
  const updated = res.body.data.plan;
  assert.equal(updated.name, '24 WEEKS GOGETFIT PLAN');
  assert.equal(updated.durationWeeks, 24);
  assert.equal(updated.pricing.basePrice, 0);
  assert.equal(updated.content.eligibility, '18+');
  assert.equal(updated.content.inclusions, '* A personalised diet plan\n* Weekly check-ins');

  const stored = await GogetfitPlan.findById(plan.id).lean();
  assert.equal(String(stored.createdBy), String(admin._id));
  assert.equal(String(stored.updatedBy), String(other._id));

  const empty = await server.request('PATCH', `/api/admin/gogetfit-plans/${plan.id}`, { token: adminToken, body: {} });
  assert.equal(empty.status, 400);
});

test('8-9. delete archives: hidden from the list, kept in MongoDB, restorable', async () => {
  const { plan } = (await create(validPlan())).body.data;

  const del = await server.request('DELETE', `/api/admin/gogetfit-plans/${plan.id}`, { token: adminToken });
  assert.equal(del.status, 200);
  assert.equal(del.body.data.plan.status, 'archived');
  assert.ok(del.body.data.plan.deletedAt);

  assert.equal((await list()).body.data.pagination.total, 0);
  assert.equal((await list('?status=archived')).body.data.plans[0].id, plan.id);

  const stored = await GogetfitPlan.findById(plan.id).lean();
  assert.equal(stored.status, 'archived');
  assert.equal(String(stored.deletedBy), String(admin._id));

  const restore = await server.request('PATCH', `/api/admin/gogetfit-plans/${plan.id}`, { token: adminToken, body: { status: 'active' } });
  assert.equal(restore.body.data.plan.status, 'active');
  assert.equal(restore.body.data.plan.deletedAt, null);
  assert.equal((await list()).body.data.pagination.total, 1);
});

test('1, 10-12. list: server-side pagination, name search, type/level filters, sorting', async () => {
  const specs = [
    ['12 WEEKS GOGETFIT PLAN', 'Enrollment', 'LEVEL 1', 4999],
    ['24 WEEKS GOGETFIT PLAN', 'Enrollment', 'LEVEL 1', 8999],
    ['12 WEEKS COUPLE GOGETFIT PLAN', 'Enrollment', 'LEVEL 2', 8999],
    ['12 WEEKS GOGETFIT PLAN (CHALLENGE)', 'Challenge', 'LEVEL 1', 7999],
    ['52 WEEKS GOGETFIT PLAN', 'Enrollment', 'LEVEL 3', 16999],
  ];
  for (const [name, planType, coachLevel, basePrice] of specs) {
    const reward = planType === 'Challenge' ? 3999 : undefined;
    assert.equal((await create(validPlan({ name, planType, coachLevel, pricing: { basePrice, reward } }))).status, 201);
  }

  const page1 = await list('?page=1&pageSize=2');
  assert.deepEqual(page1.body.data.pagination, { page: 1, pageSize: 2, total: 5, totalPages: 3 });
  // Default order is creation order, oldest first - the legacy list's order.
  assert.deepEqual(page1.body.data.plans.map((p) => p.name), ['12 WEEKS GOGETFIT PLAN', '24 WEEKS GOGETFIT PLAN']);
  assert.equal((await list('?page=3&pageSize=2')).body.data.plans.length, 1);

  const names = async (qs) => (await list(qs)).body.data.plans.map((p) => p.name);
  assert.deepEqual(await names('?search=couple'), ['12 WEEKS COUPLE GOGETFIT PLAN']);
  assert.deepEqual(await names('?planType=Challenge'), ['12 WEEKS GOGETFIT PLAN (CHALLENGE)']);
  assert.deepEqual(await names('?coachLevel=LEVEL 3'), ['52 WEEKS GOGETFIT PLAN']);
  assert.deepEqual(await names('?sortKey=basePrice&sortDir=desc&pageSize=1'), ['52 WEEKS GOGETFIT PLAN']);
  assert.deepEqual(await names('?search=nothing-like-this'), []);

  assert.equal((await list('?planType=Other')).status, 400);
  assert.equal((await list('?sortKey=password')).status, 400);
});

// --- Migration -----------------------------------------------------------------

test('15. migration is faithful and idempotent; a portal edit is a reported conflict, never overwritten', async () => {
  const rows = [
    legacyRow(),
    legacyRow({ package_id: 22, package_type: 'Challenge', package_name: '12 WEEKS GOGETFIT PLAN (CHALLENGE)', base_price: 7999, reward: 3999 }),
    legacyRow({ package_id: 30, reward: null, description: '', coach_level: null }),
  ];

  const dry = await loadGogetfitPlans(rows, { dryRun: true, runId: 'dry', source: 'gogetfit' });
  assert.equal(dry.toCreate, 3);
  assert.equal(await GogetfitPlan.countDocuments(), 0);

  const first = await loadGogetfitPlans(rows, { dryRun: false, runId: 'run-1', source: 'gogetfit' });
  assert.equal(first.created, 3);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.quality.leadingQuoteInclusions, [15, 22, 30]);

  const stored = await GogetfitPlan.findOne({ 'legacy.packageId': 15 }).lean();
  assert.equal(stored.name, '12 WEEKS GOGETFIT PLAN');
  assert.equal(stored.pricing.reward, 0);
  assert.equal(stored.content.description, "Healthy isn't a goal.\r\nIt's a way of living.");
  assert.equal(stored.content.inclusions, '"* A personalised diet plan\n* Weekly check-ins');
  assert.equal(stored.legacy.createdBy, '123');
  assert.equal(stored.legacy.updatedAt.toISOString(), '2022-01-24T03:32:59.000Z');
  assert.equal(stored.migration.runId, 'run-1');
  const blank = await GogetfitPlan.findOne({ 'legacy.packageId': 30 }).lean();
  assert.equal(blank.content.description, null);
  assert.equal(blank.pricing.reward, null);

  // Second run: nothing created, nothing changed.
  const second = await loadGogetfitPlans(rows, { dryRun: false, runId: 'run-2', source: 'gogetfit' });
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 3);
  assert.equal(await GogetfitPlan.countDocuments(), 3);

  const verify = await verifyGogetfitPlans(rows, { source: 'gogetfit' });
  assert.deepEqual(verify, { legacyCount: 3, mongoCount: 3, missing: [], mismatches: [], extra: [] });

  // A legacy change updates an untouched plan...
  const changed = rows.map((r) => (r.package_id === 30 ? { ...r, base_price: 5999 } : r));
  const third = await loadGogetfitPlans(changed, { dryRun: false, runId: 'run-3', source: 'gogetfit' });
  assert.equal(third.updated, 1);

  // ...but never one an admin has edited in the new portal.
  await server.request('PATCH', `/api/admin/gogetfit-plans/${stored._id}`, { token: adminToken, body: { name: 'Edited in portal' } });
  const fourth = await loadGogetfitPlans(rows, { dryRun: false, runId: 'run-4', source: 'gogetfit' });
  assert.equal(fourth.conflicts.length, 1);
  assert.deepEqual(fourth.conflicts[0].fields, ['name']);
  assert.equal((await GogetfitPlan.findById(stored._id).lean()).name, 'Edited in portal');

  // The unique legacy index is the hard backstop against duplicates.
  await assert.rejects(GogetfitPlan.create({ ...stored, _id: undefined }), /E11000/);
});

test('migration reports unusable rows instead of guessing', async () => {
  const result = await loadGogetfitPlans(
    [legacyRow({ package_id: 40, package_name: '  ' }), legacyRow({ package_id: 41, base_price: null }), legacyRow({ package_id: 42 }), legacyRow({ package_id: 42 })],
    { dryRun: false, runId: 'run', source: 'gogetfit' },
  );
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.duplicateLegacyIds, [42]);
  assert.equal(result.created, 1);
});
