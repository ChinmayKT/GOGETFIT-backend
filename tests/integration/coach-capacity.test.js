import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import User from '../../src/models/user.model.js';
import Coach from '../../src/models/coach.model.js';
import CartItem from '../../src/models/cart-item.model.js';
import CoachMonthlyCapacity from '../../src/models/coach-monthly-capacity.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import { getCoachCapacity, memberAvailability } from '../../src/services/coach-capacity.service.js';
import { purchaseCartItem } from '../../src/services/cart.service.js';
import { createManualEnrollment } from '../../src/services/enrolled-client.service.js';
import { updateCoach } from '../../src/services/coach.service.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

const NOV_5 = new Date('2026-11-05T06:00:00.000Z');
const NOV_6 = new Date('2026-11-06T06:00:00.000Z');
const DEC_31 = new Date('2026-12-31T06:00:00.000Z');
const JAN_1 = new Date('2027-01-01T06:00:00.000Z');

let server;
let plan;
let phone = 917100000000;

const seedUser = (roles = ['user']) => {
  phone += 1;
  return User.create({ phone: { raw: String(phone), normalized: String(phone) }, profile: { name: `U${phone}` }, roles, status: 'active' });
};

const seedCoach = async (monthlySlots) => {
  const user = await seedUser(['user', 'coach']);
  return Coach.create({ userId: user._id, profile: { level: 'LEVEL 1', monthlySlots }, status: 'active' });
};

/** A member with [coach]'s plan in their cart: a booking about to happen. */
const seedCart = async (coach) => {
  const member = await seedUser();
  const item = await CartItem.create({ userId: member._id, coachId: coach._id, planId: plan._id, status: 'active', addedAt: new Date() });
  return { member, item };
};

const book = async (coach, at, reference = undefined) => {
  const { member, item } = await seedCart(coach);
  return purchaseCartItem(member._id, item._id, { paymentReference: reference ?? `ref_${item._id}`, at });
};

const bookMany = async (coach, count, at) => {
  for (let i = 0; i < count; i += 1) await book(coach, at);
};

const reload = (coach) => Coach.findById(coach._id).lean();
const availabilityOf = async (coach, at) => (await memberAvailability([await reload(coach)], at)).get(String(coach._id));

const fullyBooked = (error) => error?.code === 'COACH_FULLY_BOOKED' && error?.statusCode === 409;

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
});

test('batches follow confirmed bookings: 9, then 3, and 9 again the next day', async () => {
  const coach = await seedCoach(20);
  assert.equal((await availabilityOf(coach, NOV_5)).availableSlots, 9);

  await bookMany(coach, 6, NOV_5);
  assert.equal((await availabilityOf(coach, NOV_5)).availableSlots, 3);

  await bookMany(coach, 3, NOV_5);
  assert.equal((await availabilityOf(coach, NOV_5)).availableSlots, 3);

  await bookMany(coach, 6, NOV_5);
  // 15 of 20 sold: the next day opens at 5, not 9.
  assert.equal((await availabilityOf(coach, NOV_6)).availableSlots, 5);

  await bookMany(coach, 5, NOV_6);
  const full = await availabilityOf(coach, NOV_6);
  assert.deepEqual(full, { availableSlots: 0, slotStatus: 'fully_booked' });
  await assert.rejects(book(coach, NOV_6), fullyBooked);
  assert.equal(await EnrolledClient.countDocuments({ coachId: coach._id }), 20);
});

test('concurrent bookings cannot oversell the last slots', async () => {
  const coach = await seedCoach(3);
  const carts = await Promise.all(Array.from({ length: 12 }, () => seedCart(coach)));

  const results = await Promise.allSettled(
    carts.map(({ member, item }) => purchaseCartItem(member._id, item._id, { paymentReference: `ref_${item._id}`, at: NOV_5 })),
  );

  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 3);
  assert.ok(lost.every((r) => fullyBooked(r.reason)), 'every loser is told the coach is full');
  assert.equal(await EnrolledClient.countDocuments({ coachId: coach._id }), 3);
  // A refused member keeps their cart item.
  assert.equal(await CartItem.countDocuments({ coachId: coach._id, status: 'active' }), 9);
});

