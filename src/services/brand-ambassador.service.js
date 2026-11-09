import mongoose from 'mongoose';

import env from '../config/env.js';
import {
  BrandAmbassadorActivity,
  BrandAmbassadorCoupon,
  BrandAmbassadorPayout,
  BrandAmbassadorReferral,
  BrandAmbassadorSequence,
} from '../models/brand-ambassador.model.js';
import Coupon from '../models/coupon.model.js';
import EnrolledClient from '../models/enrolled-client.model.js';
import GogetfitPlan from '../models/gogetfit-plan.model.js';
import User from '../models/user.model.js';
import { businessDayOf } from '../utils/business-date.js';
import { now as clockNow } from '../utils/clock.js';
import { ERROR_CODES, badRequest, conflict, notFound } from '../utils/errors.js';

/**
 * Brand Ambassador programme: registration and coupon generation, the
 * ambassador's own aggregate view, checkout resolution of ambassador codes,
 * referral attribution, and the admin reads. See docs/brand-ambassador.md.
 *
 * Every figure is decided here. The app and the portal send no owner, rate,
 * discount or count - the owner comes from the token, the terms from the
 * ambassador's record, and the count from the referral records themselves.
 */

const iso = (date) => (date ? new Date(date).toISOString() : null);
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withSession = (query, session) => (session ? query.session(session) : query);

/** What the programme publishes, for the overview shown before joining. */
export const programPolicy = () => ({
  discountPercent: env.ambassador.discountPercent,
  commissionMinPercent: env.ambassador.commissionMinPercent,
  commissionMaxPercent: env.ambassador.commissionMaxPercent,
  tdsPercent: env.ambassador.tdsPercent,
  payoutDay: env.ambassador.payoutDay,
});

// ─── coupon generation ───────────────────────────────────────────────────────

/**
 * The first three letters of [name], upper-cased, with accents folded and
 * everything else dropped. A shorter name is padded with X ("Al" -> "ALX");
 * a name with no letters at all gives "GGF". Deterministic: the same name
 * always gives the same prefix.
 */
export const couponPrefix = (name) => {
  const letters = String(name ?? '')
    .normalize('NFD')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  if (letters.length === 0) return 'GGF';
  return letters.slice(0, 3).padEnd(3, 'X');
};

/**
 * Allocates the next suffix for [prefix] with one atomic $inc, so two
 * registrations at the same moment can never get the same number. A number
 * may be skipped (a failed registration after allocation), never repeated.
 */
const nextSequence = async (prefix) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const doc = await BrandAmbassadorSequence.findOneAndUpdate(
        { _id: prefix },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      ).lean();
      return doc.seq;
    } catch (error) {
      // Two first-ever upserts of the same prefix race on the _id; the loser retries.
      if (error?.code !== 11000) throw error;
    }
  }
  throw new Error(`Could not allocate an ambassador sequence for ${prefix}`);
};

/** A code nobody holds yet - neither another ambassador nor an admin coupon. */
const allocateCode = async (prefix) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = `${prefix}${String(await nextSequence(prefix)).padStart(4, '0')}`;
    const taken = (await BrandAmbassadorCoupon.exists({ couponCode: code })) || (await Coupon.exists({ code }));
    if (!taken) return code;
  }
  throw new Error(`Could not allocate a free ambassador code for ${prefix}`);
};

// ─── activity ────────────────────────────────────────────────────────────────

const logActivity = (entry, session = null) =>
  BrandAmbassadorActivity.create([{ at: clockNow(), before: null, after: null, detail: null, ...entry }], { session });

// ─── the ambassador's own view ───────────────────────────────────────────────

const countSuccessful = (ambassadorCouponId) =>
  BrandAmbassadorReferral.countDocuments({ ambassadorCouponId, referralStatus: 'successful' });

/**
 * The mobile shape. Deliberately aggregate-only: no referred customer, order,
 * plan or payment ever appears here.
 */
