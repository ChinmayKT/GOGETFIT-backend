import mongoose from 'mongoose';

import CartItem from '../models/cart-item.model.js';
import Coach from '../models/coach.model.js';
import Coupon from '../models/coupon.model.js';
import EnrolledClient from '../models/enrolled-client.model.js';
import GogetfitPlan, { PLAN_CURRENCY } from '../models/gogetfit-plan.model.js';
import User from '../models/user.model.js';
import { getCouponStatus } from '../utils/coupon-status.js';
import { ERROR_CODES, badRequest, conflict, notFound } from '../utils/errors.js';
import { priceAfterCoupon } from './enrolled-client.service.js';
import { toMemberCoach } from './coach.service.js';
import { toMemberPlan } from './gogetfit-plan.service.js';

/**
 * The member's cart, and the purchase that turns a cart item into an enrollment.
 *
 * Everything that decides money is decided here, on the server: the plan price
 * comes from the plan, the discount from the coupon, the total from
 * `priceAfterCoupon` - the same integer-truncating rule the admin enrollment and
 * the legacy checkout use. Nothing the app sends about price or discount is read.
 */

const iso = (date) => (date ? new Date(date).toISOString() : null);

const toImageRef = (image) => (image?.url ? { url: image.url, storageKey: image.storageKey ?? null } : null);

/** What the cart and checkout screens show for one item. */
export const toCartItem = (doc, pricing = null) => ({
  id: String(doc._id),
  status: doc.status,
  addedAt: iso(doc.addedAt),
  updatedAt: iso(doc.updatedAt),
  /**
   * The coach and the plan in exactly the shapes the member API already serves
   * them in (`GET /coaches` and `GET /coaches/:id/plans`), produced by those
   * same mappers. The app parses a cart line with the models it already has,
   * and the two surfaces cannot drift apart.
   */
  coach: doc.coachId ? toMemberCoach(doc.coachId, doc.coachId.userId) : null,
  plan: doc.planId ? toMemberPlan(doc.planId) : null,
  /** The live price, flattened for convenience; the same figure as plan.pricing.basePrice. */
  price: doc.planId?.pricing?.basePrice ?? null,
  currency: PLAN_CURRENCY,
  pricing,
});

const POPULATE = [
  {
    path: 'coachId',
    populate: { path: 'userId', select: 'profile.name profile.gender profile.city profile.email phone' },
  },
  { path: 'planId' },
];

/**
 * The rules a coach + plan pair must satisfy to be bought. Identical to the
 * admin enrollment's checks, because a member buying a plan and an admin
 * recording the same purchase must not be able to disagree.
 *
 * @param session optional - passed when running inside the purchase transaction
 */
export const assertPurchasable = async ({ coachId, planId }, session = null) => {
  const q = (query) => (session ? query.session(session) : query);

  const plan = await q(GogetfitPlan.findById(planId)).lean();
  if (!plan) throw notFound(ERROR_CODES.GOGETFIT_PLAN_NOT_FOUND, 'Plan not found');
  if (plan.status !== 'active' || plan.deletedAt) {
    throw badRequest(ERROR_CODES.GOGETFIT_PLAN_INACTIVE, 'This plan is no longer available');
  }

  const coach = await q(Coach.findById(coachId)).lean();
  if (!coach) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'Coach not found');
  if (coach.status !== 'active') throw badRequest(ERROR_CODES.COACH_INACTIVE, 'This coach is not available');

  const coachUser = await q(User.findById(coach.userId, { status: 1 })).lean();
  if (!coachUser || coachUser.status !== 'active') {
    throw badRequest(ERROR_CODES.COACH_INACTIVE, "This coach's account is not active");
  }

  // A coach offers exactly the active plans of their own level.
  if (plan.coachLevel && plan.coachLevel !== coach.profile?.level) {
    throw badRequest(
      ERROR_CODES.PLAN_NOT_OFFERED_BY_COACH,
      `This coach (${coach.profile?.level ?? 'no level'}) does not offer ${plan.coachLevel} plans`,
    );
  }

  return { plan, coach };
};

/**
 * A coupon the member may actually use: public, not deleted, and active by
 * today's calendar date. A private coupon is never offered to a member - it is
 * the admin's to apply.
 */