test('a repeated payment reference consumes one slot, concurrently or later', async () => {
  const coach = await seedCoach(5);
  const { member, item } = await seedCart(coach);
  const input = { paymentReference: 'gateway_1', at: NOV_5 };

  const results = await Promise.allSettled([
    purchaseCartItem(member._id, item._id, input),
    purchaseCartItem(member._id, item._id, input),
  ]);
  assert.ok(results.some((r) => r.status === 'fulfilled'));

  const retry = await purchaseCartItem(member._id, item._id, input);
  assert.equal(retry.idempotent, true);
  assert.equal(await EnrolledClient.countDocuments({ coachId: coach._id }), 1);
});

test('a purchase that fails consumes nothing', async () => {
  const coach = await seedCoach(1);
  const { member, item } = await seedCart(coach);
  await assert.rejects(
    purchaseCartItem(member._id, item._id, { paymentReference: 'ref', couponCode: 'NOPE', at: NOV_5 }),
    (error) => error?.code === 'COUPON_NOT_FOUND',
  );
  assert.equal((await availabilityOf(coach, NOV_5)).availableSlots, 1);
});

test('a new month starts empty on the latest allocation; the old month stays as it was', async () => {
  const coach = await seedCoach(2);
  const admin = await seedUser(['user', 'admin']);
  await bookMany(coach, 2, DEC_31);
  assert.equal((await availabilityOf(coach, DEC_31)).slotStatus, 'fully_booked');

  await updateCoach(String(coach._id), { profile: { monthlySlots: 30 } }, admin._id);
  await CoachMonthlyCapacity.updateMany({}, { $set: { capacity: 2 } }); // Pin December: the edit ran "today".

  assert.equal((await availabilityOf(coach, JAN_1)).availableSlots, 9);
  await book(coach, JAN_1);

  const capacity = await getCoachCapacity(String(coach._id), JAN_1);
  assert.equal(capacity.month, '2027-01');
  assert.equal(capacity.confirmedBookings, 1);
  assert.equal(capacity.remainingCapacity, 29);
  const december = capacity.history.find((h) => h.month === '2026-12');
  assert.equal(december.capacity, 2);
  assert.equal(december.confirmedBookings, 2);
});

test('admin edits: raise reopens, cut below bookings stops sales and keeps every booking, audit recorded', async () => {
  const now = new Date();
  const coach = await seedCoach(2);
  const admin = await seedUser(['user', 'admin']);
  await bookMany(coach, 2, now);
  await assert.rejects(book(coach, now), fullyBooked);

  await updateCoach(String(coach._id), { profile: { monthlySlots: 5 } }, admin._id);
  assert.equal((await availabilityOf(coach, now)).availableSlots, 3);
  await book(coach, now);

  await updateCoach(String(coach._id), { profile: { monthlySlots: 1 } }, admin._id);
  await assert.rejects(book(coach, now), fullyBooked);
  assert.equal(await EnrolledClient.countDocuments({ coachId: coach._id, isDeleted: false }), 3);

  const capacity = await getCoachCapacity(String(coach._id), now);
  assert.equal(capacity.status, 'fully_booked');
  assert.equal(capacity.remainingCapacity, 0);
  assert.deepEqual(capacity.history[0].changes.map((c) => [c.from, c.to, c.by]), [
    [2, 5, String(admin._id)],
    [5, 1, String(admin._id)],
  ]);

  await updateCoach(String(coach._id), { profile: { monthlySlots: 4 } }, admin._id);
  assert.equal((await getCoachCapacity(String(coach._id), now)).remainingCapacity, 1);
});

test('a coach with no allocation keeps selling, as before this feature', async () => {
  const coach = await seedCoach(null);
  await bookMany(coach, 2, NOV_5);
  assert.deepEqual(await availabilityOf(coach, NOV_5), { availableSlots: 0, slotStatus: 'not_configured' });
  assert.equal(await CoachMonthlyCapacity.countDocuments({ coachId: coach._id }), 0);
});

test('an unlimited coach given an allocation starts the 9, 3, 3 release from then on', async () => {
  const now = new Date();
  const coach = await seedCoach(null);
  const admin = await seedUser(['user', 'admin']);
  await bookMany(coach, 2, now);

  await updateCoach(String(coach._id), { profile: { monthlySlots: 20 } }, admin._id);
  // The bookings already taken this month count against the new allocation.
  assert.deepEqual(await availabilityOf(coach, now), { availableSlots: 7, slotStatus: 'available' });
  const capacity = await getCoachCapacity(String(coach._id), now);
  assert.equal(capacity.remainingCapacity, 18);
  assert.deepEqual(capacity.history[0].changes.map((c) => [c.from, c.to]), [[null, 20]]);
});