const toMemberAmbassador = (doc, successfulReferrals) => ({
  id: String(doc._id),
  couponCode: doc.couponCode,
  status: doc.status,
  registeredAt: iso(doc.createdAt),
  discountPercent: doc.discountValue,
  commissionPercent: doc.commissionValue,
  tdsPercent: env.ambassador.tdsPercent,
  payoutDay: env.ambassador.payoutDay,
  successfulReferrals,
});

/** The signed-in user's ambassador profile, or null when they have not joined. */
export const getMyAmbassador = async (userId) => {
  const doc = await BrandAmbassadorCoupon.findOne({ userId }).lean();
  return doc ? toMemberAmbassador(doc, await countSuccessful(doc._id)) : null;
};

/**
 * Registers [userId] and generates their code. Idempotent: an existing
 * ambassador gets their existing profile back, and two concurrent requests
 * resolve to one record through the unique userId index.
 */
export const registerAmbassador = async (userId) => {
  const existing = await getMyAmbassador(userId);
  if (existing) return { ambassador: existing, created: false };

  const user = await User.findById(userId, { status: 1, profile: 1 }).lean();
  if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  if (user.status !== 'active') throw badRequest(ERROR_CODES.USER_INACTIVE, `User is ${user.status ?? 'not active'}`);

  const couponCode = await allocateCode(couponPrefix(user.profile?.name));
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const [doc] = await BrandAmbassadorCoupon.create(
        [
          {
            userId,
            couponCode,
            discountValue: env.ambassador.discountPercent,
            commissionValue: env.ambassador.commissionPercent,
            status: 'active',
          },
        ],
        { session },
      );
      const base = { ambassadorCouponId: doc._id, entityType: 'ambassador', entityId: doc._id, actorId: userId };
      await logActivity({ ...base, action: 'registered', actorRole: 'member', detail: 'Joined the programme' }, session);
      await logActivity(
        {
          ...base,
          action: 'coupon_generated',
          actorRole: 'system',
          actorId: null,
          detail: `Coupon ${couponCode} generated`,
          after: { couponCode, discountValue: doc.discountValue, commissionValue: doc.commissionValue },
        },
        session,
      );
    });
  } catch (error) {
    // The other request of a double tap won: answer with its record.
    if (error?.code === 11000 && error?.keyPattern?.userId) {
      return { ambassador: await getMyAmbassador(userId), created: false };
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return { ambassador: await getMyAmbassador(userId), created: true };
};

// ─── checkout ────────────────────────────────────────────────────────────────

/**
 * An ambassador code a member may apply, in the same shape checkout reads an
 * admin coupon in (`discount.value`), plus the ambassador record. Null when
 * [code] is not an ambassador code, so the caller can report "not found" in
 * its usual words.
 */
export const resolveAmbassadorCoupon = async (code, { userId, session = null }) => {
  const ambassador = await withSession(
    BrandAmbassadorCoupon.findOne({ couponCode: String(code).trim().toUpperCase() }),
    session,
  ).lean();
  if (!ambassador) return null;

  if (ambassador.status !== 'active') {
    throw badRequest(ERROR_CODES.COUPON_INACTIVE, `Ambassador code ${ambassador.couponCode} is not active`);
  }
  if (userId && String(ambassador.userId) === String(userId)) {
    throw badRequest(ERROR_CODES.AMBASSADOR_SELF_REFERRAL, 'You cannot use your own Ambassador Code');
  }
  const owner = await withSession(User.findById(ambassador.userId, { status: 1 }), session).lean();
  if (!owner || owner.status !== 'active') {
    throw badRequest(ERROR_CODES.COUPON_INACTIVE, `Ambassador code ${ambassador.couponCode} is not active`);
  }

  return { _id: null, code: ambassador.couponCode, discount: { value: ambassador.discountValue }, ambassador };
};

const roundRupees = (value) => Math.round(value);

/**
 * Creates (or settles) the one referral for an enrollment bought with an
 * ambassador code. Called inside the purchase transaction today, and the
 * single place a payment-gateway confirmation must call once one exists.
 *
 * - The owner comes from the enrollment's ambassadorCouponId, which the backend
 *   set from its own coupon record - never from anything a client sent.
 * - Successful only when the order's payment says 'Success'; otherwise pending.
 * - Idempotent: the unique orderId index means a repeated call (a retried
 *   request, a duplicate webhook) finds the existing record and changes
 *   nothing, beyond promoting pending -> successful once payment succeeds.
 */
export const recordReferralForEnrollment = async (enrollmentId, { session = null, at = clockNow() } = {}) => {
  const order = await withSession(EnrolledClient.findById(enrollmentId), session).lean();
  if (!order?.ambassadorCouponId || order.isDeleted) return null;

  const paymentStatus = order.payment?.status ?? null;
  const paid = paymentStatus === 'Success';
  const existing = await withSession(BrandAmbassadorReferral.findOne({ orderId: order._id }), session).lean();

  if (existing) {
    if (existing.referralStatus === 'pending' && paid) {
      await BrandAmbassadorReferral.updateOne(
        { _id: existing._id, referralStatus: 'pending' },
        {
          $set: { referralStatus: 'successful', paymentStatus: order.payment.status },
          $push: { statusHistory: { status: 'successful', at, actorId: null, reason: 'Payment confirmed' } },
        },
        { session },
      );
      await logActivity(
        {
          ambassadorCouponId: existing.ambassadorCouponId,
          entityType: 'referral',
          entityId: existing._id,
          action: 'referral_successful',
          actorRole: 'system',
          detail: `Order ${order._id} payment confirmed`,
          before: { referralStatus: 'pending' },
          after: { referralStatus: 'successful' },
        },
        session,
      );
    }
    return existing._id;
  }

  // A failed (or any other non-pending) payment earns nothing and records nothing.
  if (!paid && paymentStatus !== null && paymentStatus !== 'Pending') return null;

  const ambassador = await withSession(BrandAmbassadorCoupon.findById(order.ambassadorCouponId), session).lean();
  if (!ambassador) return null;
  const plan = await withSession(GogetfitPlan.findById(order.planId, { name: 1 }), session).lean();

  const p = order.payment ?? {};
  const finalPaidAmount = p.amount ?? 0;
  const grossCommission = roundRupees((finalPaidAmount * ambassador.commissionValue) / 100);
  const tdsAmount = roundRupees((grossCommission * env.ambassador.tdsPercent) / 100);
  const status = paid ? 'successful' : 'pending';
  const purchasedAt = p.paidAt ?? order.enrollDate ?? at;

  const [referral] = await BrandAmbassadorReferral.create(
    [
      {
        ambassadorCouponId: ambassador._id,
        ambassadorUserId: ambassador.userId,
        couponCode: ambassador.couponCode,
        referredUserId: order.userId,
        orderId: order._id,
        planId: order.planId,
        planNameSnapshot: plan?.name ?? null,
        originalPlanAmount: p.originalAmount ?? finalPaidAmount,
        discountPercent: p.discountPercent ?? 0,
        discountAmount: (p.originalAmount ?? finalPaidAmount) - finalPaidAmount,
        finalPaidAmount,
        currency: p.currency ?? 'INR',
        paymentId: p.transactionId ?? null,
        paymentStatus: p.status ?? null,
        // No payment gateway exists yet: every confirmation today is the app's own.
        paymentVerification: 'simulated',
        referralStatus: status,
        statusHistory: [{ status, at, actorId: null, reason: paid ? 'Payment confirmed' : 'Awaiting payment' }],
        purchasedAt,
        commissionPercent: ambassador.commissionValue,
        grossCommission,
        tdsPercent: env.ambassador.tdsPercent,
        tdsAmount,
        netCommission: grossCommission - tdsAmount,
        payoutPeriod: businessDayOf(purchasedAt).slice(0, 7),
      },
    ],
    { session },
  );

  const base = { ambassadorCouponId: ambassador._id, entityType: 'referral', entityId: referral._id, actorRole: 'system' };
  await logActivity(
    {
      ...base,
      action: paid ? 'referral_successful' : 'referral_pending',
      detail: `Order ${order._id} · ${plan?.name ?? 'plan'}`,
      after: { referralStatus: status },
    },
    session,
  );
  await logActivity(
    {
      ...base,
      action: 'commission_calculated',
      detail: `${ambassador.commissionValue}% of ₹${finalPaidAmount} = ₹${grossCommission} (TDS ₹${tdsAmount})`,
      after: { grossCommission, tdsAmount, netCommission: grossCommission - tdsAmount },
    },
    session,
  );
  return referral._id;
};

// ─── admin ───────────────────────────────────────────────────────────────────

export const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 10;

const STATUS_LABEL = { active: 'Active', inactive: 'Inactive' };
const REFERRAL_LABEL = { pending: 'Pending', successful: 'Successful' };
const ACTION_LABEL = {
  registered: 'Ambassador registered',
  coupon_generated: 'Coupon generated',
  activated: 'Coupon activated',
  deactivated: 'Coupon deactivated',
  referral_pending: 'Referral pending',
  referral_successful: 'Referral successful',
  commission_calculated: 'Commission calculated',
  commission_adjusted: 'Commission adjusted',
  commission_rate_changed: 'Commission rate changed',
  payout_processed: 'Payout processed',
};

const userLookup = (localField, as) => [
  {
    $lookup: {
      from: 'users',
      localField,
      foreignField: '_id',
      as,
      pipeline: [{ $project: { 'profile.name': 1, 'profile.email': 1, 'phone.normalized': 1 } }],
    },
  },
  { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: true } },
];

