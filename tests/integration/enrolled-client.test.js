import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import Coupon from '../../src/models/coupon.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { buildMappings, loadEnrolledClients } from '../../migration/loaders/enrolled-client.loader.js';
import { provisionAdmin } from '../../src/services/admin-provisioning.service.js';
import { resetRateLimits } from '../../src/middleware/rate-limit.middleware.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  startTestServer,
} from '../helpers/test-server.js';

let server;
let adminToken;

const ADMIN_PHONE = '918123260930';
const ADMIN_EMAIL = 'prajwal@gogetfitonline.com';
const ADMIN_PASSWORD = 'bootstrap-pass-123';

// --- fixtures ---------------------------------------------------------------

const seedUser = (legacyUserId, overrides = {}) =>
  User.create({
    phone: {
      raw: overrides.phone ?? `9190000000${legacyUserId}`,
      normalized: overrides.phone ?? `9190000000${legacyUserId}`,
    },
    profile: { name: overrides.name ?? `Member ${legacyUserId}`, email: overrides.email ?? null },
    roles: overrides.roles ?? ['user'],
    status: 'active',
    ...(legacyUserId ? { legacy: { source: 'gogetfit', userId: legacyUserId } } : {}),
  });

const seedPlan = (packageId, overrides = {}) =>
  GogetfitPlan.create({
    name: overrides.name ?? `${packageId} WEEKS GOGETFIT PLAN`,
    planType: 'Enrollment',
    coachLevel: 'LEVEL 1',
    durationWeeks: overrides.durationWeeks ?? 12,
    personsAllowed: 1,
    pricing: { basePrice: 4999, reward: 0 },
    legacy: { source: 'gogetfit', packageId },
  });

const seedCoupon = (couponId, code) =>
  Coupon.create({
    code,
    name: `Coupon ${code}`,
    discount: { type: 'percent', value: 10 },
    visibility: 'public',
    validFrom: new Date('2023-01-01'),
    validTo: new Date('2030-01-01'),
    legacy: { source: 'gogetfit', couponId },
  });

const seedCoach = async (email) => {
  const user = await User.create({
    phone: { raw: '919900000777', normalized: '919900000777' },
    profile: { name: 'Coach Prajwal', email },
    roles: ['user', 'coach'],
    status: 'active',
  });
  return Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' } });
};

/** One joined legacy row, exactly as the extractor produces it. */
const legacyRow = (overrides = {}) => ({
  enrollment_id: 58,
  package_id: 15,
  coach_id: 13,
  user_id: 197,
  enroll_date: '2023-07-20 00:00:00',
  start_date: '2023-07-27 00:00:00',
  end_date: '2024-01-11 00:00:00',
  delete_flg: '0',
  created_by: '197',
  last_update_date: '2023-07-20 08:31:52',
  last_update_by: '197',
  start_flg: '1',
  transaction_id: 'pay_MFtqcm24BoGYlz',
  amount: '4999',
  currency: 'INR',
  p_transaction_id: 'pay_MFtqcm24BoGYlz',
  p_user_id: 197,
  p_payment_date: '2023-07-20 08:31:50',
  p_original_amount: 0,
  p_discount_percent: 0,
  p_coupon_code: '',
  p_amount: 4999,
  p_currency: 'INR',
  p_reference_id: null,
  p_description: null,
  p_customer_name: 'Test Member',
  p_contact: '+91-9986323357',
  p_email_id: 'member@example.com',
  p_status: 'Success',
  p_last_update_date: '2023-07-20 08:31:52',
  ...overrides,
});

const legacyCoupons = [
  { coupon_id: 3, coupon_code: 'GGFLAUNCH10' },
  // The real duplicate from m_coupon: one code, two coupons.
  { coupon_id: 4, coupon_code: 'GOGETFIT10' },
  { coupon_id: 10, coupon_code: 'GOGETFIT10' },
];

/** m_coach as the extractor returns it. Read on every run, not only when linking. */
const legacyCoaches = [
  { coach_id: 13, first_name: 'Prajwal', last_name: 'A T', email: 'coach13@gogetfitonline.com' },
  { coach_id: 17, first_name: 'Karthik ', last_name: 'M', email: 'karthik@gogetfitonline.com' },
];

