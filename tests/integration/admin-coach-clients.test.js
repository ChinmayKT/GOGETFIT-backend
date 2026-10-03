import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let adminToken;
let coachToken;
let coachA;
let coachB;
let plan;

const DAY = 24 * 60 * 60 * 1000;
const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let seq = 0;
const seedUser = (roles, extra = {}) => {
  seq += 1;
  const phone = `9181000${String(seq).padStart(5, '0')}`;
  return User.create({
    phone: { raw: phone, normalized: phone },
    profile: { name: extra.name ?? `User ${seq}`, email: extra.email ?? `u${seq}@example.com` },
    roles,
    status: 'active',
    ...(extra.legacyUserId ? { legacy: { source: 'gogetfit', userId: extra.legacyUserId } } : {}),
  });
};
const seedCoach = async () => {
  const user = await seedUser(['user', 'coach']);
  return { user, coach: await Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' } }) };
};

let txn = 0;
const enroll = (coach, member, kind, extra = {}) => {
  txn += 1;
  const now = Date.now();
  const states = {
    active: { hasStarted: true, startDate: new Date(now - 10 * DAY), endDate: new Date(now + 30 * DAY) },
    pending: { hasStarted: false, startDate: null, endDate: null },
    ended: { hasStarted: true, startDate: new Date(now - 200 * DAY), endDate: new Date(now - 100 * DAY) },
    deleted: { hasStarted: true, startDate: new Date(now - 10 * DAY), endDate: new Date(now + 30 * DAY), isDeleted: true },
  };
  return EnrolledClient.create({
    userId: member._id,
    planId: plan._id,
    coachId: coach._id,
    enrollDate: extra.enrollDate ?? new Date(now - txn * DAY),
    isDeleted: false,
    ...states[kind],
    payment: { transactionId: `pay_cc_${txn}`, amount: 4999, currency: 'INR', status: 'Success' },
    ...(extra.legacyEnrollmentId ? { legacy: { source: 'gogetfit', enrollmentId: extra.legacyEnrollmentId } } : {}),
  });
};

const clients = (id, token = adminToken) => server.request('GET', `/api/admin/coaches/${id}/clients`, { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  plan = await GogetfitPlan.create({
    name: '12 WEEKS GOGETFIT PLAN',
    planType: 'Enrollment',
    coachLevel: 'LEVEL 1',
    durationWeeks: 12,
    personsAllowed: 1,
    pricing: { basePrice: 4999, reward: 0 },
    legacy: { source: 'gogetfit', packageId: 15 },
  });
  adminToken = tokenFor(await seedUser(['user', 'admin']));
  const a = await seedCoach();
  coachA = a.coach;
  coachToken = tokenFor(a.user);
  coachB = (await seedCoach()).coach;
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('a coach with several clients: statistics and one row per enrollment', async () => {
  const asha = await seedUser(['user', 'client'], { name: 'Asha' });
  const ravi = await seedUser(['user', 'client'], { name: 'Ravi' });
  const meera = await seedUser(['user', 'client'], { name: 'Meera' });
  await enroll(coachA, asha, 'active');
  await enroll(coachA, ravi, 'pending');
  await enroll(coachA, meera, 'ended');

  const res = await clients(coachA._id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { summary, enrollments, coachId } = res.body.data;
  assert.equal(coachId, String(coachA._id));
  assert.deepEqual(summary, { totalEnrollments: 3, uniqueClients: 3, activeClients: 1, pendingClients: 1, endedClients: 1, attention: 0 });
  assert.equal(enrollments.length, 3);
  assert.deepEqual(enrollments.map((e) => e.status).sort(), ['active', 'inactive', 'not_started']);
});

test('several enrollments of one member are all kept; uniqueClients counts the person once', async () => {
  const asha = await seedUser(['user', 'client'], { name: 'Asha' });
  await enroll(coachA, asha, 'ended');
  await enroll(coachA, asha, 'ended');
  await enroll(coachA, asha, 'active');

  const { summary, enrollments } = (await clients(coachA._id)).body.data;
  assert.equal(summary.totalEnrollments, 3);
  assert.equal(summary.uniqueClients, 1);
  assert.equal(enrollments.length, 3);
  assert.ok(enrollments.every((e) => e.user.id === String(asha._id)));
  // Newest first.
  const dates = enrollments.map((e) => e.enrollDate);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('deleted enrollments are excluded from the list and every count', async () => {
  const asha = await seedUser(['user', 'client']);
  await enroll(coachA, asha, 'deleted');
  await enroll(coachA, asha, 'pending');
  const { summary, enrollments } = (await clients(coachA._id)).body.data;
  assert.deepEqual(summary, { totalEnrollments: 1, uniqueClients: 1, activeClients: 0, pendingClients: 1, endedClients: 0, attention: 0 });
  assert.equal(enrollments.length, 1);
});

test('active / pending / ended: an ended cycle is in the total only', async () => {
  const m = await seedUser(['user', 'client']);
  await enroll(coachA, m, 'active');
  await enroll(coachA, m, 'pending');
  await enroll(coachA, m, 'ended');
  const { summary } = (await clients(coachA._id)).body.data;
  assert.equal(summary.totalEnrollments, 3);
  assert.equal(summary.activeClients, 1);
  assert.equal(summary.pendingClients, 1);
  assert.equal(summary.endedClients, 1);
});

test('each row carries the member, plan, dates, status and every legacy id', async () => {
  const asha = await seedUser(['user', 'client'], { name: 'Asha', email: 'asha@example.com', legacyUserId: 227 });
  const e = await enroll(coachA, asha, 'active', { legacyEnrollmentId: 140 });

  const [row] = (await clients(coachA._id)).body.data.enrollments;
  assert.equal(row.enrollmentId, String(e._id));
  assert.equal(row.legacyEnrollmentId, 140);
  assert.equal(row.coachId, String(coachA._id));
  assert.equal(row.hasStarted, true);
  assert.equal(row.status, 'active');
  assert.ok(row.enrollDate && row.startDate && row.endDate);
  assert.deepEqual(row.user, { id: String(asha._id), name: 'Asha', phone: asha.phone.normalized, email: 'asha@example.com', legacyUserId: 227 });
  assert.deepEqual(row.plan, { id: String(plan._id), name: '12 WEEKS GOGETFIT PLAN', legacyPackageId: 15 });
});

test("another coach's clients are never included", async () => {
  const mine = await seedUser(['user', 'client'], { name: 'Mine' });
  const theirs = await seedUser(['user', 'client'], { name: 'Theirs' });
  await enroll(coachA, mine, 'active');
  await enroll(coachB, theirs, 'active');
  await enroll(coachB, mine, 'pending'); // the same member with another coach

  const { summary, enrollments } = (await clients(coachA._id)).body.data;
  assert.deepEqual(summary, { totalEnrollments: 1, uniqueClients: 1, activeClients: 1, pendingClients: 0, endedClients: 0, attention: 0 });
  assert.deepEqual(enrollments.map((e) => e.user.name), ['Mine']);
});

test('a user with the client role but no enrollment with the coach is not their client', async () => {
  await seedUser(['user', 'client'], { name: 'Role only' });
  const { summary, enrollments } = (await clients(coachA._id)).body.data;
  assert.equal(summary.totalEnrollments, 0);
  assert.deepEqual(enrollments, []);
});

test('an unknown or malformed coach id is a 404', async () => {
  for (const id of [new mongoose.Types.ObjectId().toString(), 'nope']) {
    const res = await clients(id);
    assert.equal(res.status, 404, id);
    assert.equal(res.body.error.code, 'COACH_NOT_FOUND');
  }
});

test('admins only', async () => {
  assert.equal((await clients(coachA._id, coachToken)).status, 403);
  assert.equal((await server.request('GET', `/api/admin/coaches/${coachA._id}/clients`)).status, 401);
});