/** Successful-referral totals per ambassador, joined onto each row. */
const STATS_STAGES = [
  {
    $lookup: {
      from: 'brand_ambassador_referrals',
      let: { id: '$_id' },
      as: 'stats',
      pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$ambassadorCouponId', '$$id'] }, { $eq: ['$referralStatus', 'successful'] }] } } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            sales: { $sum: '$finalPaidAmount' },
            discounts: { $sum: '$discountAmount' },
            gross: { $sum: '$grossCommission' },
            paidGross: { $sum: { $cond: [{ $eq: ['$commissionStatus', 'paid'] }, '$grossCommission', 0] } },
            payableNet: { $sum: { $cond: [{ $eq: ['$commissionStatus', 'pending'] }, '$netCommission', 0] } },
          },
        },
      ],
    },
  },
  { $unwind: { path: '$stats', preserveNullAndEmptyArrays: true } },
];

const mobileOf = (u) => (u?.phone?.normalized ? `+${u.phone.normalized}` : null);

const toAdminAmbassador = (row) => ({
  id: String(row._id),
  name: row.user?.profile?.name ?? null,
  userId: String(row.userId),
  email: row.user?.profile?.email ?? null,
  mobile: mobileOf(row.user),
  couponCode: row.couponCode,
  status: STATUS_LABEL[row.status] ?? row.status,
  registeredAt: iso(row.createdAt),
  discountPercent: row.discountValue,
  commissionPercent: row.commissionValue,
  successfulReferrals: row.stats?.count ?? 0,
  salesAmount: row.stats?.sales ?? 0,
  commissionEarned: row.stats?.gross ?? 0,
});

