import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import User from '../../src/models/user.model.js';
import Coach from '../../src/models/coach.model.js';
import Coupon from '../../src/models/coupon.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import {
  BrandAmbassadorActivity,
  BrandAmbassadorCoupon,
  BrandAmbassadorPayout,
  BrandAmbassadorReferral,
  BrandAmbassadorSequence,
} from '../../src/models/brand-ambassador.model.js';
import { COUPON_PREFIX, recordReferralForEnrollment } from '../../src/services/brand-ambassador.service.js';
import { setNow } from '../../src/utils/clock.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let admin;
let adminToken;
let chinmay;
let chinmayToken;
let rahul;
let rahulToken;
let coach;
let plan;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const seedUser = (phone, name, roles = ['user']) =>
  User.create({
    phone: { raw: phone, normalized: phone },
    profile: { name, email: `${phone}@example.com` },
    roles,
    status: 'active',
  });

const req = (method, path, token, body) => server.request(method, path, { token, body });
const register = (token) => req('POST', '/api/ambassadors/register', token);
const me = (token) => req('GET', '/api/ambassadors/me', token);

/** Rahul's checkout: cart -> quote -> purchase, exactly as the app does it. */
const buyWithCode = async (token, code, paymentReference) => {
  const added = await req('POST', '/api/users/me/cart', token, { coachId: String(coach._id), planId: String(plan._id) });
  const id = added.body.data.item.id;
  const quote = await req('POST', `/api/users/me/cart/${id}/quote`, token, { couponCode: code });
  const bought = await req('POST', `/api/users/me/cart/${id}/purchase`, token, { couponCode: code, paymentReference });
  return { id, quote, bought };
};

/** Twelve earlier referrals, so the scenario starts where the app's sample does. */
const seedEarlierReferrals = async (ambassador, n) => {
  for (let i = 0; i < n; i += 1) {
    await BrandAmbassadorReferral.create({
      ambassadorCouponId: ambassador._id,
      ambassadorUserId: ambassador.userId,
      couponCode: ambassador.couponCode,
      referredUserId: new mongoose.Types.ObjectId(),
      orderId: new mongoose.Types.ObjectId(),
      planId: plan._id,
      planNameSnapshot: plan.name,
      originalPlanAmount: 10000,
      discountPercent: 5,
      discountAmount: 500,
      finalPaidAmount: 9500,
      currency: 'INR',
      paymentId: `pay_old_${i}`,
      paymentStatus: 'Success',
      referralStatus: 'successful',
      purchasedAt: new Date('2026-10-20T10:00:00.000Z'),
      commissionPercent: 5,
      grossCommission: 475,
      tdsPercent: 10,
      tdsAmount: 48,
      netCommission: 427,
      payoutPeriod: '2026-10',
    });
  }
};

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  admin = await seedUser('918000000000', 'Admin One', ['user', 'admin']);
  adminToken = tokenFor(admin);
  chinmay = await seedUser('919000000001', 'Chinmay K T');
  chinmayToken = tokenFor(chinmay);
  rahul = await seedUser('919000000002', 'Rahul Verma');
  rahulToken = tokenFor(rahul);
  const coachUser = await seedUser('917000000001', 'Coach Prajwal', ['user', 'coach']);
  coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' }, status: 'active' });
  plan = await GogetfitPlan.create({
    name: '12 WEEKS GOGETFIT PLAN',
    planType: 'Enrollment',
    coachLevel: 'LEVEL 1',
    durationWeeks: 12,
    personsAllowed: 1,
    pricing: { basePrice: 10000, reward: null },
    status: 'active',
  });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// ─── coupon generation ───────────────────────────────────────────────────────

test('register generates GGF0001 for the token user; the next ambassadors get GGF0002, GGF0003 whatever their names', async () => {
  const res = await register(chinmayToken);
  assert.equal(res.status, 201);
  assert.equal(res.body.data.ambassador.couponCode, 'GGF0001');
  assert.equal(res.body.data.ambassador.discountPercent, 5);
  assert.equal(res.body.data.ambassador.successfulReferrals, 0);

  const stored = await BrandAmbassadorCoupon.findOne({ couponCode: 'GGF0001' }).lean();
  assert.equal(String(stored.userId), String(chinmay._id));

  const other = await seedUser('919000000003', 'Chinmayi');
  assert.equal((await register(tokenFor(other))).body.data.ambassador.couponCode, 'GGF0002');
  assert.equal((await register(rahulToken)).body.data.ambassador.couponCode, 'GGF0003');
  const noLetters = await seedUser('919000000004', '42 !!');
  assert.equal((await register(tokenFor(noLetters))).body.data.ambassador.couponCode, 'GGF0004');
  assert.equal(COUPON_PREFIX, 'GGF');
});

