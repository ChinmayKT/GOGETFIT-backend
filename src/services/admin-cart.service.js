import mongoose from 'mongoose';

import CartItem from '../models/cart-item.model.js';
import { PLAN_CURRENCY } from '../models/gogetfit-plan.model.js';

/**
 * "In cart" - the sales follow-up list.
 *
 * Members who put a coaching plan in their cart and have not bought it. Only
 * `active` items appear: the moment a purchase succeeds the item becomes
 * `purchased`, so it leaves this list by itself and shows up under Enrollments
 * instead. Nothing here has to be cleaned up after a sale.
 *
 * The user, coach and plan are joined for display, never copied onto the cart.
 */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SORTABLE = {
  addedAt: 'addedAt',
  updatedAt: 'updatedAt',
  userName: 'user.profile.name',
  planName: 'plan.name',
  price: 'plan.pricing.basePrice',
};

export const SORT_KEYS = Object.keys(SORTABLE);

const iso = (date) => (date ? new Date(date).toISOString() : null);

export const toCartRow = (doc) => ({
  id: String(doc._id),
  status: doc.status,
  user: doc.user
    ? {
        id: String(doc.user._id),
        name: doc.user.profile?.name ?? null,
        phone: doc.user.phone?.normalized ?? doc.user.phone?.raw ?? null,
        email: doc.user.profile?.email ?? null,
      }
    : null,
  coach: doc.coach
    ? {
        id: String(doc.coach._id),
        // From the coach's User - the Coach document has no name of its own.
        name: doc.coachUser?.profile?.name ?? null,
        level: doc.coach.profile?.level ?? null,
      }
    : null,
  plan: doc.plan
    ? {
        id: String(doc.plan._id),
        name: doc.plan.name ?? null,
        planType: doc.plan.planType ?? null,
        durationWeeks: doc.plan.durationWeeks ?? null,
        price: doc.plan.pricing?.basePrice ?? null,
        currency: PLAN_CURRENCY,
      }
    : null,
  addedAt: iso(doc.addedAt),
  updatedAt: iso(doc.updatedAt),
});

const lookups = [
  { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user',
      pipeline: [{ $project: { 'profile.name': 1, 'profile.email': 1, phone: 1 } }] } },
  { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
  { $lookup: { from: 'coaches', localField: 'coachId', foreignField: '_id', as: 'coach',
      pipeline: [{ $project: { 'profile.level': 1, userId: 1 } }] } },
  { $unwind: { path: '$coach', preserveNullAndEmptyArrays: true } },
  // The coach's display name lives on their User document.
  { $lookup: { from: 'users', localField: 'coach.userId', foreignField: '_id', as: 'coachUser',
      pipeline: [{ $project: { 'profile.name': 1 } }] } },
  { $unwind: { path: '$coachUser', preserveNullAndEmptyArrays: true } },
  { $lookup: { from: 'gogetfitplans', localField: 'planId', foreignField: '_id', as: 'plan',
      pipeline: [{ $project: { name: 1, planType: 1, durationWeeks: 1, pricing: 1 } }] } },
  { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
];

export const buildCartMatch = ({ coachId, planId, addedFrom, addedTo } = {}) => {
  // Only an unpurchased cart is a sales lead.
  const match = { status: 'active' };
  if (coachId && mongoose.isValidObjectId(coachId)) match.coachId = new mongoose.Types.ObjectId(coachId);
  if (planId && mongoose.isValidObjectId(planId)) match.planId = new mongoose.Types.ObjectId(planId);

  if (addedFrom || addedTo) {
    match.addedAt = {};
    if (addedFrom) match.addedAt.$gte = new Date(addedFrom);
    if (addedTo) match.addedAt.$lte = new Date(addedTo);
  }
  return match;
};

/** One page of the In cart list. Search runs after the joins, on the member's details. */
export const listCartItems = async (params = {}) => {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);

  const sortField = SORTABLE[params.sortKey] ?? SORTABLE.addedAt;
  const sortDir = params.sortDir === 'asc' ? 1 : -1;

  const pipeline = [{ $match: buildCartMatch(params) }, ...lookups];

  const term = String(params.search ?? '').trim();
  if (term !== '') {
    const pattern = new RegExp(escapeRegex(term), 'i');
    pipeline.push({
      $match: {
        $or: [
          { 'user.profile.name': pattern },
          { 'user.profile.email': pattern },
          { 'user.phone.normalized': pattern },
          { 'plan.name': pattern },
          { 'coachUser.profile.name': pattern },
        ],
      },
    });
  }

  // rows and total in one round trip, over the same filtered set.
  const [result] = await CartItem.aggregate([
    ...pipeline,
    {
      $facet: {
        rows: [{ $sort: { [sortField]: sortDir, _id: sortDir } }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const total = result?.total?.[0]?.count ?? 0;
  return {
    rows: (result?.rows ?? []).map(toCartRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};