const toAdminDetail = (row) => ({
  ...toAdminAmbassador(row),
  discountsGiven: row.stats?.discounts ?? 0,
  commissionPaid: row.stats?.paidGross ?? 0,
  commissionPayable: row.stats?.payableNet ?? 0,
});

const AMBASSADOR_SORTS = {
  registeredAt: 'createdAt',
  name: 'user.profile.name',
  couponCode: 'couponCode',
  successfulReferrals: 'stats.count',
  salesAmount: 'stats.sales',
  commissionEarned: 'stats.gross',
  status: 'status',
};

/**
 * GET /admin/ambassadors. Search covers name, email, mobile, user id and code.
 *
 * ponytail: joins users and referral totals before matching, so the search
 * scans every ambassador. Fine for thousands; past that, keep a search
 * projection on the ambassador record.
 */
export const listAmbassadors = async (params = {}, at = clockNow()) => {
  const { search, status, joinedWithinDays, sortKey = 'registeredAt', sortDir = 'desc' } = params;
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(params.pageSize) || DEFAULT_PAGE_SIZE));

  const pre = {};
  if (status) pre.status = status;
  if (joinedWithinDays) pre.createdAt = { $gte: new Date(at.getTime() - joinedWithinDays * 86_400_000) };

  const stages = [{ $match: pre }, ...userLookup('userId', 'user')];
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const digits = search.replace(/\D/g, '');
    const or = [{ 'user.profile.name': rx }, { 'user.profile.email': rx }, { couponCode: rx }];
    if (digits) or.push({ 'user.phone.normalized': new RegExp(escapeRegex(digits)) });
    if (mongoose.isValidObjectId(search)) or.push({ userId: new mongoose.Types.ObjectId(search) });
    stages.push({ $match: { $or: or } });
  }
  stages.push(...STATS_STAGES);

  const field = AMBASSADOR_SORTS[sortKey] ?? 'createdAt';
  const dir = sortDir === 'asc' ? 1 : -1;
  const [result] = await BrandAmbassadorCoupon.aggregate([
    ...stages,
    { $sort: { [field]: dir, _id: dir } },
    {
      $facet: {
        rows: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }],
        total: [{ $count: 'n' }],
      },
    },
  ]);
  const total = result.total[0]?.n ?? 0;
  return { rows: result.rows.map(toAdminAmbassador), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
};