test('register is idempotent: repeats and concurrent taps give one code', async () => {
  const results = await Promise.all([register(chinmayToken), register(chinmayToken), register(chinmayToken)]);
  const codes = new Set(results.map((r) => r.body.data.ambassador.couponCode));
  assert.equal(codes.size, 1);
  assert.equal(await BrandAmbassadorCoupon.countDocuments({ userId: chinmay._id }), 1);

  const again = await register(chinmayToken);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.created, false);
});

test('concurrent registrations get distinct, gap-free sequential codes', async () => {
  const users = await Promise.all(
    Array.from({ length: 12 }, (_, i) => seedUser(`9190000001${String(i).padStart(2, '0')}`, `Member ${i}`)),
  );
  const results = await Promise.all(users.map((u) => register(tokenFor(u))));
  assert.ok(results.every((r) => r.status === 201));
  const codes = results.map((r) => r.body.data.ambassador.couponCode).sort();
  assert.deepEqual(codes, Array.from({ length: 12 }, (_, i) => `GGF${String(i + 1).padStart(4, '0')}`));
  assert.equal(new Set(await BrandAmbassadorCoupon.distinct('couponCode')).size, 12);
});

test('a name change never regenerates the code', async () => {
  await register(chinmayToken);
  await User.updateOne({ _id: chinmay._id }, { $set: { 'profile.name': 'Zara' } });
  const again = await register(chinmayToken);
  assert.equal(again.body.data.ambassador.couponCode, 'GGF0001');
  assert.equal((await me(chinmayToken)).body.data.ambassador.couponCode, 'GGF0001');
});

test('generation skips a code an admin coupon already uses', async () => {
  await Coupon.create({
    code: 'GGF0001',
    discount: { type: 'percent', value: 10 },
    validFrom: new Date('2026-01-01'),
    validTo: new Date('2027-01-01'),
    createdBy: admin._id,
    updatedBy: admin._id,
  });
  assert.equal((await register(chinmayToken)).body.data.ambassador.couponCode, 'GGF0002');
});

test('the GGF counter continues from where it is and skips codes already held', async () => {
  // A pre-existing GGF code (old-format fallback for a name with no letters)
  // with no counter document, then a counter that is already further on.
  await BrandAmbassadorCoupon.create({ userId: rahul._id, couponCode: 'GGF0001', discountValue: 5, commissionValue: 5 });
  assert.equal((await register(chinmayToken)).body.data.ambassador.couponCode, 'GGF0002');
  await BrandAmbassadorSequence.updateOne({ _id: 'GGF' }, { $set: { seq: 41 } });
  const other = await seedUser('919000000003', 'Asha');
  assert.equal((await register(tokenFor(other))).body.data.ambassador.couponCode, 'GGF0042');
});

test('existing name-format codes are kept and keep working end to end', async () => {
  // An ambassador from before the GGF format.
  const legacy = await BrandAmbassadorCoupon.create({ userId: chinmay._id, couponCode: 'CHI0007', discountValue: 5, commissionValue: 5 });

  // Not regenerated: register and /me return the old code.
  const again = await register(chinmayToken);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.ambassador.couponCode, 'CHI0007');
  assert.equal((await me(chinmayToken)).body.data.ambassador.couponCode, 'CHI0007');

  // New ambassadors get the new format alongside it.
  const other = await seedUser('919000000003', 'Chinmayi');
  assert.equal((await register(tokenFor(other))).body.data.ambassador.couponCode, 'GGF0001');

  // Validation (any case), purchase, referral and commission all work.
  const { quote, bought } = await buyWithCode(rahulToken, 'chi0007', 'pay_legacy_1');
  assert.equal(quote.status, 200);
  assert.deepEqual(quote.body.data.item.pricing.coupon, { id: null, code: 'CHI0007', discountPercent: 5, kind: 'ambassador' });
  assert.equal(bought.status, 201);
  const referral = await BrandAmbassadorReferral.findOne({ ambassadorCouponId: legacy._id }).lean();
  assert.equal(referral.couponCode, 'CHI0007');
  assert.equal(referral.referralStatus, 'successful');
  assert.equal(referral.grossCommission, 475);
  assert.equal((await me(chinmayToken)).body.data.ambassador.successfulReferrals, 1);

  const found = await req('GET', '/api/admin/ambassadors?search=chi0007', adminToken);
  assert.deepEqual(found.body.data.ambassadors.map((a) => a.couponCode), ['CHI0007']);
});

