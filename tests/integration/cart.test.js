import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import User from '../../src/models/user.model.js';
import Coach from '../../src/models/coach.model.js';
import Coupon from '../../src/models/coupon.model.js';
import CartItem from '../../src/models/cart-item.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let member;
let memberToken;
let otherMember;
let otherToken;
let admin;
let adminToken;
let coach;
let plan;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const seedUser = (phone, roles = ['user']) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `User ${phone}` }, roles, status: 'active' });

/** A coach is a User plus a Coach profile; the display name stays on the User. */
const seedCoach = async (level = 'LEVEL 1') => {
  const coachUser = await User.create({
    phone: { raw: '917000000001', normalized: '917000000001' },
    profile: { name: 'Coach Prajwal' },
    roles: ['user', 'coach'],
    status: 'active',
  });
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

const day = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const seedCoupon = (overrides = {}) =>
  Coupon.create({
    code: 'SAVE10',
    discount: { type: 'percent', value: 10 },
    validFrom: day(-5),
    validTo: day(5),
    visibility: 'public',
    createdBy: admin._id,
    updatedBy: admin._id,
    ...overrides,
  });

const addToCart = (body, token = memberToken) => server.request('POST', '/api/users/me/cart', { token, body });
const getCart = (token = memberToken) => server.request('GET', '/api/users/me/cart', { token });

before(async () => {
  await connectTestDb();
  await CartItem.syncIndexes();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  await CartItem.deleteMany({});
  admin = await seedUser('918000000000', ['user', 'admin']);
  adminToken = tokenFor(admin);
  member = await seedUser('919000000001');
  memberToken = tokenFor(member);
  otherMember = await seedUser('919000000002');
  otherToken = tokenFor(otherMember);
  coach = await seedCoach();
  plan = await seedPlan();
});

after(async () => {
  await CartItem.deleteMany({});
  await server.close();
  await disconnectTestDb();
});

// ─── cart ────────────────────────────────────────────────────────────────────

test('every cart route requires authentication', async () => {
  for (const [method, path] of [
    ['GET', '/api/users/me/cart'],
    ['POST', '/api/users/me/cart'],
    ['DELETE', '/api/users/me/cart/000000000000000000000000'],
    ['GET', '/api/users/me/coupons'],
  ]) {
    const res = await server.request(method, path, {});
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('an authenticated member can add a valid plan and read it back', async () => {
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  assert.equal(added.status, 201);
  // The coach and plan arrive in the same shapes GET /coaches and
  // GET /coaches/:id/plans serve, so the app parses them with its own models.
  assert.equal(added.body.data.item.plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.equal(added.body.data.item.plan.pricing.basePrice, 4999);
  assert.equal(added.body.data.item.price, 4999);
  assert.equal(added.body.data.item.coach.user.name, 'Coach Prajwal');

  const cart = await getCart();
  assert.equal(cart.body.data.count, 1);
  assert.equal(cart.body.data.subtotal, 4999);
  assert.equal(cart.body.data.items[0].status, 'active');
});

test('the cart is owned by the token, not by anything the client sends', async () => {
  const res = await addToCart({ coachId: String(coach._id), planId: String(plan._id), userId: String(otherMember._id) });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /not accepted from the client/);
});

test('a duplicate active cart entry is refused', async () => {
  await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  const again = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });

  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'CART_ITEM_EXISTS');
  assert.equal(await CartItem.countDocuments({ userId: member._id, status: 'active' }), 1);
});

test('two members may hold the same plan at once', async () => {
  assert.equal((await addToCart({ coachId: String(coach._id), planId: String(plan._id) })).status, 201);
  assert.equal((await addToCart({ coachId: String(coach._id), planId: String(plan._id) }, otherToken)).status, 201);
  assert.equal(await CartItem.countDocuments({ status: 'active' }), 2);
});

test('one member cannot see or remove another member\'s cart', async () => {
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  const id = added.body.data.item.id;

  const otherCart = await getCart(otherToken);
  assert.equal(otherCart.body.data.count, 0);

  const removal = await server.request('DELETE', `/api/users/me/cart/${id}`, { token: otherToken });
  assert.equal(removal.status, 404);
  assert.equal(await CartItem.countDocuments({ _id: id, status: 'active' }), 1);
});

test('a member can remove their own item, and it leaves the cart', async () => {
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  const removal = await server.request('DELETE', `/api/users/me/cart/${added.body.data.item.id}`, { token: memberToken });

  assert.equal(removal.status, 200);
  assert.equal((await getCart()).body.data.count, 0);
  // Kept, not deleted - the sales history of what was considered stays readable.
  const doc = await CartItem.findById(added.body.data.item.id).lean();
  assert.equal(doc.status, 'removed');
  assert.ok(doc.removedAt);
});

test('an archived plan, an inactive coach and a mismatched level are all refused', async () => {
  const archived = await seedPlan({ name: 'Archived plan', status: 'archived' });
  const archivedRes = await addToCart({ coachId: String(coach._id), planId: String(archived._id) });
  assert.equal(archivedRes.status, 400);
  assert.equal(archivedRes.body.error.code, 'GOGETFIT_PLAN_INACTIVE');

  const wrongLevel = await seedPlan({ name: 'Level 3 plan', coachLevel: 'LEVEL 3' });
  const levelRes = await addToCart({ coachId: String(coach._id), planId: String(wrongLevel._id) });
  assert.equal(levelRes.status, 400);
  assert.equal(levelRes.body.error.code, 'PLAN_NOT_OFFERED_BY_COACH');

  await Coach.updateOne({ _id: coach._id }, { $set: { status: 'inactive' } });
  const coachRes = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  assert.equal(coachRes.status, 400);
  assert.equal(coachRes.body.error.code, 'COACH_INACTIVE');

  assert.equal(await CartItem.countDocuments({}), 0);
});

test('an unknown plan or coach is a 404', async () => {
  const unknownPlan = await addToCart({ coachId: String(coach._id), planId: String(new mongoose.Types.ObjectId()) });
  assert.equal(unknownPlan.status, 404);

  const unknownCoach = await addToCart({ coachId: String(new mongoose.Types.ObjectId()), planId: String(plan._id) });
  assert.equal(unknownCoach.status, 404);
});

// ─── coupons ─────────────────────────────────────────────────────────────────

test('only public, currently valid coupons are offered to a member', async () => {
  await seedCoupon({ code: 'SAVE10' });
  await seedCoupon({ code: 'EXPIRED', validFrom: day(-20), validTo: day(-10) });
  await seedCoupon({ code: 'FUTURE', validFrom: day(10), validTo: day(20) });
  await seedCoupon({ code: 'PRIVATE', visibility: 'private' });

  const res = await server.request('GET', '/api/users/me/coupons', { token: memberToken });
  const codes = res.body.data.coupons.map((c) => c.code);

  assert.deepEqual(codes, ['SAVE10']);
  for (const hidden of ['EXPIRED', 'FUTURE', 'PRIVATE']) assert.ok(!codes.includes(hidden), `${hidden} must not be offered`);
});

test('the backend calculates the discount; the client cannot supply one', async () => {
  const coupon = await seedCoupon();
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  const id = added.body.data.item.id;

  const quote = await server.request('POST', `/api/users/me/cart/${id}/quote`, {
    token: memberToken,
    body: { couponId: String(coupon._id) },
  });

  assert.equal(quote.status, 200);
  // 4999 at 10% truncates to 499, the legacy integer rule.
  assert.deepEqual(
    {
      originalAmount: quote.body.data.item.pricing.originalAmount,
      discountAmount: quote.body.data.item.pricing.discountAmount,
      finalAmount: quote.body.data.item.pricing.finalAmount,
    },
    { originalAmount: 4999, discountAmount: 499, finalAmount: 4500 },
  );

  const spoofed = await server.request('POST', `/api/users/me/cart/${id}/quote`, {
    token: memberToken,
    body: { couponId: String(coupon._id), discountAmount: 4999 },
  });
  assert.equal(spoofed.status, 400);
});

test('an expired or private coupon cannot be applied', async () => {
  const expired = await seedCoupon({ code: 'EXPIRED', validFrom: day(-20), validTo: day(-10) });
  const privateCoupon = await seedCoupon({ code: 'PRIVATE', visibility: 'private' });
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  const id = added.body.data.item.id;

  const expiredRes = await server.request('POST', `/api/users/me/cart/${id}/quote`, {
    token: memberToken, body: { couponId: String(expired._id) },
  });
  assert.equal(expiredRes.status, 400);
  assert.equal(expiredRes.body.error.code, 'COUPON_INACTIVE');

  // A private coupon is "not found" rather than "forbidden": a member must not
  // learn that the code exists.
  const privateRes = await server.request('POST', `/api/users/me/cart/${id}/quote`, {
    token: memberToken, body: { couponId: String(privateCoupon._id) },
  });
  assert.equal(privateRes.status, 404);
});

// ─── purchase ────────────────────────────────────────────────────────────────

const purchase = (id, body, token = memberToken) =>
  server.request('POST', `/api/users/me/cart/${id}/purchase`, { token, body });

test('a successful purchase creates exactly one enrollment and empties the item from the cart', async () => {
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  const id = added.body.data.item.id;

  const res = await purchase(id, { paymentReference: 'pay_test_0001' });
  assert.equal(res.status, 201);

  const enrollments = await EnrolledClient.find({ userId: member._id }).lean();
  assert.equal(enrollments.length, 1);
  assert.equal(String(enrollments[0].planId), String(plan._id));
  assert.equal(String(enrollments[0].coachId), String(coach._id));
  assert.equal(enrollments[0].payment.transactionId, 'pay_test_0001');
  assert.equal(enrollments[0].payment.amount, 4999);
  // Not an admin manual enrollment.
  assert.equal(enrollments[0].source, undefined);

  // Out of the cart AND out of the database: the enrollment is the record now.
  assert.equal((await getCart()).body.data.count, 0);
  assert.equal(await CartItem.findById(id).lean(), null);
  assert.equal(await CartItem.countDocuments({ userId: member._id }), 0);

  // A retry with the same payment reference still returns the same enrollment.
  const retry = await purchase(id, { paymentReference: 'pay_test_0001' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.idempotent, true);
  assert.equal(retry.body.data.enrolledClient.id, String(enrollments[0]._id));
  assert.equal(await EnrolledClient.countDocuments({ userId: member._id }), 1);
});

test('a failed purchase leaves the cart item in the cart (and in the database)', async () => {
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  const id = added.body.data.item.id;
  // The plan is archived between adding to cart and paying.
  await GogetfitPlan.updateOne({ _id: plan._id }, { $set: { status: 'archived' } });

  const res = await purchase(id, { paymentReference: 'pay_test_fail' });
  assert.ok(res.status >= 400);
  assert.equal(await EnrolledClient.countDocuments({ userId: member._id }), 0);
  assert.equal((await CartItem.findById(id).lean()).status, 'active');
});

test('the purchase price comes from the plan and the coupon, not from the client', async () => {
  const coupon = await seedCoupon();
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });

  const res = await purchase(added.body.data.item.id, {
    paymentReference: 'pay_test_0002',
    couponId: String(coupon._id),
  });

  assert.equal(res.status, 201);
  const enrollment = await EnrolledClient.findOne({ userId: member._id }).lean();
  assert.equal(enrollment.payment.amount, 4500);
  assert.equal(enrollment.payment.originalAmount, 4999);
  assert.equal(enrollment.payment.discountPercent, 10);
  assert.equal(String(enrollment.couponId), String(coupon._id));
});