/** The four summary cards, across every ambassador. */
export const ambassadorSummary = async () => {
  const [ambassadors, [totals]] = await Promise.all([
    BrandAmbassadorCoupon.countDocuments({}),
    BrandAmbassadorReferral.aggregate([
      { $match: { referralStatus: 'successful' } },
      {
        $group: {
          _id: null,
          referrals: { $sum: 1 },
          sales: { $sum: '$finalPaidAmount' },
          payable: { $sum: { $cond: [{ $eq: ['$commissionStatus', 'pending'] }, '$netCommission', 0] } },
        },
      },
    ]),
  ]);
  return {
    totalAmbassadors: ambassadors,
    totalReferrals: totals?.referrals ?? 0,
    totalSales: totals?.sales ?? 0,
    totalCommissionPayable: totals?.payable ?? 0,
  };
};

export const getAmbassadorDetail = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const [row] = await BrandAmbassadorCoupon.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(id) } },
    ...userLookup('userId', 'user'),
    ...STATS_STAGES,
  ]);
  return row ? toAdminDetail(row) : null;
};

/** Activate / deactivate. Never deletes; the change and its admin are audited. */
export const setAmbassadorStatus = async (id, { status, reason = null }, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const current = await BrandAmbassadorCoupon.findById(id).lean();
  if (!current) return null;
  if (current.status === status) {
    throw conflict(ERROR_CODES.AMBASSADOR_STATUS_UNCHANGED, `This ambassador is already ${status}`);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const updated = await BrandAmbassadorCoupon.updateOne(
        { _id: current._id, status: current.status },
        { $set: { status } },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw conflict(ERROR_CODES.AMBASSADOR_STATUS_UNCHANGED, 'The status changed meanwhile; reload and try again');
      }
      await logActivity(
        {
          ambassadorCouponId: current._id,
          entityType: 'ambassador',
          entityId: current._id,
          action: status === 'active' ? 'activated' : 'deactivated',
          actorId: adminId,
          actorRole: 'admin',
          detail: reason ? `Reason: ${reason}` : null,
          before: { status: current.status },
          after: { status },
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }
  return getAmbassadorDetail(id);
};

const REFERRAL_STAGES = [
  ...userLookup('referredUserId', 'customer'),
  ...userLookup('ambassadorUserId', 'ambassadorUser'),
  {
    $lookup: {
      from: 'enrolledclients',
      localField: 'orderId',
      foreignField: '_id',
      as: 'order',
      pipeline: [{ $project: { payment: 1 } }],
    },
  },
  { $unwind: { path: '$order', preserveNullAndEmptyArrays: true } },
];

/** The admin-only transaction row: customer, coupon, plan, order, payment, referral. */
const toAdminReferral = (row) => ({
  id: String(row._id),
  ambassadorId: String(row.ambassadorCouponId),
  ambassadorName: row.ambassadorUser?.profile?.name ?? null,
  customerName: row.customer?.profile?.name ?? null,
  customerUserId: String(row.referredUserId),
  email: row.customer?.profile?.email ?? null,
  mobile: mobileOf(row.customer),
  couponCode: row.couponCode,
  planName: row.planNameSnapshot,
  planId: String(row.planId),
  orderId: String(row.orderId),
  originalAmount: row.originalPlanAmount,
  discountPercent: row.discountPercent,
  discountAmount: row.discountAmount,
  paidAmount: row.finalPaidAmount,
  currency: row.currency,
  paymentId: row.paymentId,
  // The order is the source of truth for payment; the snapshot covers a missing order.
  gatewayReference: row.order?.payment?.referenceId ?? null,
  paymentStatus: row.order?.payment?.status ?? row.paymentStatus,
  paymentVerification: row.paymentVerification ?? 'simulated',
  referralStatus: REFERRAL_LABEL[row.referralStatus] ?? row.referralStatus,
  commissionPercent: row.commissionPercent,
  grossCommission: row.grossCommission,
  tdsAmount: row.tdsAmount,
  netCommission: row.netCommission,
  commissionStatus: row.commissionStatus,
  purchasedAt: iso(row.purchasedAt),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

const REFERRAL_STATUS_PARAM = { Pending: 'pending', Successful: 'successful' };

/** GET /admin/ambassadors/:id/referrals - newest purchase first. */
export const listAmbassadorReferrals = async (ambassadorId, params = {}) => {
  if (!mongoose.isValidObjectId(ambassadorId)) return null;
  if (!(await BrandAmbassadorCoupon.exists({ _id: ambassadorId }))) return null;

  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE * 10, Math.max(1, Number(params.pageSize) || DEFAULT_PAGE_SIZE));

  const pre = { ambassadorCouponId: new mongoose.Types.ObjectId(ambassadorId) };
  if (params.planId && mongoose.isValidObjectId(params.planId)) pre.planId = new mongoose.Types.ObjectId(params.planId);
  if (params.referralStatus) pre.referralStatus = REFERRAL_STATUS_PARAM[params.referralStatus] ?? params.referralStatus;
  if (params.from || params.to) {
    pre.purchasedAt = {};
    if (params.from) pre.purchasedAt.$gte = new Date(`${params.from}T00:00:00.000Z`);
    if (params.to) pre.purchasedAt.$lte = new Date(`${params.to}T23:59:59.999Z`);
  }

  const post = [];
  if (params.paymentStatus) post.push({ 'order.payment.status': params.paymentStatus });
  if (params.search) {
    const rx = new RegExp(escapeRegex(params.search), 'i');
    const or = [{ 'customer.profile.name': rx }, { 'customer.profile.email': rx }, { paymentId: rx }];
    const digits = params.search.replace(/\D/g, '');
    if (digits) or.push({ 'customer.phone.normalized': new RegExp(escapeRegex(digits)) });
    if (mongoose.isValidObjectId(params.search)) {
      const oid = new mongoose.Types.ObjectId(params.search);
      or.push({ referredUserId: oid }, { orderId: oid });
    }
    post.push({ $or: or });
  }

  const [result] = await BrandAmbassadorReferral.aggregate([
    { $match: pre },
    ...REFERRAL_STAGES,
    ...(post.length ? [{ $match: { $and: post } }] : []),
    { $sort: { purchasedAt: -1, _id: -1 } },
    { $facet: { rows: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }], total: [{ $count: 'n' }] } },
  ]);
  const total = result.total[0]?.n ?? 0;
  return { rows: result.rows.map(toAdminReferral), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
};

/** The plans this ambassador's referrals were for, for the plan filter. */
export const listAmbassadorReferralPlans = async (ambassadorId) => {
  if (!mongoose.isValidObjectId(ambassadorId)) return [];
  const rows = await BrandAmbassadorReferral.aggregate([
    { $match: { ambassadorCouponId: new mongoose.Types.ObjectId(ambassadorId) } },
    { $group: { _id: '$planId', name: { $first: '$planNameSnapshot' } } },
    { $sort: { name: 1 } },
  ]);
  return rows.map((r) => ({ id: String(r._id), name: r.name }));
};

export const getReferralDetail = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const [row] = await BrandAmbassadorReferral.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(id) } },
    ...REFERRAL_STAGES,
  ]);
  return row ? toAdminReferral(row) : null;
};