test('GGF codes validate case-insensitively and are always shown upper-case', async () => {
  await register(chinmayToken);
  const added = await req('POST', '/api/users/me/cart', rahulToken, { coachId: String(coach._id), planId: String(plan._id) });
  for (const code of ['ggf0001', 'Ggf0001', '  GGF0001 ']) {
    const quote = await req('POST', `/api/users/me/cart/${added.body.data.item.id}/quote`, rahulToken, { couponCode: code });
    assert.equal(quote.status, 200, code);
    assert.equal(quote.body.data.item.pricing.coupon.code, 'GGF0001', code);
  }
  assert.equal((await me(chinmayToken)).body.data.ambassador.couponCode, 'GGF0001');
});

test('an admin coupon cannot take an ambassador code', async () => {
  await register(chinmayToken);
  const res = await req('POST', '/api/admin/coupons', adminToken, {
    code: 'ggf0001',
    discount: { type: 'percent', value: 10 },
    validFrom: '2026-01-01',
    validTo: '2027-01-01',
  });
  assert.equal(res.status, 409);
});

test('register accepts no client-supplied fields and requires a session', async () => {
  assert.equal((await register(undefined)).status, 401);
  assert.equal((await me(undefined)).status, 401);
  const res = await req('POST', '/api/ambassadors/register', chinmayToken, { userId: String(rahul._id) });
  assert.equal(res.status, 400);
  assert.equal(await BrandAmbassadorCoupon.countDocuments({}), 0);
});

test('GET /me: null before joining, with the programme terms', async () => {
  const res = await me(chinmayToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.ambassador, null);
  assert.equal(res.body.data.program.discountPercent, 5);
  assert.equal(res.body.data.program.commissionMinPercent, 5);
  assert.equal(res.body.data.program.commissionMaxPercent, 10);
  assert.equal(res.body.data.program.tdsPercent, 10);
  assert.equal(res.body.data.program.payoutDay, 7);
});

// ─── checkout ────────────────────────────────────────────────────────────────

test('checkout: an ambassador code gives 5% off, priced by the server', async () => {
  await register(chinmayToken);
  const added = await req('POST', '/api/users/me/cart', rahulToken, { coachId: String(coach._id), planId: String(plan._id) });
  const quote = await req('POST', `/api/users/me/cart/${added.body.data.item.id}/quote`, rahulToken, { couponCode: 'ggf0001' });
  assert.equal(quote.status, 200);
  const pricing = quote.body.data.item.pricing;
  assert.equal(pricing.originalAmount, 10000);
  assert.equal(pricing.discountAmount, 500);
  assert.equal(pricing.finalAmount, 9500);
  assert.deepEqual(pricing.coupon, { id: null, code: 'GGF0001', discountPercent: 5, kind: 'ambassador' });
});

test('checkout refuses own code, inactive code and unknown code; admin coupons still work', async () => {
  await register(chinmayToken);
  const added = await req('POST', '/api/users/me/cart', chinmayToken, { coachId: String(coach._id), planId: String(plan._id) });
  const quote = (body) => req('POST', `/api/users/me/cart/${added.body.data.item.id}/quote`, chinmayToken, body);

  const own = await quote({ couponCode: 'GGF0001' });
  assert.equal(own.status, 400);
  assert.equal(own.body.error.code, 'AMBASSADOR_SELF_REFERRAL');

  assert.equal((await quote({ couponCode: 'NOPE0001' })).status, 404);

  const coupon = await Coupon.create({
    code: 'SAVE10',
    discount: { type: 'percent', value: 10 },
    validFrom: new Date(Date.now() - 86_400_000),
    validTo: new Date(Date.now() + 86_400_000),
    visibility: 'public',
    createdBy: admin._id,
    updatedBy: admin._id,
  });
  const byId = await quote({ couponId: String(coupon._id) });
  assert.equal(byId.body.data.item.pricing.finalAmount, 9000);
  assert.equal(byId.body.data.item.pricing.coupon.kind, 'coupon');

  await BrandAmbassadorCoupon.updateOne({ couponCode: 'GGF0001' }, { $set: { status: 'inactive' } });
  const rahulCart = await req('POST', '/api/users/me/cart', rahulToken, { coachId: String(coach._id), planId: String(plan._id) });
  const inactive = await req('POST', `/api/users/me/cart/${rahulCart.body.data.item.id}/quote`, rahulToken, { couponCode: 'GGF0001' });
  assert.equal(inactive.status, 400);
  assert.equal(inactive.body.error.code, 'COUPON_INACTIVE');
});

