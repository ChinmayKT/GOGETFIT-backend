import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import Coupon from '../../src/models/coupon.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { priceAfterCoupon } from '../../src/services/enrolled-client.service.js';
import { setNow } from '../../src/utils/clock.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/** "Now" is pinned: 1 Oct 2026, 10:00 in India (04:30Z). */
const NOW = new Date('2026-10-01T04:30:00.000Z');
/** A calendar day as stored for enrollments: midnight in India. */
const istDay = (day) => new Date(new Date(`${day}T00:00:00.000Z`).getTime() - 5.5 * 3600 * 1000).toISOString();

let server;
let admin;
let adminToken;
let memberToken;
let coachToken;
let member;
let plan;
let coach;
const coupons = {};

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (overrides = {}) => {
  seq += 1;
  const phone = `9170000${String(seq).padStart(5, '0')}`;
  return User.create({
    phone: { raw: phone, normalized: phone },
    profile: { name: overrides.name ?? `User ${seq}`, email: overrides.email ?? `user${seq}@example.com` },
    roles: overrides.roles ?? ['user'],
    status: overrides.status ?? 'active',
  });
};
const seedPlan = (overrides = {}) =>
  GogetfitPlan.create({
    name: overrides.name ?? '12 WEEKS GOGETFIT PLAN',
    planType: 'Enrollment',
    coachLevel: overrides.coachLevel ?? 'LEVEL 1',
    durationWeeks: 12,
    personsAllowed: 1,
    pricing: { basePrice: overrides.basePrice ?? 4999, reward: 0 },
    status: overrides.status ?? 'active',
  });
const seedCoach = async (overrides = {}) => {
  const user = await seedUser({ name: overrides.name ?? 'Coach Siri', roles: ['user', 'coach'], status: overrides.userStatus ?? 'active' });
  return Coach.create({ userId: user._id, profile: { level: overrides.level ?? 'LEVEL 1' }, status: overrides.status ?? 'active' });
};
const seedCoupon = (code, value, visibility, validFrom, validTo) =>
  Coupon.create({ code, discount: { type: 'percent', value }, visibility, validFrom: new Date(`${validFrom}T00:00:00Z`), validTo: new Date(`${validTo}T00:00:00Z`) });

const body = (overrides = {}, payment = {}) => ({
  userId: String(member._id),
  planId: String(plan._id),
  coachId: String(coach._id),
  enrollDate: '2026-10-01',
  startDate: '2026-10-02',
  endDate: '2026-12-24',
  couponId: null,
  ...overrides,
  payment: { method: 'cash', amount: 4999, paymentDate: '2026-10-01', referenceId: null, notes: null, ...payment },
});
const create = (b = body(), token = adminToken) => server.request('POST', '/api/admin/enrolled-clients', { token, body: b });
const stored = (id) => EnrolledClient.findById(id).lean();

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  setNow(NOW);
  await clearTestDb();
  admin = await seedUser({ name: 'Asha Admin', roles: ['user', 'admin'] });
  adminToken = tokenFor(admin);
  member = await seedUser({ name: 'Rahul Sharma', email: 'rahul@gmail.com' });
  memberToken = tokenFor(member);
  plan = await seedPlan();
  coach = await seedCoach();
  coachToken = tokenFor(await User.findById(coach.userId));
  coupons.public10 = await seedCoupon('WELCOME10', 10, 'public', '2026-09-01', '2026-10-31');
  coupons.private20 = await seedCoupon('VIP20', 20, 'private', '2026-09-01', '2026-10-01'); // last day today
  coupons.expired = await seedCoupon('OLD30', 30, 'public', '2026-08-01', '2026-09-30');
  coupons.future = await seedCoupon('SOON40', 40, 'private', '2026-10-02', '2026-12-31');
});

afterEach(() => setNow(null));

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// --- creation --------------------------------------------------------------------------