const manualInput = (coach, member, enrollDate) => ({
  userId: member._id, planId: plan._id, coachId: coach._id, couponId: null, enrollDate, startDate: null, endDate: null,
  payment: { method: 'cash', amount: 4999, paidAt: enrollDate, referenceId: null, notes: null },
});

test('a manual enrollment consumes a slot and is refused when full, until capacity is raised', async () => {
  const now = new Date();
  const coach = await seedCoach(1);
  const admin = await seedUser(['user', 'admin']);
  const member = await seedUser();

  await createManualEnrollment(manualInput(coach, member, now), admin._id, now);
  assert.equal((await availabilityOf(coach, now)).slotStatus, 'fully_booked');
  await assert.rejects(createManualEnrollment(manualInput(coach, member, now), admin._id, now), (error) =>
    fullyBooked(error) && /Increase the coach's Monthly Slots/.test(error.message));
  assert.equal(await EnrolledClient.countDocuments({ coachId: coach._id }), 1);

  await updateCoach(String(coach._id), { profile: { monthlySlots: 2 } }, admin._id);
  await createManualEnrollment(manualInput(coach, member, now), admin._id, now);
  assert.equal(await EnrolledClient.countDocuments({ coachId: coach._id }), 2);
  assert.equal((await availabilityOf(coach, now)).slotStatus, 'fully_booked');
});

test('a backdated manual enrollment uses the current month and keeps its real dates', async () => {
  const coach = await seedCoach(50);
  const admin = await seedUser(['user', 'admin']);
  const member = await seedUser();
  const october = new Date('2026-10-20T00:00:00.000Z');

  const { enrolledClient } = await createManualEnrollment(manualInput(coach, member, october), admin._id, NOV_5);

  const stored = await EnrolledClient.findById(enrolledClient.id).lean();
  assert.equal(stored.capacityAccountingMonth, '2026-11');
  assert.equal(stored.enrollDate.toISOString(), october.toISOString());
  assert.equal(stored.payment.paidAt.toISOString(), october.toISOString());

  const november = await getCoachCapacity(String(coach._id), NOV_5);
  assert.equal(november.confirmedBookings, 1);
  assert.equal(november.remainingCapacity, 49);
  // It used a monthly slot but was not sold from today's batch.
  assert.equal(november.bookedToday, 0);
  assert.equal(november.availableSlots, 9);
  assert.deepEqual(november.history.map((h) => [h.month, h.confirmedBookings]), [['2026-11', 1]]);
  assert.equal((await getCoachCapacity(String(coach._id), october)).confirmedBookings, 0);
});

test('a backdated manual enrollment is refused when this month is full, until capacity is raised', async () => {
  const now = new Date();
  const coach = await seedCoach(1);
  const admin = await seedUser(['user', 'admin']);
  const member = await seedUser();
  const lastYear = new Date(now.getTime() - 400 * 86_400_000);

  await book(coach, now);
  await assert.rejects(createManualEnrollment(manualInput(coach, member, lastYear), admin._id, now), fullyBooked);

  await updateCoach(String(coach._id), { profile: { monthlySlots: 2 } }, admin._id);
  await createManualEnrollment(manualInput(coach, member, lastYear), admin._id, now);
  assert.equal((await availabilityOf(coach, now)).slotStatus, 'fully_booked');
});

test('every new booking stores its month, also for an unlimited coach and across a new year', async () => {
  const limited = await seedCoach(5);
  const unlimited = await seedCoach(null);
  await book(limited, DEC_31);
  await book(unlimited, JAN_1);

  const monthOf = async (coach) => (await EnrolledClient.findOne({ coachId: coach._id }).lean()).capacityAccountingMonth;
  assert.equal(await monthOf(limited), '2026-12');
  assert.equal(await monthOf(unlimited), '2027-01');
  assert.equal((await availabilityOf(limited, DEC_31)).availableSlots, 4);
  assert.equal((await availabilityOf(limited, JAN_1)).availableSlots, 5);
});

test('older enrollments count by their enroll date and are never rewritten', async () => {
  const coach = await seedCoach(5);
  const member = await seedUser();
  const old = (enrollDate) => ({ userId: member._id, planId: plan._id, coachId: coach._id, enrollDate });
  const [inNovember, inOctober] = await EnrolledClient.create([
    old(new Date('2026-11-02T00:00:00.000Z')),
    old(new Date('2026-10-02T00:00:00.000Z')),
  ]);
  await EnrolledClient.collection.insertOne({ userId: member._id, planId: plan._id, coachId: coach._id, enrollDate: null });

  await book(coach, NOV_5);

  assert.equal((await getCoachCapacity(String(coach._id), NOV_5)).confirmedBookings, 2);
  assert.equal((await getCoachCapacity(String(coach._id), new Date('2026-10-02T06:00:00.000Z'))).confirmedBookings, 1);

  // The old rows are not touched.
  for (const doc of [inNovember, inOctober]) {
    const stored = await EnrolledClient.findById(doc._id).lean();
    assert.equal('capacityAccountingMonth' in stored, false);
    assert.equal(stored.updatedAt.toISOString(), doc.updatedAt.toISOString());
  }
});

test('concurrent backdated manual enrollments cannot oversell this month', async () => {
  const coach = await seedCoach(2);
  const admin = await seedUser(['user', 'admin']);
  const member = await seedUser();
  const october = new Date('2026-10-20T00:00:00.000Z');

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => createManualEnrollment(manualInput(coach, member, october), admin._id, NOV_5)),
  );

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => fullyBooked(r.reason)));
  assert.equal(await EnrolledClient.countDocuments({ coachId: coach._id, capacityAccountingMonth: '2026-11' }), 2);
});

