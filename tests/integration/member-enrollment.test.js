import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import User from '../../src/models/user.model.js';
import Coach from '../../src/models/coach.model.js';
import CartItem from '../../src/models/cart-item.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let member;
let memberToken;
let otherMember;
let otherToken;
let coach;
let secondCoach;
let plan;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const seedUser = (phone, roles = ['user'], name) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: name ?? `User ${phone}` }, roles, status: 'active' });

const seedCoach = async (phone, name, level = 'LEVEL 1') => {
  const coachUser = await seedUser(phone, ['user', 'coach'], name);
  return Coach.create({ userId: coachUser._id, profile: { level }, status: 'active' });
};

const seedPlan = (overrides = {}) =>
  GogetfitPlan.create({
    name: '12 WEEKS GOGETFIT PLAN',
    planType: 'Enrollment',
    coachLevel: 'LEVEL 1',
    durationWeeks: 12,
    personsAllowed: 1,
    pricing: { basePrice: 4999, reward: null },
    status: 'active',
    ...overrides,
  });

const days = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
};

const seedEnrollment = (overrides = {}) =>
  EnrolledClient.create({
    userId: member._id,
    planId: plan._id,
    coachId: coach._id,
    enrollDate: days(-30),
    startDate: days(-29),
    endDate: days(55),
    hasStarted: true,
    isDeleted: false,
    payment: {
      transactionId: `pay_${Math.random().toString(36).slice(2)}`,
      amount: 4999,
      currency: 'INR',
      originalAmount: 4999,
      discountPercent: 0,
      status: 'Success',
      paidAt: days(-30),
    },
    createdBy: member._id,
    updatedBy: member._id,
    ...overrides,
  });

const myEnrollments = (token = memberToken) => server.request('GET', '/api/users/me/enrollments', { token });
const myCoach = (token = memberToken) => server.request('GET', '/api/users/me/coach', { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  await CartItem.deleteMany({});
  member = await seedUser('919000000001', ['user'], 'Rohit Sharma');
  memberToken = tokenFor(member);
  otherMember = await seedUser('919000000002', ['user'], 'Someone Else');
  otherToken = tokenFor(otherMember);
  coach = await seedCoach('917000000001', 'Coach Prajwal');
  secondCoach = await seedCoach('917000000002', 'Coach Anita', 'LEVEL 2');
  plan = await seedPlan();
});

after(async () => {
  await CartItem.deleteMany({});
  await server.close();
  await disconnectTestDb();
});

test('both member endpoints require authentication', async () => {
  assert.equal((await server.request('GET', '/api/users/me/enrollments', {})).status, 401);
  assert.equal((await server.request('GET', '/api/users/me/coach', {})).status, 401);
});

test('a member with no purchase gets an empty list and no current enrollment', async () => {
  const res = await myEnrollments();

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.enrollments, []);
  assert.equal(res.body.data.total, 0);
  assert.equal(res.body.data.current, null);
  assert.equal((await myCoach()).body.data.coach, null);
});

test('an enrollment carries the plan, the coach, the dates and what was paid', async () => {
  await seedEnrollment();
  const res = await myEnrollments();

  const [enrollment] = res.body.data.enrollments;
  assert.equal(enrollment.plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.equal(enrollment.plan.durationWeeks, 12);
  assert.equal(enrollment.coach.user.name, 'Coach Prajwal');
  assert.equal(enrollment.payment.amount, 4999);
  assert.equal(enrollment.payment.currency, 'INR');
  assert.ok(enrollment.enrollDate);
  assert.ok(enrollment.startDate);
  assert.ok(enrollment.endDate);
  assert.equal(enrollment.status, 'active');
});

test('several historical enrollments are all returned, newest purchase first', async () => {
  const older = await seedEnrollment({ enrollDate: days(-400), startDate: days(-399), endDate: days(-310) });
  const newer = await seedEnrollment({ coachId: secondCoach._id, enrollDate: days(-10), startDate: days(-9), endDate: days(80) });

  const res = await myEnrollments();
  assert.equal(res.body.data.total, 2);
  assert.deepEqual(
    res.body.data.enrollments.map((e) => e.id),
    [String(newer._id), String(older._id)],
  );

  // The older cycle is history, not a current plan.
  assert.equal(res.body.data.enrollments[1].status, 'inactive');
  assert.equal(res.body.data.current.id, String(newer._id));
});

test('an enrollment that has not started is listed but is not the current one', async () => {
  await seedEnrollment({ hasStarted: false, startDate: null, endDate: null });

  const res = await myEnrollments();
  assert.equal(res.body.data.total, 1);
  assert.equal(res.body.data.enrollments[0].status, 'not_started');
  assert.equal(res.body.data.current, null);
  assert.equal((await myCoach()).body.data.coach, null);
});

test('a soft-deleted enrollment is not shown to the member', async () => {
  await seedEnrollment({ isDeleted: true });

  const res = await myEnrollments();
  assert.equal(res.body.data.total, 0);
  assert.equal(res.body.data.current, null);
});

test('cart items never appear as orders', async () => {
  // Something in the cart is not a purchase.
  await CartItem.create({ userId: member._id, coachId: coach._id, planId: plan._id, status: 'active' });

  const res = await myEnrollments();
  assert.equal(res.body.data.total, 0);

  // ... and once bought, the enrollment is what shows up.
  await seedEnrollment();
  assert.equal((await myEnrollments()).body.data.total, 1);
});

test('my coach is the coach on the active enrollment', async () => {
  await seedEnrollment({ enrollDate: days(-400), startDate: days(-399), endDate: days(-310) }); // ended
  await seedEnrollment({ coachId: secondCoach._id, enrollDate: days(-5), startDate: days(-4), endDate: days(85) }); // running

  const res = await myCoach();
  assert.equal(res.status, 200);
  assert.equal(res.body.data.coach.user.name, 'Coach Anita');
  assert.equal(res.body.data.enrollment.plan.name, '12 WEEKS GOGETFIT PLAN');
});

test('when the last plan has ended there is no current coach', async () => {
  await seedEnrollment({ enrollDate: days(-400), startDate: days(-399), endDate: days(-310) });

  const res = await myCoach();
  assert.equal(res.status, 200);
  assert.equal(res.body.data.coach, null);
  assert.equal(res.body.data.enrollment, null);
});

test('one member can never read another member\'s enrollments or coach', async () => {
  await seedEnrollment();

  // The other member sees their own (empty) history, whatever they send.
  assert.equal((await myEnrollments(otherToken)).body.data.total, 0);
  assert.equal((await myCoach(otherToken)).body.data.coach, null);

  // There is no userId parameter to abuse: supplying one changes nothing.
  const spoofed = await server.request('GET', `/api/users/me/enrollments?userId=${member._id}`, { token: otherToken });
  assert.equal(spoofed.body.data.total, 0);
});

test('the member payload carries no other member\'s details', async () => {
  await seedEnrollment();
  const [enrollment] = (await myEnrollments()).body.data.enrollments;

  // The admin list joins the buyer and the coupon; the member view must not.
  assert.equal(enrollment.client, undefined);
  assert.equal(enrollment.user, undefined);
  assert.equal(enrollment.legacy, undefined);
  assert.equal(enrollment.createdBy, undefined);
});