const periodLabel = (period) =>
  new Date(`${period}-01T00:00:00.000Z`).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Monthly payout periods, from the commission ledger (successful referrals).
 * A period is Paid only when every line in it carries a payout reference;
 * nothing here marks money as sent.
 */
export const listAmbassadorPayouts = async (ambassadorId) => {
  if (!mongoose.isValidObjectId(ambassadorId)) return null;
  if (!(await BrandAmbassadorCoupon.exists({ _id: ambassadorId }))) return null;

  const recorded = new Map(
    (await BrandAmbassadorPayout.find({ ambassadorCouponId: ambassadorId }).lean()).map((p) => [p.period, p]),
  );
  const rows = await BrandAmbassadorReferral.aggregate([
    { $match: { ambassadorCouponId: new mongoose.Types.ObjectId(ambassadorId), referralStatus: 'successful' } },
    {
      $group: {
        _id: '$payoutPeriod',
        eligibleOrderValue: { $sum: '$finalPaidAmount' },
        rates: { $addToSet: '$commissionPercent' },
        tdsRates: { $addToSet: '$tdsPercent' },
        grossCommission: { $sum: '$grossCommission' },
        tds: { $sum: '$tdsAmount' },
        netPayable: { $sum: '$netCommission' },
        unpaid: { $sum: { $cond: [{ $eq: ['$commissionStatus', 'paid'] }, 0, 1] } },
        references: { $addToSet: '$payoutReference' },
        paidAt: { $max: '$paidAt' },
      },
    },
    { $sort: { _id: -1 } },
  ]);

  return rows.map((r) => {
    const payout = recorded.get(r._id);
    const paid = r.unpaid === 0;
    return {
      id: r._id,
      periodKey: r._id,
      period: periodLabel(r._id),
      eligibleOrderValue: r.eligibleOrderValue,
      // ponytail: one rate per period in practice (rates are fixed per ambassador); a mix shows the highest.
      commissionPercent: Math.max(...r.rates),
      grossCommission: r.grossCommission,
      tdsPercent: Math.max(...r.tdsRates),
      tds: r.tds,
      netPayable: r.netPayable,
      status: paid ? 'Paid' : payout?.status === 'processing' ? 'Processing' : 'Pending',
      amountPaid: payout?.amount ?? null,
      transactionReference: payout?.reference ?? (paid ? r.references.filter(Boolean).join(', ') || null : null),
      paidAt: payout ? iso(payout.paidAt) : paid ? iso(r.paidAt) : null,
      // Recordable once the month is over and something in it is unpaid.
      canRecord: !paid && r._id < businessDayOf(clockNow()).slice(0, 7),
    };
  });
};