test('a coupon application alone creates no referral', async () => {
  await register(chinmayToken);
  const added = await req('POST', '/api/users/me/cart', rahulToken, { coachId: String(coach._id), planId: String(plan._id) });
  await req('POST', `/api/users/me/cart/${added.body.data.item.id}/quote`, rahulToken, { couponCode: 'GGF0001' });
  assert.equal(await BrandAmbassadorReferral.countDocuments({}), 0);
});

// ─── referral attribution ────────────────────────────────────────────────────

test('a purchase with the code creates one referral; retries and repeat confirmations never add another', async () => {
  await register(chinmayToken);
  const { id, bought } = await buyWithCode(rahulToken, 'GGF0001', 'pay_rahul_1');
  assert.equal(bought.status, 201);

  const order = await EnrolledClient.findOne({ userId: rahul._id }).lean();
  const ambassador = await BrandAmbassadorCoupon.findOne({ couponCode: 'GGF0001' }).lean();
  assert.equal(String(order.ambassadorCouponId), String(ambassador._id));
  assert.equal(order.payment.amount, 9500);

  const referral = await BrandAmbassadorReferral.findOne({ orderId: order._id }).lean();
  assert.equal(referral.referralStatus, 'successful');
  assert.equal(String(referral.ambassadorUserId), String(chinmay._id));
  assert.equal(String(referral.referredUserId), String(rahul._id));
  assert.equal(referral.finalPaidAmount, 9500);
  assert.equal(referral.discountAmount, 500);
  assert.equal(referral.commissionPercent, 5);
  assert.equal(referral.grossCommission, 475);
  assert.equal(referral.tdsAmount, 48);
  assert.equal(referral.netCommission, 427);

  // The same purchase retried, and the confirmation hook run again (a duplicate webhook).
  const retry = await req('POST', `/api/users/me/cart/${id}/purchase`, rahulToken, { couponCode: 'GGF0001', paymentReference: 'pay_rahul_1' });
  assert.equal(retry.status, 200);
  await recordReferralForEnrollment(order._id);
  await Promise.all([recordReferralForEnrollment(order._id), recordReferralForEnrollment(order._id)]);
  assert.equal(await BrandAmbassadorReferral.countDocuments({ orderId: order._id }), 1);
  assert.equal((await me(chinmayToken)).body.data.ambassador.successfulReferrals, 1);
});

test('an unpaid order is pending and not counted until its payment succeeds', async () => {
  await register(chinmayToken);
  const ambassador = await BrandAmbassadorCoupon.findOne({ couponCode: 'GGF0001' }).lean();
  const order = await EnrolledClient.create({
    userId: rahul._id,
    planId: plan._id,
    coachId: coach._id,
    ambassadorCouponId: ambassador._id,
    enrollDate: new Date(),
    payment: { transactionId: 'pay_pending', amount: 9500, originalAmount: 10000, discountPercent: 5, currency: 'INR', status: 'Pending' },
  });
  await recordReferralForEnrollment(order._id);
  assert.equal((await BrandAmbassadorReferral.findOne({ orderId: order._id }).lean()).referralStatus, 'pending');
  assert.equal((await me(chinmayToken)).body.data.ambassador.successfulReferrals, 0);

  await EnrolledClient.updateOne({ _id: order._id }, { $set: { 'payment.status': 'Success' } });
  await recordReferralForEnrollment(order._id);
  await recordReferralForEnrollment(order._id);
  const settled = await BrandAmbassadorReferral.findOne({ orderId: order._id }).lean();
  assert.equal(settled.referralStatus, 'successful');
  assert.deepEqual(settled.statusHistory.map((h) => h.status), ['pending', 'successful']);
  assert.equal((await me(chinmayToken)).body.data.ambassador.successfulReferrals, 1);
});

test('the database refuses a second referral for the same order', async () => {
  await register(chinmayToken);
  await buyWithCode(rahulToken, 'GGF0001', 'pay_rahul_1');
  const existing = await BrandAmbassadorReferral.findOne({}).lean();
  const { _id, createdAt, updatedAt, ...copy } = existing;
  await assert.rejects(BrandAmbassadorReferral.create(copy), (e) => e.code === 11000);
});

// ─── privacy & permissions ───────────────────────────────────────────────────