test('a retried purchase is idempotent: one enrollment, not two', async () => {
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  const id = added.body.data.item.id;

  const first = await purchase(id, { paymentReference: 'pay_retry_me' });
  const second = await purchase(id, { paymentReference: 'pay_retry_me' });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.idempotent, true);
  assert.equal(await EnrolledClient.countDocuments({ userId: member._id }), 1);
});

test('a purchase without a payment reference is refused and creates nothing', async () => {
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  const res = await purchase(added.body.data.item.id, {});

  assert.equal(res.status, 400);
  assert.equal(await EnrolledClient.countDocuments({}), 0);
  // The failure left the cart alone.
  assert.equal((await getCart()).body.data.count, 1);
});

test('a purchase that fails validation leaves no enrollment and does not empty the cart', async () => {
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  const id = added.body.data.item.id;

  // The plan is archived between adding and paying.
  await GogetfitPlan.updateOne({ _id: plan._id }, { $set: { status: 'archived' } });

  const res = await purchase(id, { paymentReference: 'pay_test_0003' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'GOGETFIT_PLAN_INACTIVE');

  assert.equal(await EnrolledClient.countDocuments({}), 0);
  const item = await CartItem.findById(id).lean();
  assert.equal(item.status, 'active');
});

test('one member cannot purchase another member\'s cart item', async () => {
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  const res = await purchase(added.body.data.item.id, { paymentReference: 'pay_theft' }, otherToken);

  assert.equal(res.status, 404);
  assert.equal(await EnrolledClient.countDocuments({}), 0);
});

test('a member may buy the same plan again later, and the old enrollment survives', async () => {
  const first = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  await purchase(first.body.data.item.id, { paymentReference: 'pay_cycle_1' });

  // The unique index only covers active items, so the plan can go back in the cart.
  const second = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  assert.equal(second.status, 201);
  await purchase(second.body.data.item.id, { paymentReference: 'pay_cycle_2' });

  const enrollments = await EnrolledClient.find({ userId: member._id }).sort({ createdAt: 1 }).lean();
  assert.equal(enrollments.length, 2);
  assert.notEqual(String(enrollments[0]._id), String(enrollments[1]._id));
  assert.equal(enrollments[0].payment.transactionId, 'pay_cycle_1');
});

// ─── admin "In cart" ─────────────────────────────────────────────────────────

const inCart = (qs = '', token = adminToken) => server.request('GET', `/api/admin/cart-items${qs}`, { token });

test('In cart lists unpurchased items only, with the member joined for display', async () => {
  await addToCart({ coachId: String(coach._id), planId: String(plan._id) });

  const res = await inCart();
  assert.equal(res.status, 200);
  assert.equal(res.body.data.pagination.total, 1);

  const [row] = res.body.data.cartItems;
  assert.equal(row.user.phone, '919000000001');
  assert.equal(row.plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.equal(row.plan.price, 4999);
  assert.equal(row.coach.name, 'Coach Prajwal');
  assert.ok(row.addedAt);
});

test('a purchased item disappears from In cart by itself', async () => {
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  assert.equal((await inCart()).body.data.pagination.total, 1);

  await purchase(added.body.data.item.id, { paymentReference: 'pay_moves_out' });

  assert.equal((await inCart()).body.data.pagination.total, 0);
  // ... and it is now an enrollment the admin list can see.
  const enrollments = await server.request('GET', '/api/admin/enrolled-clients', { token: adminToken });
  assert.equal(enrollments.body.data.pagination.total, 1);
});

test('a removed item also leaves In cart', async () => {
  const added = await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  await server.request('DELETE', `/api/users/me/cart/${added.body.data.item.id}`, { token: memberToken });
  assert.equal((await inCart()).body.data.pagination.total, 0);
});

test('In cart supports search and coach/plan filters', async () => {
  await addToCart({ coachId: String(coach._id), planId: String(plan._id) });
  await addToCart({ coachId: String(coach._id), planId: String(plan._id) }, otherToken);

  assert.equal((await inCart('?search=919000000001')).body.data.pagination.total, 1);
  assert.equal((await inCart(`?coachId=${coach._id}`)).body.data.pagination.total, 2);
  assert.equal((await inCart(`?planId=${new mongoose.Types.ObjectId()}`)).body.data.pagination.total, 0);
  assert.equal((await inCart('?search=nobody')).body.data.pagination.total, 0);

  const badSort = await inCart('?sortKey=evil');
  assert.equal(badSort.status, 400);
});

test('In cart is admin-only', async () => {
  assert.equal((await inCart('', memberToken)).status, 403);
  assert.equal((await server.request('GET', '/api/admin/cart-items', {})).status, 401);
});