test('1, 22, 26, 27, 29. an admin records a cash enrollment in the existing enrolledclients collection', async () => {
  const res = await create(body({}, { notes: 'Cash collected at the studio', referenceId: 'RCPT-1' }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { enrolledClient, pricing } = res.body.data;

  const doc = await stored(enrolledClient.id);
  assert.equal(mongoose.connection.collection('enrolledclients').collectionName, EnrolledClient.collection.collectionName);
  assert.equal(await mongoose.connection.db.collection('enrolledclients').countDocuments({ _id: doc._id }), 1);
  assert.equal(String(doc.userId), String(member._id));
  assert.equal(String(doc.planId), String(plan._id));
  assert.equal(String(doc.coachId), String(coach._id));
  assert.equal(doc.couponId, null);
  assert.equal(doc.source, 'admin_manual');
  assert.equal(doc.legacy, undefined); // not migration data
  assert.equal('status' in doc, false); // no persisted enrollment status

  // The payment: manual, no invented gateway id, the existing fields reused.
  assert.equal(doc.payment.transactionId, undefined);
  assert.equal(doc.payment.method, 'cash');
  assert.equal(doc.payment.amount, 4999);
  assert.equal(doc.payment.originalAmount, 4999);
  assert.equal(doc.payment.discountPercent, 0);
  assert.equal(doc.payment.currency, 'INR');
  assert.equal(doc.payment.status, 'Success');
  assert.equal(doc.payment.referenceId, 'RCPT-1');
  assert.equal(doc.payment.notes, 'Cash collected at the studio');
  assert.equal(doc.payment.description, 'Manual enrollment created by admin');
  assert.equal(doc.payment.paidAt.toISOString(), istDay('2026-10-01'));
  // Billing snapshot from the user at enrollment time.
  assert.equal(doc.payment.customerName, 'Rahul Sharma');
  assert.equal(doc.payment.contact, member.phone.normalized);
  assert.equal(doc.payment.email, 'rahul@gmail.com');

  // Dates are India calendar days, stored like every migrated enrollment.
  assert.equal(doc.enrollDate.toISOString(), istDay('2026-10-01'));
  assert.equal(doc.startDate.toISOString(), istDay('2026-10-02'));
  assert.equal(doc.endDate.toISOString(), istDay('2026-12-24'));
  assert.equal(doc.hasStarted, true);

  // Response carries what the success screen and Client Details need.
  assert.equal(enrolledClient.client.id, String(member._id));
  assert.equal(enrolledClient.plan.id, String(plan._id));
  assert.equal(enrolledClient.coach.id, String(coach._id));
  assert.equal(enrolledClient.source, 'admin_manual');
  assert.equal(enrolledClient.createdBy, String(admin._id));
  assert.equal(enrolledClient.payment.method, 'cash');
  assert.equal(enrolledClient.status, 'active');
  assert.deepEqual(pricing, { originalAmount: 4999, discountPercent: 0, discountAmount: 0, finalAmount: 4999, amountReceived: 4999, difference: 0 });
});

test('2. only admins: members, coaches and anonymous callers are refused and nothing is written', async () => {
  assert.equal((await create(body(), memberToken)).status, 403);
  assert.equal((await create(body(), coachToken)).status, 403);
  assert.equal((await server.request('POST', '/api/admin/enrolled-clients', { body: body() })).status, 401);
  assert.equal(await EnrolledClient.countDocuments(), 0);
});

test('3-5. unknown user, plan or coach is a 404; a missing id is a 400', async () => {
  const ghost = new mongoose.Types.ObjectId().toString();
  const cases = [
    [{ userId: ghost }, 404, 'USER_NOT_FOUND'],
    [{ planId: ghost }, 404, 'GOGETFIT_PLAN_NOT_FOUND'],
    [{ coachId: ghost }, 404, 'COACH_NOT_FOUND'],
    [{ userId: undefined }, 400, 'VALIDATION_ERROR'],
    [{ planId: 'nope' }, 400, 'VALIDATION_ERROR'],
  ];
  for (const [o, status, code] of cases) {
    const res = await create(body(o));
    assert.equal(res.status, status, JSON.stringify(o));
    assert.equal(res.body.error.code, code);
  }
  assert.equal(await EnrolledClient.countDocuments(), 0);
});

test('6-8. inactive user, archived plan, inactive coach (or coach account) are refused', async () => {
  const inactiveUser = await seedUser({ status: 'blocked' });
  const archived = await seedPlan({ status: 'archived' });
  const inactiveCoach = await seedCoach({ status: 'inactive' });
  const coachWithBlockedAccount = await seedCoach({ userStatus: 'inactive' });
  const cases = [
    [{ userId: String(inactiveUser._id) }, 'USER_INACTIVE'],
    [{ planId: String(archived._id) }, 'GOGETFIT_PLAN_INACTIVE'],
    [{ coachId: String(inactiveCoach._id) }, 'COACH_INACTIVE'],
    [{ coachId: String(coachWithBlockedAccount._id) }, 'COACH_INACTIVE'],
  ];
  for (const [o, code] of cases) {
    const res = await create(body(o));
    assert.equal(res.status, 400, code);
    assert.equal(res.body.error.code, code);
  }
  assert.equal(await EnrolledClient.countDocuments(), 0);
});

test('a coach can only be given plans of their own level (the existing coach-plans rule)', async () => {
  const level2Plan = await seedPlan({ coachLevel: 'LEVEL 2', name: 'LEVEL 2 PLAN' });
  const res = await create(body({ planId: String(level2Plan._id) }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'PLAN_NOT_OFFERED_BY_COACH');
});

// --- dates -----------------------------------------------------------------------------

test('9. enrollDate is required and must be a real calendar day', async () => {
  for (const enrollDate of [undefined, '', '2026-02-30', '01/10/2026', '2026-10-01T10:00:00Z']) {
    assert.equal((await create(body({ enrollDate }))).status, 400, String(enrollDate));
  }
  assert.equal(await EnrolledClient.countDocuments(), 0);
});

test('10-12. start and end dates are optional; hasStarted follows the start date', async () => {
  const none = await create(body({ startDate: null, endDate: null }));
  assert.equal(none.status, 201);
  let doc = await stored(none.body.data.enrolledClient.id);
  assert.equal(doc.startDate, null);
  assert.equal(doc.endDate, null);
  assert.equal(doc.hasStarted, false);
  assert.equal(none.body.data.enrolledClient.status, 'not_started');

  const omitted = body();
  delete omitted.startDate;
  delete omitted.endDate;
  assert.equal((await create(omitted)).status, 201);

  const startOnly = await create(body({ endDate: null }));
  assert.equal(startOnly.status, 201);
  doc = await stored(startOnly.body.data.enrolledClient.id);
  assert.equal(doc.startDate.toISOString(), istDay('2026-10-02'));
  assert.equal(doc.endDate, null);
  assert.equal(doc.hasStarted, true);

  const both = await create(body({ startDate: '2026-10-02', endDate: '2026-10-02' })); // same day is fine
  assert.equal(both.status, 201);
});

test('13. an end date before the start date is refused', async () => {
  const res = await create(body({ startDate: '2026-10-10', endDate: '2026-10-09' }));
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /endDate must be on or after startDate/);
  assert.equal(await EnrolledClient.countDocuments(), 0);
});

// --- coupons and pricing -----------------------------------------------------------------

test('14-16, 19, 34. no coupon, an active public coupon and an active private coupon all work; the server prices them', async () => {
  const none = await create();
  assert.equal(none.body.data.pricing.finalAmount, 4999);

  const pub = await create(body({ couponId: String(coupons.public10._id) }, { amount: 4500 }));
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  // The legacy rule: integer arithmetic truncates the discount (4999 * 10% = 499.9 -> 499).
  assert.deepEqual(pub.body.data.pricing, { originalAmount: 4999, discountPercent: 10, discountAmount: 499, finalAmount: 4500, amountReceived: 4500, difference: 0 });
  const pubDoc = await stored(pub.body.data.enrolledClient.id);
  assert.equal(String(pubDoc.couponId), String(coupons.public10._id));
  assert.equal(pubDoc.payment.originalAmount, 4999);
  assert.equal(pubDoc.payment.discountPercent, 10);
  assert.equal(pubDoc.payment.amount, 4500);
  // 34. The coupon relationship resolves on read.
  assert.deepEqual(pub.body.data.enrolledClient.coupon, { id: String(coupons.public10._id), code: 'WELCOME10' });

  // Private is fine for an explicit admin choice; today is its last valid day.
  const priv = await create(body({ couponId: String(coupons.private20._id) }, { amount: 4000 }));
  assert.equal(priv.status, 201, JSON.stringify(priv.body));
  assert.equal(priv.body.data.pricing.finalAmount, 4000); // 4999 * 20% = 999.8 -> 999
  assert.equal(priv.body.data.pricing.discountAmount, 999);
});

test('17-18. expired and not-yet-started coupons are refused; an unknown coupon is a 404', async () => {
  for (const c of [coupons.expired, coupons.future]) {
    const res = await create(body({ couponId: String(c._id) }));
    assert.equal(res.status, 400, c.code);
    assert.equal(res.body.error.code, 'COUPON_INACTIVE');
  }
  const ghost = await create(body({ couponId: new mongoose.Types.ObjectId().toString() }));
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.error.code, 'COUPON_NOT_FOUND');
  assert.equal(await EnrolledClient.countDocuments(), 0);
});

test('20-21. the browser cannot supply the price, the discount, the status or audit fields', async () => {
  const sneaky = [
    body({}, { discountPercent: 90 }),
    body({}, { originalAmount: 1 }),
    body({}, { status: 'Success' }),
    body({}, { transactionId: 'pay_fake' }),
    { ...body(), planPrice: 1 },
    { ...body(), discountPercent: 90 },
    { ...body(), finalAmount: 1 },
    { ...body(), createdBy: String(member._id) },
    { ...body(), source: 'app' },
    { ...body(), hasStarted: false },
    { ...body(), status: 'active' },
  ];
  for (const b of sneaky) {
    const res = await create(b);
    assert.equal(res.status, 400, JSON.stringify(b));
  }
  assert.equal(await EnrolledClient.countDocuments(), 0);
  // And the price always comes from the plan: a coupon on a 4999 plan is priced from 4999.
  const res = await create(body({ couponId: String(coupons.public10._id) }, { amount: 100 }));
  assert.equal(res.body.data.pricing.originalAmount, 4999);
  assert.equal(res.body.data.pricing.finalAmount, 4500);
});

test('the amount received is recorded as received; the response reports the difference from the price due', async () => {
  const res = await create(body({}, { amount: 4000 }));
  assert.equal(res.status, 201);
  assert.equal(res.body.data.pricing.difference, -999);
  assert.equal((await stored(res.body.data.enrolledClient.id)).payment.amount, 4000);
  for (const amount of [-1, 10.5, '4999', null]) {
    assert.equal((await create(body({}, { amount }))).status, 400, String(amount));
  }
  // A 100% coupon legitimately makes it free.
  const free = await seedCoupon('FREE100', 100, 'private', '2026-09-01', '2026-10-31');
  const zero = await create(body({ couponId: String(free._id) }, { amount: 0 }));
  assert.equal(zero.status, 201);
  assert.equal(zero.body.data.pricing.finalAmount, 0);
});

// --- payment methods -------------------------------------------------------------------

test('22-25. cash, UPI, bank transfer and other; the reference is required for UPI and bank transfer only', async () => {
  assert.equal((await create(body({}, { method: 'cash', referenceId: null }))).status, 201);
  assert.equal((await create(body({}, { method: 'other', referenceId: null }))).status, 201);

  for (const method of ['upi', 'bank_transfer']) {
    const missing = await create(body({}, { method, referenceId: '  ' }));
    assert.equal(missing.status, 400, method);
    assert.match(missing.body.error.message, /referenceId is required/);
    const ok = await create(body({}, { method, referenceId: 'UTR123456789' }));
    assert.equal(ok.status, 201, method);
    const doc = await stored(ok.body.data.enrolledClient.id);
    assert.equal(doc.payment.method, method);
    assert.equal(doc.payment.referenceId, 'UTR123456789');
  }

  for (const method of ['card', 'upi_bank_transfer', '', undefined]) {
    assert.equal((await create(body({}, { method }))).status, 400, String(method));
  }
  assert.equal((await create(body({}, { paymentDate: undefined }))).status, 400);
  assert.equal((await create(body({}, { paymentDate: '2026-13-01' }))).status, 400);
});

// --- audit and side effects --------------------------------------------------------------

test('28, 30. createdBy is the authenticated admin; the user, coach, plan and coupon are not modified', async () => {
  const before = {
    user: await User.findById(member._id).lean(),
    coach: await Coach.findById(coach._id).lean(),
    plan: await GogetfitPlan.findById(plan._id).lean(),
    coupon: await Coupon.findById(coupons.public10._id).lean(),
  };
  const res = await create(body({ couponId: String(coupons.public10._id) }, { amount: 4500 }));
  const doc = await stored(res.body.data.enrolledClient.id);
  assert.equal(String(doc.createdBy), String(admin._id));
  assert.equal(String(doc.updatedBy), String(admin._id));

  // 30. No "client" role is added: the enrollment document is what makes a client.
  assert.deepEqual((await User.findById(member._id).lean()).roles, ['user']);
  assert.deepEqual(await User.findById(member._id).lean(), before.user);
  assert.deepEqual(await Coach.findById(coach._id).lean(), before.coach);
  assert.deepEqual(await GogetfitPlan.findById(plan._id).lean(), before.plan);
  assert.deepEqual(await Coupon.findById(coupons.public10._id).lean(), before.coupon);
});

test('31. existing (migrated) enrollments are left exactly as they were', async () => {
  const legacy = await EnrolledClient.create({
    userId: member._id,
    planId: plan._id,
    enrollDate: new Date('2023-07-19T18:30:00Z'),
    payment: { transactionId: 'pay_MFtqcm24BoGYlz', amount: 4999, currency: 'INR', originalAmount: 0, discountPercent: 0, status: 'Success' },
    legacy: { source: 'gogetfit', enrollmentId: 58, couponCode: 'GGFLAUNCH10' },
  });
  const before = await stored(legacy._id);
  assert.equal(before.source, undefined);
  assert.equal(before.payment.method, undefined);

  await create();
  await create(body({ couponId: String(coupons.public10._id) }, { amount: 4500 }));
  assert.deepEqual(await stored(legacy._id), before);

  // A gateway/migrated row still must have its transaction id.
  await assert.rejects(
    EnrolledClient.create({ userId: member._id, planId: plan._id, payment: { amount: 1 }, legacy: { source: 'gogetfit', enrollmentId: 59 } }),
    /transactionId/,
  );
});

// --- reading it back ---------------------------------------------------------------------

test('32-36. the new enrollment shows in Client Details and the Clients list, with plan, coach and coupon resolved', async () => {
  const res = await create(body({ couponId: String(coupons.private20._id) }, { method: 'upi', referenceId: 'UTR555', amount: 4000 }));
  const id = res.body.data.enrolledClient.id;

  const detail = (await server.request('GET', `/api/admin/enrolled-clients/${id}`, { token: adminToken })).body.data.enrolledClient;
  assert.equal(detail.plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.equal(detail.coach.name, 'Coach Siri');
  assert.equal(detail.coach.level, 'LEVEL 1'); // read from coach.profile.level
  assert.equal(detail.coach.profilePicture, null); // the coach's own photo; none uploaded here
  assert.equal(detail.coupon.code, 'VIP20');
  assert.equal(detail.payment.method, 'upi');
  assert.equal(detail.payment.referenceId, 'UTR555');
  assert.equal(detail.payment.originalAmount, 4999);
  assert.equal(detail.payment.discountPercent, 20);
  assert.equal(detail.source, 'admin_manual');

  // Client Details asks for the member's enrollments by userId.
  const forUser = await server.request('GET', `/api/admin/enrolled-clients?userId=${member._id}`, { token: adminToken });
  const row = forUser.body.data.enrolledClients[0];
  assert.equal(row.id, id);
  assert.equal(row.client.name, 'Rahul Sharma');
  assert.ok('profilePicture' in row.client); // the portal shows the member's photo
  assert.equal(row.paymentMethod, 'upi');
  assert.equal(row.paymentReference, 'UTR555');
  assert.equal(row.transactionId, null);

  // The list's filters and search still work with it.
  const list = async (qs) => (await server.request('GET', `/api/admin/enrolled-clients${qs}`, { token: adminToken })).body.data.enrolledClients.map((r) => r.id);
  assert.deepEqual(await list(''), [id]);
  assert.deepEqual(await list(`?coachId=${coach._id}`), [id]);
  assert.deepEqual(await list(`?planId=${plan._id}`), [id]);
  assert.deepEqual(await list(`?couponId=${coupons.private20._id}`), [id]);
  assert.deepEqual(await list('?status=active'), [id]);
  assert.deepEqual(await list('?hasStarted=true'), [id]);
  assert.deepEqual(await list('?search=UTR555'), [id]);
  assert.deepEqual(await list('?search=Rahul'), [id]);
});

// --- atomicity and repeats ----------------------------------------------------------------

test('37. a failure inside the transaction leaves nothing behind', async () => {
  const original = EnrolledClient.create;
  EnrolledClient.create = async function failingCreate(...args) {
    await original.apply(this, args); // the insert happens...
    throw new Error('simulated failure after insert'); // ...then the transaction fails
  };
  try {
    const res = await create();
    assert.equal(res.status, 500);
  } finally {
    EnrolledClient.create = original;
  }
  assert.equal(await EnrolledClient.countDocuments(), 0);
  assert.deepEqual((await User.findById(member._id).lean()).roles, ['user']);
});

test('38. repeat purchases of the same plan are allowed, as they always have been', async () => {
  assert.equal((await create()).status, 201);
  assert.equal((await create()).status, 201);
  assert.equal(await EnrolledClient.countDocuments({ userId: member._id, planId: plan._id }), 2);
});

test('priceAfterCoupon follows the legacy integer rule', () => {
  assert.deepEqual(priceAfterCoupon(4999, 10), { originalAmount: 4999, discountPercent: 10, discountAmount: 499, finalAmount: 4500 });
  assert.equal(priceAfterCoupon(12000, 10).finalAmount, 10800);
  assert.equal(priceAfterCoupon(4999, 0).finalAmount, 4999);
  assert.equal(priceAfterCoupon(4999, 100).finalAmount, 0);
});