test('the mobile profile carries the count only - no customer, order, plan or payment', async () => {
  await register(chinmayToken);
  await buyWithCode(rahulToken, 'GGF0001', 'pay_rahul_1');
  const body = JSON.stringify((await me(chinmayToken)).body);
  for (const leak of ['Rahul', '919000000002', String(rahul._id), 'WEEKS', 'pay_rahul_1', 'example.com']) {
    assert.equal(body.includes(leak), false, `leaked ${leak}`);
  }
  // And Rahul cannot read Chinmay's profile: /me is always the caller's own.
  assert.equal((await me(rahulToken)).body.data.ambassador, null);
});

test('every admin ambassador route refuses members and anonymous callers', async () => {
  await register(chinmayToken);
  await buyWithCode(rahulToken, 'GGF0001', 'pay_rahul_1');
  const amb = await BrandAmbassadorCoupon.findOne({}).lean();
  const ref = await BrandAmbassadorReferral.findOne({}).lean();
  const routes = [
    ['GET', '/api/admin/ambassadors'],
    ['GET', `/api/admin/ambassadors/${amb._id}`],
    ['PATCH', `/api/admin/ambassadors/${amb._id}/status`],
    ['GET', `/api/admin/ambassadors/${amb._id}/referrals`],
    ['GET', `/api/admin/ambassadors/${amb._id}/payouts`],
    ['POST', `/api/admin/ambassadors/${amb._id}/payouts`],
    ['PATCH', `/api/admin/ambassadors/${amb._id}/commission`],
    ['GET', `/api/admin/ambassadors/${amb._id}/activity`],
    ['GET', `/api/admin/ambassador-referrals/${ref._id}`],
  ];
  for (const [method, path] of routes) {
    const body = method === 'GET' ? undefined : {};
    assert.equal((await req(method, path, undefined, body)).status, 401, `${method} ${path}`);
    assert.equal((await req(method, path, chinmayToken, body)).status, 403, `${method} ${path} as ambassador`);
  }
});

// ─── admin ───────────────────────────────────────────────────────────────────

test('admin list: search, filter, sort, paging and summary from real records', async () => {
  await register(chinmayToken);
  await register(rahulToken);
  await buyWithCode(await tokenFor(await seedUser('919000000009', 'Neha Sharma')), 'GGF0001', 'pay_neha');

  const list = await req('GET', '/api/admin/ambassadors?sortKey=successfulReferrals&sortDir=desc', adminToken);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.pagination.total, 2);
  const [top] = list.body.data.ambassadors;
  assert.equal(top.couponCode, 'GGF0001');
  assert.equal(top.name, 'Chinmay K T');
  assert.equal(top.email, '919000000001@example.com');
  assert.equal(top.mobile, '+919000000001');
  assert.equal(top.successfulReferrals, 1);
  assert.equal(top.salesAmount, 9500);
  assert.deepEqual(list.body.data.summary, { totalAmbassadors: 2, totalReferrals: 1, totalSales: 9500, totalCommissionPayable: 427 });

  for (const search of ['chinmay', 'GGF0001', '9000000001', String(chinmay._id), '919000000001@example']) {
    const found = await req('GET', `/api/admin/ambassadors?search=${encodeURIComponent(search)}`, adminToken);
    assert.deepEqual(found.body.data.ambassadors.map((a) => a.couponCode), ['GGF0001'], search);
  }
  const paged = await req('GET', '/api/admin/ambassadors?pageSize=1&page=2&sortKey=couponCode&sortDir=asc', adminToken);
  assert.deepEqual(paged.body.data.ambassadors.map((a) => a.couponCode), ['GGF0002']);
  const inactive = await req('GET', '/api/admin/ambassadors?status=Inactive', adminToken);
  assert.equal(inactive.body.data.pagination.total, 0);
});

