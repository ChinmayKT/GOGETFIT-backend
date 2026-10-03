import mongoose from 'mongoose';

import Coach from '../models/coach.model.js';
import Coupon from '../models/coupon.model.js';
import EnrolledClient, { ENROLLMENT_SOURCE_ADMIN_MANUAL, enrollmentStatus } from '../models/enrolled-client.model.js';
import GogetfitPlan from '../models/gogetfit-plan.model.js';
import User from '../models/user.model.js';
import { now as clockNow } from '../utils/clock.js';
import { getCouponStatus } from '../utils/coupon-status.js';
import { ERROR_CODES, badRequest, notFound } from '../utils/errors.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sort keys the portal may request, mapped to real paths. An arbitrary client
 * string never reaches Mongo as a sort field.
 */
const SORTABLE = {
  enrollDate: 'enrollDate',
  startDate: 'startDate',
  endDate: 'endDate',
  amount: 'payment.amount',
  createdAt: 'createdAt',
};

/**
 * The display join. Relationships are ids on the document; the names the list
 * shows are looked up here, so nothing is duplicated into the enrollment.
 *
 * Each $lookup takes only the fields the list needs - a coach's user is joined
 * one level deeper because a Coach document has no name of its own.
 */
export const LOOKUP_STAGES = [
  {
    $lookup: {
      from: 'users',
      localField: 'userId',
      foreignField: '_id',
      as: 'user',
      pipeline: [
        {
          $project: {
            'profile.name': 1,
            'profile.email': 1,
            'profile.profilePicture': 1,
            'phone.normalized': 1,
            'legacy.userId': 1,
            roles: 1,
          },
        },
      ],
    },
  },
  {
    $lookup: {
      from: 'gogetfitplans',
      localField: 'planId',
      foreignField: '_id',
      as: 'plan',
      pipeline: [
        { $project: { name: 1, planType: 1, durationWeeks: 1, image: 1, 'legacy.packageId': 1 } },
      ],
    },
  },
  {
    $lookup: {
      from: 'coaches',
      localField: 'coachId',
      foreignField: '_id',
      as: 'coach',
      pipeline: [
        { $project: { userId: 1, 'profile.level': 1, 'profile.profilePicture': 1 } },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            as: 'user',
            pipeline: [{ $project: { 'profile.name': 1 } }],
          },
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      ],
    },
  },
  {
    $lookup: {
      from: 'coupons',
      localField: 'couponId',
      foreignField: '_id',
      as: 'coupon',
      pipeline: [{ $project: { code: 1, 'discount.value': 1, 'legacy.couponId': 1 } }],
    },
  },
  { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
  { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
  { $unwind: { path: '$coach', preserveNullAndEmptyArrays: true } },
  { $unwind: { path: '$coupon', preserveNullAndEmptyArrays: true } },
];

/**
 * One row for the admin list. Allow-listed: a field added to the schema later
 * stays invisible until somebody exposes it deliberately.
 *
 * Only what the migrated data actually supports is exposed. The legacy coach id
 * is included precisely because most rows have no resolved coach, and the
 * portal has to be able to say so rather than show a blank.
 */
export const toListRow = (doc, now = new Date()) => ({
  id: String(doc._id),
  status: enrollmentStatus(doc, now),
  client: doc.user
    ? {
        id: String(doc.user._id),
        name: doc.user.profile?.name ?? null,
        phone: doc.user.phone?.normalized ?? null,
        email: doc.user.profile?.email ?? null,
        /** The member's own photo URL, or null (the portal falls back to initials). */
        profilePicture: doc.user.profile?.profilePicture ?? null,
        legacyUserId: doc.user.legacy?.userId ?? null,
      }
    : null,
  coach: doc.coach
    ? {
        id: String(doc.coach._id),
        name: doc.coach.user?.profile?.name ?? null,
        level: doc.coach.profile?.level ?? null, // a coach's level lives under profile
        /** The coach's own professional photo URL (not their user avatar), or null. */
        profilePicture: doc.coach.profile?.profilePicture?.url ?? null,
      }
    : null,
  /** Preserved for every row, resolved or not: the legacy coach relationship. */
  legacyCoachId: doc.legacy?.coachId ?? null,
  /**
   * The coach's name as the legacy system held it. Most migrated enrollments
   * have no Coach document, so this is what a screen shows instead of an id.
   */
  legacyCoachName: doc.legacy?.coachName ?? null,
  plan: doc.plan
    ? {
        id: String(doc.plan._id),
        name: doc.plan.name ?? null,
        planType: doc.plan.planType ?? null,
        durationWeeks: doc.plan.durationWeeks ?? null,
      }
    : null,
  coupon: doc.coupon
    ? { id: String(doc.coupon._id), code: doc.coupon.code ?? null }
    : null,
  /** What was typed at checkout, even when it resolved to no coupon document. */
  legacyCouponCode: doc.legacy?.couponCode ?? null,
  transactionId: doc.payment?.transactionId ?? null,
  amount: doc.payment?.amount ?? null,
  currency: doc.payment?.currency ?? null,
  paymentStatus: doc.payment?.status ?? null,
  enrollDate: doc.enrollDate ? doc.enrollDate.toISOString() : null,
  startDate: doc.startDate ? doc.startDate.toISOString() : null,
  endDate: doc.endDate ? doc.endDate.toISOString() : null,
  hasStarted: Boolean(doc.hasStarted),
  legacyEnrollmentId: doc.legacy?.enrollmentId ?? null,
  /** 'admin_manual' for portal-created rows; null on migrated rows. */
  source: doc.source ?? null,
  /** How a manual payment was collected; null for gateway/migrated payments. */
  paymentMethod: doc.payment?.method ?? null,
  /** A manual payment's receipt / UTR / bank reference. */
  paymentReference: doc.payment?.referenceId ?? null,
});

/** The detail view: the list row plus everything else the purchase recorded. */
export const toDetail = (doc, now = new Date()) => ({
  ...toListRow(doc, now),
  isDeleted: Boolean(doc.isDeleted),
  payment: {
    transactionId: doc.payment?.transactionId ?? null,
    amount: doc.payment?.amount ?? null,
    currency: doc.payment?.currency ?? null,
    originalAmount: doc.payment?.originalAmount ?? null,
    discountPercent: doc.payment?.discountPercent ?? null,
    status: doc.payment?.status ?? null,
    paidAt: doc.payment?.paidAt ? doc.payment.paidAt.toISOString() : null,
    referenceId: doc.payment?.referenceId ?? null,
    description: doc.payment?.description ?? null,
    method: doc.payment?.method ?? null,
    notes: doc.payment?.notes ?? null,
    customerName: doc.payment?.customerName ?? null,
    contact: doc.payment?.contact ?? null,
    email: doc.payment?.email ?? null,
  },
  legacy: doc.legacy
    ? {
        source: doc.legacy.source ?? null,
        enrollmentId: doc.legacy.enrollmentId ?? null,
        userId: doc.legacy.userId ?? null,
        packageId: doc.legacy.packageId ?? null,
        coachId: doc.legacy.coachId ?? null,
        coachResolvedBy: doc.legacy.coachResolvedBy ?? null,
        coachName: doc.legacy.coachName ?? null,
        coachEmail: doc.legacy.coachEmail ?? null,
        couponCode: doc.legacy.couponCode ?? null,
        couponUnresolvedReason: doc.legacy.couponUnresolvedReason ?? null,
        enrollmentAmount: doc.legacy.enrollmentAmount ?? null,
        createdBy: doc.legacy.createdBy ?? null,
        updatedAt: doc.legacy.updatedAt ? doc.legacy.updatedAt.toISOString() : null,
        updatedBy: doc.legacy.updatedBy ?? null,
      }
    : null,
  createdBy: doc.createdBy ? String(doc.createdBy) : null,
  createdAt: doc.createdAt ? doc.createdAt.toISOString() : null,
  updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
});

/**
 * Filters applied before the join, so the lookups only run on the page being
 * returned rather than on the whole collection.
 */
export const buildMatch = ({ userId, coachId, planId, couponId, status, hasStarted } = {}, now = new Date()) => {
  const match = {};

  if (userId && mongoose.isValidObjectId(userId)) match.userId = new mongoose.Types.ObjectId(userId);
  if (coachId && mongoose.isValidObjectId(coachId)) match.coachId = new mongoose.Types.ObjectId(coachId);
  if (planId && mongoose.isValidObjectId(planId)) match.planId = new mongoose.Types.ObjectId(planId);
  if (couponId && mongoose.isValidObjectId(couponId)) match.couponId = new mongoose.Types.ObjectId(couponId);
  if (hasStarted !== undefined) match.hasStarted = hasStarted;

  // The legacy status rule, expressed as a query so it can be paginated:
  // active = started and not past its end date, inactive = started and past it.
  if (status === 'deleted') match.isDeleted = true;
  else if (status === 'not_started') Object.assign(match, { isDeleted: { $ne: true }, hasStarted: false });
  else if (status === 'active') {
    Object.assign(match, { isDeleted: { $ne: true }, hasStarted: true, endDate: { $gte: now } });
  } else if (status === 'inactive') {
    Object.assign(match, { isDeleted: { $ne: true }, hasStarted: true, endDate: { $lt: now } });
  }

  return match;
};

/**
 * One page of enrollments with their related documents resolved.
 *
 * Always paginated and always capped; the search term is matched against the
 * transaction id and the joined client's name/phone, which is what the legacy
 * admin list showed.
 */
export const listEnrolledClients = async (params = {}, now = new Date()) => {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);

  const sortField = SORTABLE[params.sortKey] ?? SORTABLE.enrollDate;
  const sortDir = params.sortDir === 'asc' ? 1 : -1;

  const match = buildMatch(params, now);
  const term = String(params.search ?? '').trim();

  const pipeline = [{ $match: match }];

  if (term !== '') {
    const rx = new RegExp(escapeRegex(term), 'i');
    // Transaction id is on the document, so it can be matched before the join;
    // name and phone need the join, so the rest is matched after it.
    pipeline.push(...LOOKUP_STAGES, {
      $match: {
        $or: [
          { 'payment.transactionId': rx },
          { 'payment.referenceId': rx },
          { 'user.profile.name': rx },
          { 'legacy.coachName': rx },
          { 'user.phone.normalized': rx },
          { 'legacy.couponCode': rx },
        ],
      },
    });
  } else {
    pipeline.push(...LOOKUP_STAGES);
  }

  pipeline.push({
    $facet: {
      rows: [{ $sort: { [sortField]: sortDir, _id: 1 } }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }],
      total: [{ $count: 'count' }],
    },
  });

  const [result] = await EnrolledClient.aggregate(pipeline);
  const total = result?.total?.[0]?.count ?? 0;

  return {
    rows: (result?.rows ?? []).map((doc) => toListRow(doc, now)),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

export const getEnrolledClientById = async (id, now = new Date()) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const [doc] = await EnrolledClient.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(id) } },
    ...LOOKUP_STAGES,
  ]);

  return doc ? toDetail(doc, now) : null;
};