export const resolveMemberCoupon = async (couponId, { code = null, session = null, at = new Date() } = {}) => {
  if (!couponId && !code) return null;

  const filter = couponId
    ? { _id: couponId }
    : { code: String(code).trim().toUpperCase() };

  const query = Coupon.findOne(filter);
  const coupon = await (session ? query.session(session) : query).lean();

  if (!coupon) throw notFound(ERROR_CODES.COUPON_NOT_FOUND, 'Coupon not found');
  if (coupon.visibility !== 'public') {
    // Not "forbidden": a member must not learn that a private code exists.
    throw notFound(ERROR_CODES.COUPON_NOT_FOUND, 'Coupon not found');
  }
  if (getCouponStatus(coupon.validFrom, coupon.validTo, at) !== 'active') {
    throw badRequest(ERROR_CODES.COUPON_INACTIVE, `Coupon ${coupon.code} is not valid today`);
  }
  return coupon;
};

/** The member's cart: active items only, newest first. */
export const listCart = async (userId) => {
  const docs = await CartItem.find({ userId, status: 'active' })
    .sort({ addedAt: -1, _id: -1 })
    .populate(POPULATE)
    .lean();

  const items = docs.map((doc) => toCartItem(doc));
  const subtotal = items.reduce((sum, item) => sum + (item.price ?? 0), 0);

  return { items, count: items.length, subtotal, currency: PLAN_CURRENCY };
};

/**
 * Adds a coach + plan to the cart. The unique partial index is what actually
 * prevents a duplicate - two taps in the same moment both pass a read check, so
 * the duplicate key error is caught and reported rather than prevented by reading.
 */
export const addToCart = async (userId, { coachId, planId }) => {
  await assertPurchasable({ coachId, planId });

  try {
    const created = await CartItem.create({ userId, coachId, planId, status: 'active', addedAt: new Date() });
    const doc = await CartItem.findById(created._id).populate(POPULATE).lean();
    return toCartItem(doc);
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict(ERROR_CODES.CART_ITEM_EXISTS, 'This plan is already in your cart');
    }
    throw error;
  }
};

/**
 * Removes one item. Scoped by userId in the query itself, so one member can
 * never remove another's item - a wrong id is simply "not found".
 */
export const removeFromCart = async (userId, cartItemId) => {
  if (!mongoose.isValidObjectId(cartItemId)) return null;

  const doc = await CartItem.findOneAndUpdate(
    { _id: cartItemId, userId, status: 'active' },
    { $set: { status: 'removed', removedAt: new Date() } },
    { new: true },
  )
    .populate(POPULATE)
    .lean();

  return doc ? toCartItem(doc) : null;
};

/** Coupons a member may choose at checkout: public and active today. */
export const listMemberCoupons = async (at = new Date()) => {
  const docs = await Coupon.find({ visibility: 'public' }, { code: 1, description: 1, discount: 1, validFrom: 1, validTo: 1 })
    .sort({ 'discount.value': -1, code: 1 })
    .lean();

  return docs
    .filter((c) => getCouponStatus(c.validFrom, c.validTo, at) === 'active')
    .map((c) => ({
      id: String(c._id),
      code: c.code,
      description: c.description ?? null,
      discountPercent: c.discount?.value ?? 0,
      validTo: iso(c.validTo),
    }));
};

/**
 * The authoritative total for one cart item, with an optional coupon. The app
 * displays what this returns and never computes a discount of its own.
 */
export const quoteCartItem = async (userId, cartItemId, { couponId = null, couponCode = null, at = new Date() } = {}) => {
  if (!mongoose.isValidObjectId(cartItemId)) return null;

  const item = await CartItem.findOne({ _id: cartItemId, userId, status: 'active' }).lean();
  if (!item) return null;

  const { plan } = await assertPurchasable({ coachId: item.coachId, planId: item.planId });
  const coupon = await resolveMemberCoupon(couponId, { code: couponCode, at });
  const pricing = priceAfterCoupon(plan.pricing.basePrice, coupon?.discount?.value ?? 0);

  const doc = await CartItem.findById(item._id).populate(POPULATE).lean();
  return toCartItem(doc, {
    ...pricing,
    currency: PLAN_CURRENCY,
    coupon: coupon ? { id: String(coupon._id), code: coupon.code, discountPercent: coupon.discount?.value ?? 0 } : null,
  });
};