test('admin referrals: the full transaction, filters, detail and plans', async () => {
  await register(chinmayToken);
  await buyWithCode(rahulToken, 'GGF0001', 'pay_rahul_1');
  const amb = await BrandAmbassadorCoupon.findOne({}).lean();

  const res = await req('GET', `/api/admin/ambassadors/${amb._id}/referrals`, adminToken);
  assert.equal(res.status, 200);
  const [row] = res.body.data.referrals;
  assert.equal(row.customerName, 'Rahul Verma');
  assert.equal(row.customerUserId, String(rahul._id));
  assert.equal(row.email, '919000000002@example.com');
  assert.equal(row.mobile, '+919000000002');
  assert.equal(row.couponCode, 'GGF0001');
  assert.equal(row.ambassadorName, 'Chinmay K T');
  assert.equal(row.planName, '12 WEEKS GOGETFIT PLAN');
  assert.equal(row.planId, String(plan._id));
  assert.equal(row.originalAmount, 10000);
  assert.equal(row.discountAmount, 500);
  assert.equal(row.paidAmount, 9500);
  assert.equal(row.currency, 'INR');
  assert.equal(row.paymentId, 'pay_rahul_1');
  assert.equal(row.paymentStatus, 'Success');
  assert.equal(row.referralStatus, 'Successful');
  assert.deepEqual(res.body.data.plans, [{ id: String(plan._id), name: '12 WEEKS GOGETFIT PLAN' }]);

  const q = (qs) => req('GET', `/api/admin/ambassadors/${amb._id}/referrals?${qs}`, adminToken);
  assert.equal((await q('search=rahul')).body.data.pagination.total, 1);
  assert.equal((await q('search=nobody')).body.data.pagination.total, 0);
  assert.equal((await q('referralStatus=Pending')).body.data.pagination.total, 0);
  assert.equal((await q('paymentStatus=Success')).body.data.pagination.total, 1);
  assert.equal((await q('from=2000-01-01&to=2000-01-02')).body.data.pagination.total, 0);
  assert.equal((await q('from=bad')).status, 400);

  const detail = await req('GET', `/api/admin/ambassador-referrals/${row.id}`, adminToken);
  assert.equal(detail.body.data.referral.orderId, row.orderId);
  assert.equal((await req('GET', `/api/admin/ambassador-referrals/${new mongoose.Types.ObjectId()}`, adminToken)).status, 404);
});

test('admin status change: validated, audited, and it stops the code at checkout', async () => {
  await register(chinmayToken);
  const amb = await BrandAmbassadorCoupon.findOne({}).lean();
  const path = `/api/admin/ambassadors/${amb._id}/status`;

  assert.equal((await req('PATCH', path, adminToken, { status: 'Paused' })).status, 400);
  assert.equal((await req('PATCH', path, adminToken, { status: 'Active' })).status, 409);
  const off = await req('PATCH', path, adminToken, { status: 'Inactive', reason: 'Misuse report' });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.ambassador.status, 'Inactive');
  assert.equal((await me(chinmayToken)).body.data.ambassador.status, 'inactive');

  const log = await BrandAmbassadorActivity.findOne({ action: 'deactivated' }).lean();
  assert.equal(String(log.actorId), String(admin._id));
  assert.deepEqual(log.before, { status: 'active' });
  assert.deepEqual(log.after, { status: 'inactive' });
  assert.match(log.detail, /Misuse report/);
  assert.equal(await BrandAmbassadorCoupon.countDocuments({}), 1);
});

test('payouts and activity come from the ledger and audit trail', async () => {
  await register(chinmayToken);
  await buyWithCode(rahulToken, 'GGF0001', 'pay_rahul_1');
  const amb = await BrandAmbassadorCoupon.findOne({}).lean();

  const payouts = (await req('GET', `/api/admin/ambassadors/${amb._id}/payouts`, adminToken)).body.data.payouts;
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].eligibleOrderValue, 9500);
  assert.equal(payouts[0].grossCommission, 475);
  assert.equal(payouts[0].tds, 48);
  assert.equal(payouts[0].netPayable, 427);
  // Nothing here pretends money was sent.
  assert.equal(payouts[0].status, 'Pending');
  assert.equal(payouts[0].transactionReference, null);

  const activity = (await req('GET', `/api/admin/ambassadors/${amb._id}/activity`, adminToken)).body.data.activity;
  const actions = activity.map((a) => a.action);
  for (const a of ['Ambassador registered', 'Coupon generated', 'Referral successful', 'Commission calculated']) {
    assert.ok(actions.includes(a), a);
  }
  assert.equal(activity.find((a) => a.action === 'Ambassador registered').actor, 'Chinmay K T');
  assert.equal(activity.find((a) => a.action === 'Coupon generated').actor, 'System');
});

// ─── the full scenario ───────────────────────────────────────────────────────