// --- Admin manual enrollment (Add Client) ------------------------------------------------

/**
 * The plan price after a coupon, by the legacy rule: the discount is
 * price * percent / 100 in INTEGER arithmetic, i.e. truncated
 * (₹4,999 at 10% -> discount ₹499 -> ₹4,500). See docs/coupons-legacy.md §5.
 */
export const priceAfterCoupon = (basePrice, discountPercent = 0) => {
  const discount = Math.trunc((basePrice * discountPercent) / 100);
  return { originalAmount: basePrice, discountPercent, discountAmount: discount, finalAmount: basePrice - discount };
};

/**
 * Creates one enrollment for an EXISTING user, recorded by an admin (cash, UPI,
 * bank transfer, ...). Everything the server can work out it works out itself:
 * the price comes from the plan, the discount from the coupon, hasStarted from
 * the start date, createdBy from the token. Nothing on the User, Coach, Plan or
 * Coupon is modified - in particular User.roles is left alone: an enrollment
 * document is what makes someone a client.
 *
 * All reads and the insert run in one transaction, so a failure anywhere leaves
 * nothing behind. Repeat purchases of the same plan are allowed, as they always
 * have been (the legacy data has members with several of the same plan).
 *
 * `payment.amount` is what was actually received and may differ from the price
 * due - the portal shows the difference before the admin confirms. The response
 * reports the price due and that difference.
 */