/**
 * Changes one ambassador's commission rate, within the published range. Only
 * referrals created after this use it: every existing ledger line keeps the
 * rate it was calculated with.
 */
export const setAmbassadorCommission = async (id, { commissionPercent, reason = null }, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const { commissionMinPercent: min, commissionMaxPercent: max } = env.ambassador;
  if (!Number.isInteger(commissionPercent) || commissionPercent < min || commissionPercent > max) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `commissionPercent must be a whole number from ${min} to ${max}`);
  }
  const current = await BrandAmbassadorCoupon.findById(id).lean();
  if (!current) return null;
  if (current.commissionValue === commissionPercent) {
    throw conflict(ERROR_CODES.AMBASSADOR_STATUS_UNCHANGED, `The rate is already ${commissionPercent}%`);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const updated = await BrandAmbassadorCoupon.updateOne(
        { _id: current._id, commissionValue: current.commissionValue },
        { $set: { commissionValue: commissionPercent } },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw conflict(ERROR_CODES.AMBASSADOR_STATUS_UNCHANGED, 'The rate changed meanwhile; reload and try again');
      }
      await logActivity(
        {
          ambassadorCouponId: current._id,
          entityType: 'ambassador',
          entityId: current._id,
          action: 'commission_rate_changed',
          actorId: adminId,
          actorRole: 'admin',
          detail: `${current.commissionValue}% → ${commissionPercent}% for future referrals${reason ? ` · ${reason}` : ''}`,
          before: { commissionValue: current.commissionValue },
          after: { commissionValue: commissionPercent },
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }
  return getAmbassadorDetail(id);
};

/**
 * Records a payout made outside the system for one finished month. The amount
 * must equal that month's net payable, so a typo cannot settle the wrong sum.
 * 'paid' settles the month's commission lines; 'processing' only notes that a
 * transfer is under way. Recording again updates the same month's record.
 */
export const recordPayout = async (ambassadorId, { period, amount, paidAt, reference, status }, adminId) => {
  if (!mongoose.isValidObjectId(ambassadorId)) return null;
  const ambassador = await BrandAmbassadorCoupon.findById(ambassadorId).lean();
  if (!ambassador) return null;
  if (period >= businessDayOf(clockNow()).slice(0, 7)) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'A payout can be recorded only for a month that has ended');
  }

  const lines = { ambassadorCouponId: ambassador._id, payoutPeriod: period, referralStatus: 'successful', commissionStatus: 'pending' };
  const [due] = await BrandAmbassadorReferral.aggregate([
    { $match: lines },
    { $group: { _id: null, net: { $sum: '$netCommission' }, n: { $sum: 1 } } },
  ]);
  if (!due) throw conflict(ERROR_CODES.AMBASSADOR_REFERRAL_FINAL, `Nothing is payable for ${period}`);
  if (amount !== due.net) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `The amount must equal the net payable for ${period}: ₹${due.net}`);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const before = await BrandAmbassadorPayout.findOne({ ambassadorCouponId: ambassador._id, period }).session(session).lean();
      await BrandAmbassadorPayout.updateOne(
        { ambassadorCouponId: ambassador._id, period },
        { $set: { amount, paidAt, reference, status, recordedBy: adminId } },
        { upsert: true, session },
      );
      if (status === 'paid') {
        const settled = await BrandAmbassadorReferral.updateMany(
          lines,
          { $set: { commissionStatus: 'paid', payoutReference: reference, paidAt } },
          { session },
        );
        if (settled.modifiedCount !== due.n) {
          throw conflict(ERROR_CODES.AMBASSADOR_REFERRAL_FINAL, 'The month changed meanwhile; reload and try again');
        }
      }
      await logActivity(
        {
          ambassadorCouponId: ambassador._id,
          entityType: 'ambassador',
          entityId: ambassador._id,
          action: 'payout_processed',
          actorId: adminId,
          actorRole: 'admin',
          detail: `${periodLabel(period)} · ₹${amount} · ${status === 'paid' ? 'Paid' : 'Processing'} · Ref ${reference}`,
          before: before ? { status: before.status, reference: before.reference } : null,
          after: { period, amount, status, reference, paidAt },
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }
  return listAmbassadorPayouts(ambassadorId);
};

/** The audit trail, newest first, with the actor resolved to a name. */
export const listAmbassadorActivity = async (ambassadorId) => {
  if (!mongoose.isValidObjectId(ambassadorId)) return null;
  if (!(await BrandAmbassadorCoupon.exists({ _id: ambassadorId }))) return null;

  const rows = await BrandAmbassadorActivity.aggregate([
    { $match: { ambassadorCouponId: new mongoose.Types.ObjectId(ambassadorId) } },
    { $sort: { at: -1, _id: -1 } },
    { $limit: 500 },
    ...userLookup('actorId', 'actor'),
  ]);
  return rows.map((r) => ({
    id: String(r._id),
    at: iso(r.at),
    action: ACTION_LABEL[r.action] ?? r.action,
    detail: r.detail ?? '',
    actor: r.actorRole === 'system' ? 'System' : (r.actor?.profile?.name ?? (r.actorRole === 'admin' ? 'Admin' : 'Member')),
  }));
};