const migrate = async (rows, options = {}) => {
  const mappings = await buildMappings({
    legacyCoupons,
    legacyCoaches: options.legacyCoaches ?? legacyCoaches,
    linkCoachesByEmail: options.linkCoachesByEmail ?? false,
  });
  return loadEnrolledClients(rows, { dryRun: false, runId: 'test-run', mappings, ...options });
};

const loginAsAdmin = async () => {
  await User.create({
    phone: { raw: ADMIN_PHONE, normalized: ADMIN_PHONE },
    profile: { name: 'Prajwal', email: ADMIN_EMAIL },
    roles: ['user'],
    status: 'active',
  });
  await provisionAdmin({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD, apply: true });
  const response = await server.request('POST', '/api/auth/admin/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  return response.body.data.token;
};

const tokenForRoles = async (roles, phone) => {
  const user = await User.create({
    phone: { raw: phone, normalized: phone },
    profile: { name: 'Someone' },
    roles,
    status: 'active',
  });
  return jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
};

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  resetRateLimits();
  adminToken = await loginAsAdmin();
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// =========================== RELATIONSHIPS =================================

test('1. an enrollment stores the member, plan and payment by reference', async () => {
  const user = await seedUser(197);
  const plan = await seedPlan(15);

  const summary = await migrate([legacyRow()]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(summary.created, 1);
  assert.equal(String(doc.userId), String(user._id));
  assert.equal(String(doc.planId), String(plan._id));
  assert.equal(doc.payment.transactionId, 'pay_MFtqcm24BoGYlz');
  assert.equal(doc.payment.amount, 4999);
  // References, not copies: no name, phone or plan name on the document.
  const raw = JSON.stringify(doc);
  assert.equal(raw.includes('Member 197'), false, 'no user name copied in');
  assert.equal(raw.includes('WEEKS GOGETFIT PLAN'), false, 'no plan name copied in');
});

test('2. the legacy identifiers are preserved alongside the references', async () => {
  await seedUser(197);
  await seedPlan(15);

  await migrate([legacyRow()]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(doc.legacy.source, 'gogetfit');
  assert.equal(doc.legacy.enrollmentId, 58);
  assert.equal(doc.legacy.userId, 197);
  assert.equal(doc.legacy.packageId, 15);
  assert.equal(doc.legacy.coachId, 13, 'the original coach id survives even unmapped');
  assert.equal(doc.legacy.enrollmentAmount, '4999');
  assert.equal(doc.legacy.createdBy, '197');
});

test('3. a missing member is reported and the row is not migrated', async () => {
  await seedPlan(15);

  const summary = await migrate([legacyRow({ user_id: 999 })]);

  assert.equal(summary.created, 0);
  assert.deepEqual(summary.conflicts.missingUser, [{ enrollmentId: 58, legacyUserId: 999 }]);
  assert.equal(await EnrolledClient.countDocuments({}), 0, 'no broken reference is written');
});

test('4. a missing plan is reported and the row is not migrated', async () => {
  await seedUser(197);

  const summary = await migrate([legacyRow({ package_id: 999 })]);

  assert.equal(summary.conflicts.missingPlan.length, 1);
  assert.equal(await EnrolledClient.countDocuments({}), 0);
});

test('5. an unmapped coach keeps the legacy id and is still migrated', async () => {
  await seedUser(197);
  await seedPlan(15);

  const summary = await migrate([legacyRow()]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  // Losing the enrollment would be worse than carrying it with a null coach.
  assert.equal(summary.created, 1);
  assert.equal(doc.coachId, null);
  assert.equal(doc.legacy.coachId, 13);
  assert.equal(doc.legacy.coachResolvedBy, null, 'nothing was inferred');
  assert.deepEqual(summary.conflicts.missingCoach, [{ enrollmentId: 58, legacyCoachId: 13 }]);
});

test('5b. the legacy coach name is preserved even when no Coach is linked', async () => {
  await seedUser(197);
  await seedPlan(15);

  await migrate([legacyRow({ coach_id: 17 })]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  // So a screen can say "Karthik M" rather than "coach 17".
  assert.equal(doc.coachId, null);
  assert.equal(doc.legacy.coachId, 17);
  assert.equal(doc.legacy.coachName, 'Karthik M', 'trimmed and joined from m_coach');
  assert.equal(doc.legacy.coachEmail, 'karthik@gogetfitonline.com');
});

test('5c. a legacy coach with no m_coach row keeps the id and no name', async () => {
  await seedUser(197);
  await seedPlan(15);

  await migrate([legacyRow({ coach_id: 99 })]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(doc.legacy.coachId, 99);
  assert.equal(doc.legacy.coachName, null, 'nothing is invented');
});

test('5d. a re-run backfills a coach name learned later', async () => {
  await seedUser(197);
  await seedPlan(15);

  // First run: m_coach was not read, so no name was stored.
  await migrate([legacyRow()], { legacyCoaches: [] });
  const before = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();
  assert.equal(before.legacy.coachName, null);

  const summary = await migrate([legacyRow()]);
  const after = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(summary.updated, 1, 'the new name counts as a change');
  assert.equal(after.legacy.coachName, 'Prajwal A T');
  assert.equal(await EnrolledClient.countDocuments({}), 1, 'still one document');
});

test('6. the opt-in email link resolves a coach and records how', async () => {
  await seedUser(197);
  await seedPlan(15);
  const coach = await seedCoach('coach13@gogetfitonline.com');

  const summary = await migrate([legacyRow()], {
    linkCoachesByEmail: true,
    legacyCoaches: [
      { coach_id: 13, first_name: 'Prajwal', last_name: 'A T', email: 'coach13@gogetfitonline.com' },
    ],
  });
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(String(doc.coachId), String(coach._id));
  assert.equal(doc.legacy.coachResolvedBy, 'email', 'an inference is marked as one');
  assert.equal(summary.conflicts.missingCoach.length, 0);
});

test('7. an ambiguous legacy coach email is never resolved', async () => {
  await seedUser(197);
  await seedPlan(15);
  await seedCoach('shared@gogetfitonline.com');

  // The legacy coach's email matches no new coach at all.
  const summary = await migrate([legacyRow()], {
    linkCoachesByEmail: true,
    legacyCoaches: [
      { coach_id: 13, first_name: 'Prajwal', last_name: 'A T', email: 'someone-else@gogetfitonline.com' },
    ],
  });
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(doc.coachId, null);
  assert.equal(summary.conflicts.missingCoach.length, 1);
});

// ============================== COUPONS ====================================

test('8. a unique legacy coupon code resolves to that coupon', async () => {
  await seedUser(197);
  await seedPlan(15);
  const coupon = await seedCoupon(3, 'GGFLAUNCH10');

  const summary = await migrate([legacyRow({ p_coupon_code: 'GGFLAUNCH10' })]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(String(doc.couponId), String(coupon._id));
  assert.equal(doc.legacy.couponCode, 'GGFLAUNCH10', 'the code as typed is kept too');
  assert.equal(doc.legacy.couponUnresolvedReason, null);
  assert.equal(summary.conflicts.ambiguousCoupon.length, 0);
});

test('9. a duplicated legacy coupon code is reported, never guessed', async () => {
  await seedUser(197);
  await seedPlan(15);
  // Both legacy coupons 4 and 10 carry the code GOGETFIT10.
  await seedCoupon(4, 'GOGETFIT10');
  await seedCoupon(10, 'GOGETFIT10-SUMMER');

  const summary = await migrate([legacyRow({ p_coupon_code: 'GOGETFIT10' })]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(doc.couponId, null, 'no coupon is picked');
  assert.equal(doc.legacy.couponCode, 'GOGETFIT10');
  assert.equal(doc.legacy.couponUnresolvedReason, 'ambiguous');
  assert.deepEqual(summary.conflicts.ambiguousCoupon, [
    { enrollmentId: 58, couponCode: 'GOGETFIT10' },
  ]);
});

test('10. an unknown coupon code is reported and preserved', async () => {
  await seedUser(197);
  await seedPlan(15);

  const summary = await migrate([legacyRow({ p_coupon_code: 'NEVEREXISTED' })]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(doc.couponId, null);
  assert.equal(doc.legacy.couponCode, 'NEVEREXISTED');
  assert.equal(doc.legacy.couponUnresolvedReason, 'not_found');
  assert.equal(summary.conflicts.missingCoupon.length, 1);
});

test('11. a blank coupon code is simply no coupon', async () => {
  await seedUser(197);
  await seedPlan(15);

  const summary = await migrate([legacyRow({ p_coupon_code: '' })]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(doc.couponId, null);
  assert.equal(doc.legacy.couponUnresolvedReason, null, 'not a conflict');
  assert.equal(summary.conflicts.missingCoupon.length, 0);
});

// ========================== LEGACY FIELD MAPPING ===========================

test('12. every legacy enrollment and payment field lands where the discovery says', async () => {
  await seedUser(197);
  await seedPlan(15);

  await migrate([legacyRow()]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(doc.enrollDate.toISOString(), new Date('2023-07-20T00:00:00').toISOString());
  assert.equal(doc.startDate.toISOString(), new Date('2023-07-27T00:00:00').toISOString());
  assert.equal(doc.endDate.toISOString(), new Date('2024-01-11T00:00:00').toISOString());
  assert.equal(doc.hasStarted, true);
  assert.equal(doc.isDeleted, false);

  assert.equal(doc.payment.currency, 'INR');
  assert.equal(doc.payment.status, 'Success');
  assert.equal(doc.payment.customerName, 'Test Member');
  assert.equal(doc.payment.contact, '+91-9986323357');
  assert.equal(doc.payment.email, 'member@example.com');
  // Preserved as the zeros the legacy checkout wrote, never back-computed.
  assert.equal(doc.payment.originalAmount, 0);
  assert.equal(doc.payment.discountPercent, 0);
  // Null in the legacy data, and null here.
  assert.equal(doc.payment.referenceId, null);
  assert.equal(doc.payment.description, null);
});

test('13. an unstarted enrollment keeps its null dates', async () => {
  await seedUser(197);
  await seedPlan(15);

  await migrate([legacyRow({ start_flg: '0', start_date: null, end_date: null })]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(doc.hasStarted, false);
  assert.equal(doc.startDate, null);
  assert.equal(doc.endDate, null);
  assert.equal(doc.legacy.startFlg, '0', 'the raw flag is kept too');
});

test('14. a malformed legacy date is reported rather than stored as an invalid date', async () => {
  await seedUser(197);
  await seedPlan(15);

  const summary = await migrate([legacyRow({ enroll_date: 'not-a-date' })]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(doc.enrollDate, null);
  assert.equal(summary.conflicts.malformedDate.length, 1);
  assert.equal(summary.conflicts.malformedDate[0].fields[0].column, 'enroll_date');
});

test('15. a payment status other than Success is preserved and flagged', async () => {
  await seedUser(197);
  await seedPlan(15);

  const summary = await migrate([legacyRow({ p_status: 'Failed' })]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(doc.payment.status, 'Failed', 'stored verbatim, not mapped to a guess');
  assert.equal(summary.conflicts.unknownPaymentStatus.length, 1);
});

test('16. an enrollment with no payment row is migrated and reported', async () => {
  await seedUser(197);
  await seedPlan(15);

  const summary = await migrate([
    legacyRow({
      p_transaction_id: null,
      p_amount: null,
      p_status: null,
      p_payment_date: null,
      p_customer_name: null,
    }),
  ]);
  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();

  assert.equal(summary.conflicts.missingPayment.length, 1);
  // The enrollment's own transaction id is still there.
  assert.equal(doc.payment.transactionId, 'pay_MFtqcm24BoGYlz');
  assert.equal(doc.payment.amount, null);
});

// ============================== ROLES ======================================

test('17. migrating gives the member the client role without losing the others', async () => {
  const user = await seedUser(197, { roles: ['user', 'coach'] });
  await seedPlan(15);

  await migrate([legacyRow()]);
  const after = await User.findById(user._id).lean();

  assert.deepEqual(after.roles.sort(), ['client', 'coach', 'user']);
});

test('17b. a member who is already a client is not counted again', async () => {
  await seedUser(197, { roles: ['user', 'client'] });
  await seedPlan(15);

  const summary = await migrate([legacyRow()]);

  assert.equal(summary.rolesUpdated, 0, 'nothing to add');
});

test('17c. a dry run changes no roles and writes nothing', async () => {
  const user = await seedUser(197);
  await seedPlan(15);
  const mappings = await buildMappings({ legacyCoupons });

  const summary = await loadEnrolledClients([legacyRow()], { dryRun: true, mappings });

  assert.equal(summary.toCreate, 1);
  assert.equal(summary.rolesToUpdate, 1);
  assert.equal(await EnrolledClient.countDocuments({}), 0);
  assert.deepEqual((await User.findById(user._id).lean()).roles, ['user']);
});

// =========================== IDEMPOTENCY ===================================

test('18. re-running the migration creates no duplicate enrollment', async () => {
  await seedUser(197);
  await seedPlan(15);
  const rows = [legacyRow(), legacyRow({ enrollment_id: 59, transaction_id: 'pay_two', p_transaction_id: 'pay_two' })];

  const first = await migrate(rows);
  const second = await migrate(rows);

  assert.equal(first.created, 2);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 2, 'the second run is a genuine no-op');
  assert.equal(await EnrolledClient.countDocuments({}), 2);
});

test('18b. a changed legacy row updates the same document', async () => {
  await seedUser(197);
  await seedPlan(15);

  await migrate([legacyRow()]);
  const summary = await migrate([legacyRow({ p_amount: 8999, amount: '8999' })]);
  const docs = await EnrolledClient.find({}).lean();

  assert.equal(summary.updated, 1);
  assert.equal(docs.length, 1, 'updated in place, not duplicated');
  assert.equal(docs[0].payment.amount, 8999);
});

test('18c. one member can hold several enrollments', async () => {
  const user = await seedUser(197);
  await seedPlan(15);

  await migrate([
    legacyRow({ enrollment_id: 58 }),
    legacyRow({ enrollment_id: 59, transaction_id: 't2', p_transaction_id: 't2' }),
    legacyRow({ enrollment_id: 60, transaction_id: 't3', p_transaction_id: 't3' }),
  ]);

  assert.equal(await EnrolledClient.countDocuments({ userId: user._id }), 3);
  // And nothing about the user document changed shape.
  const after = await User.findById(user._id).lean();
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'enrollments'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(after.profile, 'enrolledClient'), false);
});

test('18d. a duplicate legacy id inside one run is reported once', async () => {
  await seedUser(197);
  await seedPlan(15);

  const summary = await migrate([legacyRow(), legacyRow()]);

  assert.deepEqual(summary.conflicts.duplicateLegacyId, [58]);
  assert.equal(await EnrolledClient.countDocuments({}), 1);
});

// ============================== ADMIN API ==================================

const seedForApi = async () => {
  const user = await seedUser(197, { name: 'Ravi Chandra' });
  const plan = await seedPlan(15, { name: '12 WEEKS GOGETFIT PLAN' });
  const coupon = await seedCoupon(3, 'GGFLAUNCH10');
  const coach = await seedCoach('coach13@gogetfitonline.com');

  await migrate(
    [
      legacyRow({ p_coupon_code: 'GGFLAUNCH10' }),
      legacyRow({
        enrollment_id: 59,
        transaction_id: 'pay_two',
        p_transaction_id: 'pay_two',
        start_flg: '0',
        start_date: null,
        end_date: null,
      }),
    ],
    {
      linkCoachesByEmail: true,
      legacyCoaches: [
        { coach_id: 13, first_name: 'Prajwal', last_name: 'A T', email: 'coach13@gogetfitonline.com' },
      ],
    },
  );

  return { user, plan, coupon, coach };
};

test('19. an admin lists enrollments with the related documents joined', async () => {
  const { user, plan, coupon, coach } = await seedForApi();

  const response = await server.request('GET', '/api/admin/enrolled-clients', {
    token: adminToken,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.pagination.total, 2);

  const row = response.body.data.enrolledClients.find((r) => r.legacyEnrollmentId === 58);
  assert.equal(row.client.id, String(user._id));
  assert.equal(row.client.name, 'Ravi Chandra', 'joined, not stored');
  assert.equal(row.plan.id, String(plan._id));
  assert.equal(row.plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.equal(row.coach.id, String(coach._id));
  assert.equal(row.coach.name, 'Coach Prajwal');
  assert.equal(row.coupon.id, String(coupon._id));
  assert.equal(row.coupon.code, 'GGFLAUNCH10');
  assert.equal(row.transactionId, 'pay_MFtqcm24BoGYlz');
  assert.equal(row.amount, 4999);
  assert.equal(row.legacyCoachId, 13);
  assert.equal(row.legacyCoachName, 'Prajwal A T', 'the list can name an unlinked coach');
});

test('20. status is derived with the legacy rule', async () => {
  await seedForApi();

  const response = await server.request('GET', '/api/admin/enrolled-clients', {
    token: adminToken,
  });
  const byId = Object.fromEntries(
    response.body.data.enrolledClients.map((r) => [r.legacyEnrollmentId, r.status]),
  );

  // End date in the past -> inactive; never started -> not_started.
  assert.equal(byId[58], 'inactive');
  assert.equal(byId[59], 'not_started');
});

test('21. the list paginates and caps the page size', async () => {
  await seedUser(197);
  await seedPlan(15);
  await migrate(
    Array.from({ length: 12 }, (_, i) =>
      legacyRow({ enrollment_id: 100 + i, transaction_id: `t${i}`, p_transaction_id: `t${i}` }),
    ),
  );

  const first = await server.request('GET', '/api/admin/enrolled-clients?page=1&pageSize=5', {
    token: adminToken,
  });
  const third = await server.request('GET', '/api/admin/enrolled-clients?page=3&pageSize=5', {
    token: adminToken,
  });
  const capped = await server.request('GET', '/api/admin/enrolled-clients?pageSize=5000', {
    token: adminToken,
  });

  assert.equal(first.body.data.enrolledClients.length, 5);
  assert.equal(first.body.data.pagination.totalPages, 3);
  assert.equal(third.body.data.enrolledClients.length, 2);
  assert.equal(capped.body.data.pagination.pageSize, 100);
});

test('22. the list filters by relationship and status', async () => {
  const { user, plan, coach, coupon } = await seedForApi();

  const byUser = await server.request('GET', `/api/admin/enrolled-clients?userId=${user._id}`, {
    token: adminToken,
  });
  const byCoach = await server.request('GET', `/api/admin/enrolled-clients?coachId=${coach._id}`, {
    token: adminToken,
  });
  const byPlan = await server.request('GET', `/api/admin/enrolled-clients?planId=${plan._id}`, {
    token: adminToken,
  });
  const byCoupon = await server.request('GET', `/api/admin/enrolled-clients?couponId=${coupon._id}`, {
    token: adminToken,
  });
  const notStarted = await server.request('GET', '/api/admin/enrolled-clients?status=not_started', {
    token: adminToken,
  });

  assert.equal(byUser.body.data.pagination.total, 2);
  assert.equal(byCoach.body.data.pagination.total, 2);
  assert.equal(byPlan.body.data.pagination.total, 2);
  assert.equal(byCoupon.body.data.pagination.total, 1, 'only the row that used the coupon');
  assert.equal(notStarted.body.data.pagination.total, 1);
  assert.equal(notStarted.body.data.enrolledClients[0].legacyEnrollmentId, 59);
});

test('22b. the list searches transaction id, client name and coupon code', async () => {
  await seedForApi();

  const byTxn = await server.request('GET', '/api/admin/enrolled-clients?search=pay_two', {
    token: adminToken,
  });
  const byName = await server.request('GET', '/api/admin/enrolled-clients?search=Ravi', {
    token: adminToken,
  });
  const byCode = await server.request('GET', '/api/admin/enrolled-clients?search=GGFLAUNCH', {
    token: adminToken,
  });

  assert.equal(byTxn.body.data.pagination.total, 1);
  assert.equal(byTxn.body.data.enrolledClients[0].legacyEnrollmentId, 59);
  assert.equal(byName.body.data.pagination.total, 2);
  assert.equal(byCode.body.data.pagination.total, 1);
});

test('23. the list sorts on an allow-listed key and rejects anything else', async () => {
  await seedUser(197);
  await seedPlan(15);
  await migrate([
    legacyRow({ enrollment_id: 1, enroll_date: '2023-01-01 00:00:00', transaction_id: 'a', p_transaction_id: 'a' }),
    legacyRow({ enrollment_id: 2, enroll_date: '2024-01-01 00:00:00', transaction_id: 'b', p_transaction_id: 'b' }),
  ]);

  const asc = await server.request(
    'GET',
    '/api/admin/enrolled-clients?sortKey=enrollDate&sortDir=asc',
    { token: adminToken },
  );
  const desc = await server.request(
    'GET',
    '/api/admin/enrolled-clients?sortKey=enrollDate&sortDir=desc',
    { token: adminToken },
  );
  const rejected = await server.request('GET', '/api/admin/enrolled-clients?sortKey=payment.amount', {
    token: adminToken,
  });

  assert.deepEqual(asc.body.data.enrolledClients.map((r) => r.legacyEnrollmentId), [1, 2]);
  assert.deepEqual(desc.body.data.enrolledClients.map((r) => r.legacyEnrollmentId), [2, 1]);
  assert.equal(rejected.status, 400, 'an arbitrary sort field never reaches Mongo');
});

test('24. the detail view returns the full purchase record', async () => {
  await seedForApi();
  const list = await server.request('GET', '/api/admin/enrolled-clients', { token: adminToken });
  const { id } = list.body.data.enrolledClients.find((r) => r.legacyEnrollmentId === 58);

  const response = await server.request(`GET`, `/api/admin/enrolled-clients/${id}`, {
    token: adminToken,
  });
  const { enrolledClient } = response.body.data;

  assert.equal(response.status, 200);
  assert.equal(enrolledClient.payment.originalAmount, 0);
  assert.equal(enrolledClient.payment.customerName, 'Test Member');
  assert.equal(enrolledClient.legacy.enrollmentId, 58);
  assert.equal(enrolledClient.legacy.coachId, 13);
  assert.equal(enrolledClient.legacy.coachResolvedBy, 'email');
});

test('25. an unknown or malformed id returns 404', async () => {
  for (const id of ['507f1f77bcf86cd799439011', 'not-an-id']) {
    const response = await server.request('GET', `/api/admin/enrolled-clients/${id}`, {
      token: adminToken,
    });
    assert.equal(response.status, 404, id);
    assert.equal(response.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
  }
});

test('26. an invalid query is rejected', async () => {
  for (const qs of ['?page=0', '?pageSize=0', '?status=whatever', '?userId=nope', '?hasStarted=maybe']) {
    const response = await server.request('GET', `/api/admin/enrolled-clients${qs}`, {
      token: adminToken,
    });
    assert.equal(response.status, 400, qs);
  }
});

// ========================== AUTHORIZATION ==================================

test('27. a non-admin receives 403 and an anonymous caller 401', async () => {
  await seedForApi();
  const list = await server.request('GET', '/api/admin/enrolled-clients', { token: adminToken });
  const { id } = list.body.data.enrolledClients[0];

  for (const [role, phone] of [
    ['user', '919000000061'],
    ['client', '919000000062'],
    ['coach', '919000000063'],
  ]) {
    const token = await tokenForRoles(role === 'user' ? ['user'] : ['user', role], phone);

    for (const path of ['/api/admin/enrolled-clients', `/api/admin/enrolled-clients/${id}`]) {
      const response = await server.request('GET', path, { token });
      assert.equal(response.status, 403, `${role} ${path}`);
      assert.equal(response.body.error.code, 'FORBIDDEN');
    }
  }

  for (const path of ['/api/admin/enrolled-clients', `/api/admin/enrolled-clients/${id}`]) {
    const response = await server.request('GET', path, {});
    assert.equal(response.status, 401, path);
  }
});

// =========================== DOCUMENT SHAPE ================================

test('28. the collection is enrolledclients and holds no embedded documents', async () => {
  await seedForApi();

  const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  assert.ok(names.includes('enrolledclients'));
  assert.equal(names.includes('paidclients'), false);
  assert.equal(names.includes('clientprofiles'), false);

  const doc = await EnrolledClient.findOne({ 'legacy.enrollmentId': 58 }).lean();
  // Relationships are ids, and only ids.
  assert.ok(doc.userId instanceof mongoose.Types.ObjectId);
  assert.ok(doc.planId instanceof mongoose.Types.ObjectId);
  for (const field of ['user', 'plan', 'coach', 'coupon', 'username', 'phoneNumber', 'coachName', 'planName', 'couponCode']) {
    assert.equal(Object.prototype.hasOwnProperty.call(doc, field), false, field);
  }
});