/**
 * Turns one cart item into an enrollment.
 *
 * Everything runs in a single transaction: the coach, plan and coupon are
 * re-validated at this moment (not when the item was added), the price is
 * recomputed from the plan, the enrollment is created and the cart item is
 * marked purchased. A failure anywhere leaves the cart exactly as it was and
 * creates no enrollment.
 *
 * Idempotent on `paymentReference`: a retried request returns the enrollment the
 * first one created instead of making a second. That reference is the payment
 * gateway's own id, so a double-tap, a lost response or a webhook replay all
 * resolve to one enrollment.
 */
export const purchaseCartItem = async (
  userId,
  cartItemId,
  { couponId = null, couponCode = null, paymentReference, paymentMethod = null, at = new Date() },
) => {
  if (!mongoose.isValidObjectId(cartItemId)) return null;
  if (!paymentReference) throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'paymentReference is required');

  // Outside the transaction: a retry must answer from the committed state.
  const alreadyPaid = await EnrolledClient.findOne({ userId, 'payment.transactionId': paymentReference }).lean();
  if (alreadyPaid) {
    return { enrolledClientId: String(alreadyPaid._id), idempotent: true };
  }

  const session = await mongoose.startSession();
  let createdId = null;
  let pricing = null;

  try {
    await session.withTransaction(async () => {
      const item = await CartItem.findOne({ _id: cartItemId, userId }).session(session).lean();
      if (!item) throw notFound(ERROR_CODES.CART_ITEM_NOT_FOUND, 'Cart item not found');

      if (item.status === 'purchased') {
        // A row left by the earlier "mark as purchased" behaviour.
        createdId = item.enrolledClientId;
        return;
      }
      if (item.status !== 'active') throw badRequest(ERROR_CODES.CART_ITEM_NOT_ACTIVE, 'This cart item is no longer active');

      const user = await User.findById(userId, { status: 1, profile: 1, phone: 1 }).session(session).lean();
      if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
      if (user.status !== 'active') throw badRequest(ERROR_CODES.USER_INACTIVE, `User is ${user.status ?? 'not active'}`);

      // Re-validated now, not when the item went into the cart.
      const { plan, coach } = await assertPurchasable({ coachId: item.coachId, planId: item.planId }, session);
      const coupon = await resolveMemberCoupon(couponId, { code: couponCode, session, at });

      pricing = priceAfterCoupon(plan.pricing.basePrice, coupon?.discount?.value ?? 0);

      const [enrollment] = await EnrolledClient.create(
        [
          {
            userId: user._id,
            planId: plan._id,
            coachId: coach._id,
            couponId: coupon?._id ?? null,
            enrollDate: at,
            // Set when the member starts the plan, exactly as the legacy flow did.
            startDate: null,
            endDate: null,
            hasStarted: false,
            isDeleted: false,
            payment: {
              transactionId: paymentReference,
              amount: pricing.finalAmount,
              currency: PLAN_CURRENCY,
              originalAmount: pricing.originalAmount,
              discountPercent: pricing.discountPercent,
              status: 'Success',
              paidAt: at,
              description: 'Member purchase from the app',
              method: paymentMethod ?? undefined,
              customerName: user.profile?.name ?? null,
              contact: user.phone?.normalized ?? null,
              email: user.profile?.email ?? null,
              updatedAt: at,
            },
            // No `source`: that marks an admin manual enrollment, and this is not one.
            createdBy: user._id,
            updatedBy: user._id,
          },
        ],
        { session },
      );

      // Once bought, the cart item is DELETED from the database - the
      // enrollment is now the record of the purchase. Same transaction as the
      // enrollment, so it is never both "in cart" and enrolled, and if either
      // write fails neither happens. A second concurrent purchase of the same
      // item finds nothing to delete and aborts.
      const removed = await CartItem.deleteOne({ _id: item._id, userId, status: 'active' }, { session });
      if (removed.deletedCount !== 1) {
        throw badRequest(ERROR_CODES.CART_ITEM_NOT_ACTIVE, 'This cart item is no longer active');
      }

      createdId = enrollment._id;
    });
  } finally {
    await session.endSession();
  }

  return { enrolledClientId: String(createdId), pricing, idempotent: false };
};
