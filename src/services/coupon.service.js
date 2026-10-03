import mongoose from 'mongoose';

import Coupon from '../models/coupon.model.js';
import User from '../models/user.model.js';
import { now } from '../utils/clock.js';
import { couponActiveExpr, couponStatusFilter, getCouponStatus } from '../utils/coupon-status.js';
import { ERROR_CODES, conflict } from '../utils/errors.js';
import { assertDateOrder } from '../validators/coupon.validator.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const iso = (date) => (date ? date.toISOString() : null);

/** Optional explicit sort (applied within active-first / inactive-last). */
const SORTABLE = {
  code: 'code',
  discount: 'discount.value',
  validFrom: 'validFrom',
  validTo: 'validTo',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

const codeTaken = (code) => conflict(ERROR_CODES.COUPON_CODE_EXISTS, `A coupon with the code "${code}" already exists`);

/** Who created / last changed a coupon, for display. Name and email only. */
const toAdminRef = (user, id) =>
  id ? { id: String(id), name: user?.profile?.name ?? null, email: user?.profile?.email ?? null } : null;

const loadAdmins = async (docs) => {
  const ids = [...new Set(docs.flatMap((d) => [d.createdBy, d.updatedBy]).filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();
  const users = await User.find({ _id: { $in: ids } }, { 'profile.name': 1, 'profile.email': 1 }).lean();
  return new Map(users.map((u) => [String(u._id), u]));
};

/** `status` is computed here, at request time, from the dates. It is not stored anywhere. */
export const toCoupon = (doc, admins = new Map(), at = now()) => ({
  id: String(doc._id),
  code: doc.code,
  description: doc.description ?? null,
  discount: { type: doc.discount?.type ?? 'percent', value: doc.discount?.value ?? null },
  validFrom: iso(doc.validFrom),
  validTo: iso(doc.validTo),
  visibility: doc.visibility,
  status: getCouponStatus(doc.validFrom, doc.validTo, at),
  createdBy: toAdminRef(admins.get(String(doc.createdBy)), doc.createdBy),
  updatedBy: toAdminRef(admins.get(String(doc.updatedBy)), doc.updatedBy),
  createdAt: iso(doc.createdAt),
  updatedAt: iso(doc.updatedAt),
});

const withAdmins = async (doc) => (doc ? toCoupon(doc, await loadAdmins([doc])) : null);

export const buildCouponFilter = ({ search, status, visibility } = {}, at = now()) => {
  const clauses = [];
  if (status) clauses.push(couponStatusFilter(status, at));
  if (visibility) clauses.push({ visibility });
  const term = String(search ?? '').trim();
  if (term !== '') {
    const rx = new RegExp(escapeRegex(term), 'i');
    clauses.push({ $or: [{ code: rx }, { description: rx }] });
  }
  return clauses.length ? { $and: clauses } : {};
};

/**
 * One page, always active coupons first. By default active ones are ordered by
 * nearest expiry (validTo ascending) and inactive ones by most recent expiry
 * (validTo descending). An explicit sortKey orders within each group.
 */
export const listCoupons = async (params = {}) => {
  const at = now();
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);
  const filter = buildCouponFilter(params, at);

  const active = couponActiveExpr(at);
  const sort = SORTABLE[params.sortKey]
    ? { _active: -1, [SORTABLE[params.sortKey]]: params.sortDir === 'asc' ? 1 : -1, _id: 1 }
    : { _active: -1, _activeTo: 1, _inactiveTo: -1, _id: 1 };

  const [docs, total] = await Promise.all([
    Coupon.aggregate([
      { $match: filter },
      {
        $addFields: {
          _active: active,
          _activeTo: { $cond: [{ $eq: [active, 1] }, '$validTo', null] },
          _inactiveTo: { $cond: [{ $eq: [active, 1] }, null, '$validTo'] },
        },
      },
      { $sort: sort },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      { $project: { _active: 0, _activeTo: 0, _inactiveTo: 0 } },
    ]),
    Coupon.countDocuments(filter),
  ]);
  const admins = await loadAdmins(docs);

  return {
    rows: docs.map((d) => toCoupon(d, admins, at)),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

export const getCouponById = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  return withAdmins(await Coupon.findById(id).lean());
};

/** A duplicate-key error on the unique code index = a code clash (two admins racing). */
const mapDuplicate = (error, code) => {
  if (error?.code === 11000) throw codeTaken(code);
  throw error;
};

export const createCoupon = async (input, adminId) => {
  if (await Coupon.exists({ code: input.code })) throw codeTaken(input.code);
  try {
    const created = await Coupon.create({
      ...input,
      createdBy: adminId,
      updatedBy: adminId,
    });
    return withAdmins(created.toObject());
  } catch (error) {
    return mapDuplicate(error, input.code);
  }
};

/** Only supplied fields change; createdBy never does. */
export const updateCoupon = async (id, patch, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const current = await Coupon.findById(id).lean();
  if (!current) return null;

  const validFrom = patch.validFrom ?? current.validFrom;
  const validTo = patch.validTo ?? current.validTo;
  assertDateOrder(validFrom, validTo);

  if (patch.code && patch.code !== current.code && (await Coupon.exists({ _id: { $ne: current._id }, code: patch.code }))) {
    throw codeTaken(patch.code);
  }

  // Only the edited fields and the editor. No status is written - the next read computes it.
  const update = { updatedBy: adminId };
  for (const key of ['code', 'description', 'validFrom', 'validTo', 'visibility']) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }
  if (patch.discount) update.discount = patch.discount;

  try {
    const doc = await Coupon.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true }).lean();
    return withAdmins(doc);
  } catch (error) {
    return mapDuplicate(error, patch.code ?? current.code);
  }
};
