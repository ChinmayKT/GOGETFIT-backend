import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import CartItem from '../../src/models/cart-item.model.js';
import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { purchaseCartItem } from '../../src/services/cart.service.js';
import { getCoachCapacity } from '../../src/services/coach-capacity.service.js';
import { createManualEnrollment } from '../../src/services/enrolled-client.service.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

const NOV_5 = new Date('2026-11-05T06:00:00.000Z');

let server;
let plan;
let admin;
let viewerToken;
let phone = 917200000000;

const seedUser = (roles = ['user']) => {
  phone += 1;
  return User.create({ phone: { raw: String(phone), normalized: String(phone) }, profile: { name: `U${phone}` }, roles, status: 'active' });
};

const seedCoach = async (monthlySlots = 50) => {
  const user = await seedUser(['user', 'coach']);
  return Coach.create({ userId: user._id, profile: { level: 'LEVEL 1', monthlySlots }, status: 'active' });
};

const cart = (member, coach) =>
  CartItem.create({ userId: member._id, coachId: coach._id, planId: plan._id, status: 'active', addedAt: new Date() });

const purchase = async (member, coach) => {
  const item = await cart(member, coach);
  return purchaseCartItem(member._id, item._id, { paymentReference: `ref_${item._id}`, at: NOV_5 });
};

const manual = (member, coach) =>
  createManualEnrollment(
    {
      userId: member._id, planId: plan._id, coachId: coach._id, couponId: null, enrollDate: NOV_5, startDate: null, endDate: null,
      payment: { method: 'cash', amount: 4999, paidAt: NOV_5, referenceId: null, notes: null },
    },
    admin._id,
    NOV_5,
  );

/** A row written directly, for the states the purchase flow itself never leaves behind. */
const seedEnrollment = (member, coach, fields) =>
  EnrolledClient.create({
    userId: member._id, planId: plan._id, coachId: coach._id, enrollDate: NOV_5,
    payment: { transactionId: `tx_${member._id}_${Math.random()}`, status: 'Success' },
    ...fields,
  });

/** What the app actually receives, from the listing and the single-coach read. */
const countOf = async (coach) => {
  const list = await server.request('GET', '/api/coaches?pageSize=100', { token: viewerToken });
  assert.equal(list.status, 200);
  const row = list.body.data.coaches.find((c) => c.id === String(coach._id));
  const detail = await server.request('GET', `/api/coaches/${coach._id}`, { token: viewerToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.coach.profile.clientsCoachedCount, row.profile.clientsCoachedCount);
  return row.profile.clientsCoachedCount;
};

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});
after(async () => {
  await server.close();
  await clearTestDb();
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearTestDb();
  plan = await GogetfitPlan.create({
    name: '12 WEEKS', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1,
    pricing: { basePrice: 4999, reward: null }, status: 'active',
  });
  admin = await seedUser(['user', 'admin']);
  viewerToken = jwt.sign({ sub: String(admin._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
});

test('a coach with no clients returns 0, not null', async () => {
  assert.equal(await countOf(await seedCoach()), 0);
});

test('first purchase counts; a second plan or renewal by that client does not', async () => {
  const coach = await seedCoach();
  const client = await seedUser();

  await purchase(client, coach);
  assert.equal(await countOf(coach), 1);

  await purchase(client, coach);
  await purchase(client, coach);
  assert.equal(await countOf(coach), 1);
  assert.equal(await EnrolledClient.countDocuments({ coachId: coach._id }), 3);
});

test('a different client counts, and one client counts once for each coach', async () => {
  const coachA = await seedCoach();
  const coachB = await seedCoach();
  const shared = await seedUser();

  await purchase(shared, coachA);
  await purchase(await seedUser(), coachA);
  await purchase(shared, coachB);

  assert.equal(await countOf(coachA), 2);
  assert.equal(await countOf(coachB), 1);
});

test('a cart item, a refused purchase and a failed payment do not count', async () => {
  const coach = await seedCoach(1);
  await cart(await seedUser(), coach);
  assert.equal(await countOf(coach), 0);

  await purchase(await seedUser(), coach);
  assert.equal(await countOf(coach), 1);

  // The coach is now full: this purchase is refused and leaves no enrollment.
  const refused = await seedUser();
  await assert.rejects(purchase(refused, coach), (error) => error?.code === 'COACH_FULLY_BOOKED');
  assert.equal(await countOf(coach), 1);

  await seedEnrollment(await seedUser(), coach, { payment: { transactionId: 'tx_failed', status: 'Failed' } });
  await seedEnrollment(await seedUser(), coach, { payment: { transactionId: 'tx_incomplete', status: null } });
  assert.equal(await countOf(coach), 1);
});

test('a client whose only enrollment is deleted is not counted; a live one still is', async () => {
  const coach = await seedCoach();
  const onlyDeleted = await seedUser();
  const mixed = await seedUser();

  await seedEnrollment(onlyDeleted, coach, { isDeleted: true });
  await seedEnrollment(mixed, coach, { isDeleted: true });
  await seedEnrollment(mixed, coach, {});

  assert.equal(await countOf(coach), 1);
});

test('an admin manual enrollment counts a new client and not an already-counted one', async () => {
  const coach = await seedCoach();
  const client = await seedUser();

  await manual(client, coach);
  assert.equal(await countOf(coach), 1);

  await manual(client, coach);
  assert.equal(await countOf(coach), 1);

  const fromApp = await seedUser();
  await purchase(fromApp, coach);
  await manual(fromApp, coach);
  assert.equal(await countOf(coach), 2);
});

test('concurrent enrollments by one client cannot inflate the count', async () => {
  const coach = await seedCoach();
  const client = await seedUser();
  const item = await cart(client, coach);

  const results = await Promise.allSettled([
    purchaseCartItem(client._id, item._id, { paymentReference: `ref_${item._id}`, at: NOV_5 }),
    ...Array.from({ length: 4 }, () => manual(client, coach)),
  ]);

  const created = await EnrolledClient.countDocuments({ coachId: coach._id });
  assert.equal(created, results.filter((r) => r.status === 'fulfilled').length);
  assert.ok(created > 1, 'several enrollments were really created at once');
  assert.equal(await countOf(coach), 1);
});

test('every confirmed enrollment still consumes a slot, however the distinct count moves', async () => {
  const coach = await seedCoach(3);
  const client = await seedUser();

  await purchase(client, coach);
  await purchase(client, coach);
  await purchase(await seedUser(), coach);

  const capacity = await getCoachCapacity(String(coach._id), NOV_5);
  assert.equal(capacity.confirmedBookings, 3);
  assert.equal(capacity.remainingCapacity, 0);
  assert.equal(capacity.status, 'fully_booked');
  assert.equal(await countOf(coach), 2);
});