test('end to end: Chinmay registers, Rahul buys with GGF0001, the count goes 12 -> 13 and stays there', async () => {
  const reg = await register(chinmayToken);
  assert.equal(reg.body.data.ambassador.couponCode, 'GGF0001');
  const amb = await BrandAmbassadorCoupon.findOne({ userId: chinmay._id }).lean();
  await seedEarlierReferrals(amb, 12);
  assert.equal((await me(chinmayToken)).body.data.ambassador.successfulReferrals, 12);

  const { quote, bought } = await buyWithCode(rahulToken, 'GGF0001', 'pay_rahul_e2e');
  assert.equal(quote.body.data.item.pricing.finalAmount, 9500);
  assert.equal(bought.status, 201);

  const mine = await me(chinmayToken);
  assert.equal(mine.body.data.ambassador.successfulReferrals, 13);
  assert.equal(JSON.stringify(mine.body).includes('Rahul'), false);

  const list = await req('GET', '/api/admin/ambassadors?search=GGF0001', adminToken);
  assert.equal(list.body.data.ambassadors[0].successfulReferrals, 13);
  const detail = await req('GET', `/api/admin/ambassadors/${amb._id}`, adminToken);
  assert.equal(detail.body.data.ambassador.successfulReferrals, 13);
  const refs = await req('GET', `/api/admin/ambassadors/${amb._id}/referrals?search=Rahul`, adminToken);
  const row = refs.body.data.referrals[0];
  assert.equal(row.customerName, 'Rahul Verma');
  assert.equal(row.paidAmount, 9500);
  assert.equal(row.paymentStatus, 'Success');

  // A duplicate payment event: still 13.
  const order = await EnrolledClient.findOne({ userId: rahul._id }).lean();
  await recordReferralForEnrollment(order._id);
  assert.equal((await me(chinmayToken)).body.data.ambassador.successfulReferrals, 13);
});

// ─── simulated payments, failures and edge cases ─────────────────────────────

test('a failed payment records no referral; the referral is marked simulated', async () => {
  await register(chinmayToken);
  const ambassador = await BrandAmbassadorCoupon.findOne({ couponCode: 'GGF0001' }).lean();
  const failed = await EnrolledClient.create({
    userId: rahul._id,
    planId: plan._id,
    coachId: coach._id,
    ambassadorCouponId: ambassador._id,
    enrollDate: new Date(),
    payment: { transactionId: 'pay_failed', amount: 9500, originalAmount: 10000, discountPercent: 5, currency: 'INR', status: 'Failed' },
  });
  assert.equal(await recordReferralForEnrollment(failed._id), null);
  assert.equal(await BrandAmbassadorReferral.countDocuments({}), 0);

  await buyWithCode(rahulToken, 'GGF0001', 'pay_rahul_sim');
  const referral = await BrandAmbassadorReferral.findOne({}).lean();
  assert.equal(referral.paymentVerification, 'simulated');
  const detail = await req('GET', `/api/admin/ambassador-referrals/${referral._id}`, adminToken);
  assert.equal(detail.body.data.referral.paymentVerification, 'simulated');
  assert.equal((await me(chinmayToken)).body.data.ambassador.successfulReferrals, 1);
});

test('a code deactivated before purchase is refused at purchase too, and nothing is recorded', async () => {
  await register(chinmayToken);
  const added = await req('POST', '/api/users/me/cart', rahulToken, { coachId: String(coach._id), planId: String(plan._id) });
  await BrandAmbassadorCoupon.updateOne({ couponCode: 'GGF0001' }, { $set: { status: 'inactive' } });
  const res = await req('POST', `/api/users/me/cart/${added.body.data.item.id}/purchase`, rahulToken, { couponCode: 'GGF0001', paymentReference: 'pay_x' });
  assert.equal(res.status, 400);
  assert.equal(await EnrolledClient.countDocuments({ userId: rahul._id }), 0);
  assert.equal(await BrandAmbassadorReferral.countDocuments({}), 0);
});

test('an invalid token is refused; an ambassador with no referrals has an empty list', async () => {
  assert.equal((await me('not-a-token')).status, 401);
  await register(chinmayToken);
  const amb = await BrandAmbassadorCoupon.findOne({}).lean();
  const refs = await req('GET', `/api/admin/ambassadors/${amb._id}/referrals`, adminToken);
  assert.deepEqual(refs.body.data.referrals, []);
  assert.equal(refs.body.data.pagination.total, 0);
  assert.deepEqual((await req('GET', `/api/admin/ambassadors/${amb._id}/payouts`, adminToken)).body.data.payouts, []);
});

// ─── commission rate ─────────────────────────────────────────────────────────