test('manual and customer bookings racing for the last slots cannot oversell', async () => {
  const now = new Date();
  const coach = await seedCoach(2);
  const admin = await seedUser(['user', 'admin']);
  const member = await seedUser();
  const carts = await Promise.all(Array.from({ length: 4 }, () => seedCart(coach)));

  const results = await Promise.allSettled([
    ...Array.from({ length: 4 }, () => createManualEnrollment(manualInput(coach, member, now), admin._id, now)),
    ...carts.map((cart) => purchaseCartItem(cart.member._id, cart.item._id, { paymentReference: `ref_${cart.item._id}`, at: now })),
  ]);

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => fullyBooked(r.reason)));
  assert.equal(await EnrolledClient.countDocuments({ coachId: coach._id }), 2);
});

test('a manual enrollment for an unlimited coach is never refused', async () => {
  const now = new Date();
  const coach = await seedCoach(null);
  const admin = await seedUser(['user', 'admin']);
  const member = await seedUser();
  await createManualEnrollment(manualInput(coach, member, now), admin._id, now);
  await createManualEnrollment(manualInput(coach, member, now), admin._id, now);
  assert.equal(await EnrolledClient.countDocuments({ coachId: coach._id }), 2);
});

test('a fully booked coach cannot be added to a cart or quoted; the admin API returns the summary', async () => {
  const coach = await seedCoach(0);
  const { member } = await seedCart(await seedCoach(5));
  const memberToken = jwt.sign({ sub: String(member._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const added = await server.request('POST', '/api/users/me/cart', { token: memberToken, body: { coachId: String(coach._id), planId: String(plan._id) } });
  assert.equal(added.status, 409);
  assert.equal(added.body.error?.code ?? added.body.code, 'COACH_FULLY_BOOKED');

  const listed = await server.request('GET', `/api/coaches/${coach._id}`, { token: memberToken });
  assert.equal(listed.body.data.coach.profile.slotStatus, 'fully_booked');
  assert.equal('monthlySlots' in listed.body.data.coach.profile, false);

  const admin = await seedUser(['user', 'admin']);
  const adminToken = jwt.sign({ sub: String(admin._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const summary = await server.request('GET', `/api/admin/coaches/${coach._id}/capacity`, { token: adminToken });
  assert.equal(summary.status, 200);
  assert.equal(summary.body.data.capacity.monthlyCapacity, 0);
  assert.equal(summary.body.data.capacity.firstBatchSize, 9);
  const forbidden = await server.request('GET', `/api/admin/coaches/${coach._id}/capacity`, { token: memberToken });
  assert.equal(forbidden.status, 403);
});

test('month and day change at midnight in the business timezone, not UTC', async () => {
  const coach = await seedCoach(5);
  // 18:29 UTC is 23:59 IST; 18:31 UTC is 00:01 the next day IST.
  await book(coach, new Date('2026-11-30T18:29:00.000Z'));
  await book(coach, new Date('2026-11-30T18:31:00.000Z'));

  const months = (await EnrolledClient.find({ coachId: coach._id }).sort({ enrollDate: 1 }).lean()).map((d) => d.capacityAccountingMonth);
  assert.deepEqual(months, ['2026-11', '2026-12']);

  const december = await getCoachCapacity(String(coach._id), new Date('2026-11-30T18:40:00.000Z'));
  assert.equal(december.date, '2026-12-01');
  assert.equal(december.confirmedBookings, 1);
  assert.equal(december.bookedToday, 1);
});

test('the whole flow over HTTP, as the portal and the app call it', async () => {
  const token = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const admin = await seedUser(['user', 'admin']);
  const adminToken = token(admin);
  const coachUser = await seedUser();
  const member = await seedUser();
  const memberToken = token(member);

  // A new coach cannot be created without capacity.
  const refused = await server.request('POST', '/api/admin/coaches', { token: adminToken, body: { userId: String(coachUser._id), profile: { level: 'LEVEL 1' } } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error.message, /monthlySlots/);

  const created = await server.request('POST', '/api/admin/coaches', { token: adminToken, body: { userId: String(coachUser._id), profile: { level: 'LEVEL 1', monthlySlots: 2 } } });
  assert.equal(created.status, 201);
  const coachId = created.body.data.coach.id;
  const capacity = async () => (await server.request('GET', `/api/admin/coaches/${coachId}/capacity`, { token: adminToken })).body.data.capacity;
  assert.equal((await capacity()).history.length, 1);

  // A backdated cash enrollment, through the real validator: this month's slot, its own date.
  const manual = await server.request('POST', '/api/admin/enrolled-clients', {
    token: adminToken,
    body: {
      userId: String(member._id), planId: String(plan._id), coachId, enrollDate: '2025-03-10',
      payment: { method: 'cash', amount: 4999, paymentDate: '2025-03-10' },
    },
  });
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
  const stored = await EnrolledClient.findOne({ coachId }).lean();
  assert.equal(stored.enrollDate.toISOString(), '2025-03-09T18:30:00.000Z');
  assert.equal(stored.capacityAccountingMonth, (await capacity()).month);
  const afterManual = await capacity();
  assert.equal(afterManual.confirmedBookings, 1);
  assert.equal(afterManual.bookedToday, 0);
  assert.equal(afterManual.availableSlots, 1);
  assert.equal(afterManual.history[0].confirmedBookings, 1);

  // A customer takes the last slot through the cart.
  const seen = await server.request('GET', `/api/coaches/${coachId}`, { token: memberToken });
  assert.equal(seen.body.data.coach.profile.availableSlots, 1);
  const added = await server.request('POST', '/api/users/me/cart', { token: memberToken, body: { coachId, planId: String(plan._id) } });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const bought = await server.request('POST', `/api/users/me/cart/${added.body.data.item.id}/purchase`, { token: memberToken, body: { paymentReference: 'ref_http' } });
  assert.ok(bought.status < 300, JSON.stringify(bought.body));

  const full = await server.request('GET', `/api/coaches/${coachId}`, { token: memberToken });
  assert.deepEqual([full.body.data.coach.profile.availableSlots, full.body.data.coach.profile.slotStatus], [0, 'fully_booked']);

  // Full: the admin is told how to get out of it, and raising capacity does.
  const manualBody = {
    userId: String(member._id), planId: String(plan._id), coachId, enrollDate: '2025-03-11',
    payment: { method: 'cash', amount: 4999, paymentDate: '2025-03-11' },
  };
  const blocked = await server.request('POST', '/api/admin/enrolled-clients', { token: adminToken, body: manualBody });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error.message, /Increase the coach's Monthly Slots/);

  const raised = await server.request('PATCH', `/api/admin/coaches/${coachId}`, { token: adminToken, body: { profile: { monthlySlots: 3 } } });
  assert.equal(raised.status, 200);
  assert.equal((await server.request('POST', '/api/admin/enrolled-clients', { token: adminToken, body: manualBody })).status, 201);

  // Lowered below what is booked: nothing is lost, new sales stop.
  await server.request('PATCH', `/api/admin/coaches/${coachId}`, { token: adminToken, body: { profile: { monthlySlots: 1 } } });
  const lowered = await capacity();
  assert.deepEqual([lowered.confirmedBookings, lowered.remainingCapacity, lowered.status], [3, 0, 'fully_booked']);
  assert.equal(await EnrolledClient.countDocuments({ coachId, isDeleted: false }), 3);
});