export const createManualEnrollment = async (input, adminId, at = clockNow()) => {
  const session = await mongoose.startSession();
  let createdId;
  let pricing;
  try {
    await session.withTransaction(async () => {
      const user = await User.findById(input.userId, { status: 1, profile: 1, phone: 1 }).session(session).lean();
      if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
      if (user.status !== 'active') throw badRequest(ERROR_CODES.USER_INACTIVE, `User is ${user.status ?? 'not active'}`);

      const plan = await GogetfitPlan.findById(input.planId).session(session).lean();
      if (!plan) throw notFound(ERROR_CODES.GOGETFIT_PLAN_NOT_FOUND, 'Plan not found');
      if (plan.status !== 'active' || plan.deletedAt) throw badRequest(ERROR_CODES.GOGETFIT_PLAN_INACTIVE, 'Plan is archived');

      const coach = await Coach.findById(input.coachId).session(session).lean();
      if (!coach) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'Coach not found');
      if (coach.status !== 'active') throw badRequest(ERROR_CODES.COACH_INACTIVE, 'Coach is inactive');
      const coachUser = await User.findById(coach.userId, { status: 1 }).session(session).lean();
      if (!coachUser || coachUser.status !== 'active') throw badRequest(ERROR_CODES.COACH_INACTIVE, "Coach's account is not active");
      // The existing rule: a coach offers exactly the active plans of their level.
      if (plan.coachLevel && plan.coachLevel !== coach.profile?.level) {
        throw badRequest(
          ERROR_CODES.PLAN_NOT_OFFERED_BY_COACH,
          `This coach (${coach.profile?.level ?? 'no level'}) does not offer ${plan.coachLevel} plans`,
        );
      }

      let coupon = null;
      if (input.couponId) {
        coupon = await Coupon.findById(input.couponId).session(session).lean();
        if (!coupon) throw notFound(ERROR_CODES.COUPON_NOT_FOUND, 'Coupon not found');
        // Public and private alike: the admin chose it explicitly. Only the dates decide.
        if (getCouponStatus(coupon.validFrom, coupon.validTo, at) !== 'active') {
          throw badRequest(ERROR_CODES.COUPON_INACTIVE, `Coupon ${coupon.code} is not active today`);
        }
      }

      pricing = priceAfterCoupon(plan.pricing.basePrice, coupon?.discount?.value ?? 0);

      const [doc] = await EnrolledClient.create(
        [
          {
            userId: user._id,
            planId: plan._id,
            coachId: coach._id,
            couponId: coupon?._id ?? null,
            enrollDate: input.enrollDate,
            startDate: input.startDate,
            endDate: input.endDate,
            // A plan is started once it has a start date - as the legacy start call did.
            hasStarted: Boolean(input.startDate),
            isDeleted: false,
            payment: {
              amount: input.payment.amount,
              currency: 'INR',
              originalAmount: pricing.originalAmount,
              discountPercent: pricing.discountPercent,
              status: 'Success',
              paidAt: input.payment.paidAt,
              referenceId: input.payment.referenceId,
              description: 'Manual enrollment created by admin',
              method: input.payment.method,
              notes: input.payment.notes ?? undefined,
              customerName: user.profile?.name ?? null,
              contact: user.phone?.normalized ?? null,
              email: user.profile?.email ?? null,
              updatedAt: at,
            },
            source: ENROLLMENT_SOURCE_ADMIN_MANUAL,
            createdBy: adminId,
            updatedBy: adminId,
          },
        ],
        { session },
      );
      createdId = doc._id;
    });
  } finally {
    await session.endSession();
  }

  const enrolledClient = await getEnrolledClientById(String(createdId), at);
  return {
    enrolledClient,
    pricing: {
      originalAmount: pricing.originalAmount,
      discountPercent: pricing.discountPercent,
      discountAmount: pricing.discountAmount,
      finalAmount: pricing.finalAmount,
      amountReceived: input.payment.amount,
      difference: input.payment.amount - pricing.finalAmount,
    },
  };
};