test('admin sets a commission rate in range; it applies to future referrals only', async () => {
  await register(chinmayToken);
  const amb = await BrandAmbassadorCoupon.findOne({}).lean();
  const path = `/api/admin/ambassadors/${amb._id}/commission`;
  await buyWithCode(rahulToken, 'GGF0001', 'pay_before');

  for (const bad of [4, 11, 7.5, '8']) {
    assert.equal((await req('PATCH', path, adminToken, { commissionPercent: bad })).status, 400, String(bad));
  }
  assert.equal((await req('PATCH', path, adminToken, { commissionPercent: 5 })).status, 409);
  const res = await req('PATCH', path, adminToken, { commissionPercent: 8, reason: 'Top performer' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.ambassador.commissionPercent, 8);
  assert.equal((await me(chinmayToken)).body.data.ambassador.commissionPercent, 8);

  const neha = await seedUser('919000000009', 'Neha Sharma');
  await buyWithCode(tokenFor(neha), 'GGF0001', 'pay_after');
  const [first, second] = await BrandAmbassadorReferral.find({}).sort({ createdAt: 1 }).lean();
  assert.equal(first.commissionPercent, 5);
  assert.equal(first.grossCommission, 475);
  assert.equal(second.commissionPercent, 8);
  assert.equal(second.grossCommission, 760);
  assert.equal(second.tdsAmount, 76);

  const log = await BrandAmbassadorActivity.findOne({ action: 'commission_rate_changed' }).lean();
  assert.equal(String(log.actorId), String(admin._id));
  assert.deepEqual(log.before, { commissionValue: 5 });
  assert.deepEqual(log.after, { commissionValue: 8 });
});

// ─── payouts ─────────────────────────────────────────────────────────────────

test('recording a payout: finished months only, exact amount, settles the ledger, audited', async () => {
  setNow(new Date('2026-11-08T06:00:00.000Z'));
  try {
    await register(chinmayToken);
    const amb = await BrandAmbassadorCoupon.findOne({}).lean();
    await seedEarlierReferrals(amb, 3); // October: 3 × ₹427 net = ₹1,281
    await buyWithCode(rahulToken, 'GGF0001', 'pay_nov'); // November, still open
    const path = `/api/admin/ambassadors/${amb._id}/payouts`;
    const body = { period: '2026-10', amount: 1281, paidAt: '2026-11-07', reference: 'UTR123456', status: 'Paid' };

    let payouts = (await req('GET', path, adminToken)).body.data.payouts;
    const oct = payouts.find((p) => p.periodKey === '2026-10');
    assert.equal(oct.netPayable, 1281);
    assert.equal(oct.canRecord, true);
    assert.equal(payouts.find((p) => p.periodKey === '2026-11').canRecord, false);

    assert.equal((await req('POST', path, adminToken, { ...body, period: '2026-11', amount: 427 })).status, 400);
    const wrong = await req('POST', path, adminToken, { ...body, amount: 1000 });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error.message, /₹1281/);
    assert.equal((await req('POST', path, adminToken, { ...body, reference: '' })).status, 400);
    assert.equal((await req('POST', path, adminToken, { ...body, status: 'Sent' })).status, 400);

    // Processing first: noted, nothing settled.
    const processing = await req('POST', path, adminToken, { ...body, status: 'Processing' });
    assert.equal(processing.status, 200);
    assert.equal(processing.body.data.payouts.find((p) => p.periodKey === '2026-10').status, 'Processing');
    assert.equal(await BrandAmbassadorReferral.countDocuments({ commissionStatus: 'paid' }), 0);

    const paid = await req('POST', path, adminToken, body);
    assert.equal(paid.status, 200);
    const settled = paid.body.data.payouts.find((p) => p.periodKey === '2026-10');
    assert.equal(settled.status, 'Paid');
    assert.equal(settled.transactionReference, 'UTR123456');
    assert.equal(settled.canRecord, false);
    assert.equal(await BrandAmbassadorReferral.countDocuments({ payoutPeriod: '2026-10', commissionStatus: 'paid' }), 3);
    assert.equal(await BrandAmbassadorPayout.countDocuments({}), 1);

    // Paid out: no longer payable, and nothing left to record for October.
    const detail = (await req('GET', `/api/admin/ambassadors/${amb._id}`, adminToken)).body.data.ambassador;
    assert.equal(detail.commissionPaid, 3 * 475);
    assert.equal(detail.commissionPayable, 427); // only November's line is still payable
    assert.equal((await req('POST', path, adminToken, body)).status, 409);

    const logs = await BrandAmbassadorActivity.find({ action: 'payout_processed' }).sort({ at: 1 }).lean();
    assert.equal(logs.length, 2);
    assert.equal(String(logs[1].actorId), String(admin._id));
    assert.deepEqual(logs[1].before, { status: 'processing', reference: 'UTR123456' });
  } finally {
    setNow(null);
  }
});
