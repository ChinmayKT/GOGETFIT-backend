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
let coachA;
let coachB;
let coachAToken;
let memberToken;
let plan;

const DAY = 24 * 60 * 60 * 1000;
const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let seq = 0;
const seedUser = (roles) => {
  seq += 1;
  const phone = `9180000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `User ${seq}` }, roles, status: 'active' });
};
const seedCoach = async () => {
  const user = await seedUser(['user', 'coach']);
  const coach = await Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' } });
  return { user, coach };
};

let txn = 0;
/** One enrollment with [coach]; `kind` decides its state relative to now. */
const enroll = async (coach, kind) => {
  txn += 1;
  const member = await seedUser(['user', 'client']);
  const now = Date.now();
  const states = {
    active: { hasStarted: true, startDate: new Date(now - 10 * DAY), endDate: new Date(now + 30 * DAY) },
    pending: { hasStarted: false, startDate: null, endDate: null },
    ended: { hasStarted: true, startDate: new Date(now - 100 * DAY), endDate: new Date(now - 1 * DAY) },
    deletedActive: { hasStarted: true, startDate: new Date(now - 10 * DAY), endDate: new Date(now + 30 * DAY), isDeleted: true },
    deletedPending: { hasStarted: false, startDate: null, endDate: null, isDeleted: true },
  };
  return EnrolledClient.create({
    userId: member._id,
    planId: plan._id,
    coachId: coach._id,
    enrollDate: new Date(now - 20 * DAY),
    isDeleted: false,
    ...states[kind],
    payment: { transactionId: `pay_dash_${txn}`, amount: 4999, currency: 'INR', status: 'Success' },
  });
};

const dashboard = (token = coachAToken, qs = '') => server.request('GET', `/api/coach/dashboard${qs}`, { token });

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
  });
  const a = await seedCoach();
  const b = await seedCoach();
  coachA = a.coach;
  coachB = b.coach;
  coachAToken = tokenFor(a.user);
  memberToken = tokenFor(await seedUser(['user', 'client']));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('counts the signed-in coach\'s enrollments: total, active, pending; attention is 0', async () => {
  await enroll(coachA, 'active');
  await enroll(coachA, 'active');
  await enroll(coachA, 'pending');
  await enroll(coachA, 'ended');

  const res = await dashboard();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { totalEnrollments: 4, activeClients: 2, pendingClients: 1, attention: 0 });
});

test('an ended enrollment counts in the total but not as active or pending', async () => {
  await enroll(coachA, 'ended');
  const { data } = (await dashboard()).body;
  assert.equal(data.totalEnrollments, 1);
  assert.equal(data.activeClients, 0);
  assert.equal(data.pendingClients, 0);
});

test('a not-started enrollment is pending, not active', async () => {
  await enroll(coachA, 'pending');
  const { data } = (await dashboard()).body;
  assert.deepEqual(data, { totalEnrollments: 1, activeClients: 0, pendingClients: 1, attention: 0 });
});

test('a not-started enrollment whose end date already passed is not pending', async () => {
  const e = await enroll(coachA, 'pending');
  await EnrolledClient.updateOne({ _id: e._id }, { $set: { endDate: new Date(Date.now() - DAY) } });
  const { data } = (await dashboard()).body;
  assert.equal(data.pendingClients, 0);
  assert.equal(data.totalEnrollments, 1);
});

test('deleted enrollments are excluded from every count', async () => {
  await enroll(coachA, 'deletedActive');
  await enroll(coachA, 'deletedPending');
  await enroll(coachA, 'active');
  const { data } = (await dashboard()).body;
  assert.deepEqual(data, { totalEnrollments: 1, activeClients: 1, pendingClients: 0, attention: 0 });
});

test("another coach's enrollments are never included - and a coachId in the request is ignored", async () => {
  await enroll(coachB, 'active');
  await enroll(coachB, 'pending');
  await enroll(coachA, 'pending');

  const own = (await dashboard()).body.data;
  assert.deepEqual(own, { totalEnrollments: 1, activeClients: 0, pendingClients: 1, attention: 0 });

  // Asking for coach B's id changes nothing: identity comes from the token.
  const spoofed = (await dashboard(coachAToken, `?coachId=${coachB._id}`)).body.data;
  assert.deepEqual(spoofed, own);
});

test('unauthenticated requests are rejected', async () => {
  const res = await server.request('GET', '/api/coach/dashboard');
  assert.equal(res.status, 401);
});

test('non-coach users are rejected', async () => {
  const res = await dashboard(memberToken);
  assert.equal(res.status, 403);
});

test('a user with the coach role but no coach profile gets a clear 404', async () => {
  const roleOnly = await seedUser(['user', 'coach']);
  const res = await dashboard(tokenFor(roleOnly));
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'COACH_NOT_FOUND');
});

test('a coach with no enrollments sees zeros', async () => {
  const res = await dashboard();
  assert.deepEqual(res.body.data, { totalEnrollments: 0, activeClients: 0, pendingClients: 0, attention: 0 });
  assert.ok(mongoose.isValidObjectId(String(coachA._id)));
});
