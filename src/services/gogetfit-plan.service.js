import mongoose from 'mongoose';

import GogetfitPlan, { PLAN_CURRENCY } from '../models/gogetfit-plan.model.js';
import { assertChallengeReward } from '../validators/gogetfit-plan.validator.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Sort keys the portal may request, mapped to real paths. */
const SORTABLE = {
  name: 'name',
  basePrice: 'pricing.basePrice',
  durationWeeks: 'durationWeeks',
  personsAllowed: 'personsAllowed',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  legacyPackageId: 'legacy.packageId',
};

const iso = (date) => (date ? date.toISOString() : null);

/** Allow-listed list row: the old Package List's columns plus status and timestamps. */
export const toPlanRow = (doc) => ({
  id: String(doc._id),
  name: doc.name ?? null,
  planType: doc.planType ?? null,
  coachLevel: doc.coachLevel ?? null,
  durationWeeks: doc.durationWeeks ?? null,
  personsAllowed: doc.personsAllowed ?? null,
  pricing: {
    basePrice: doc.pricing?.basePrice ?? null,
    reward: doc.pricing?.reward ?? null,
    currency: PLAN_CURRENCY,
  },
  status: doc.status ?? null,
  legacyPackageId: doc.legacy?.packageId ?? null,
  createdAt: iso(doc.createdAt),
  updatedAt: iso(doc.updatedAt),
});

/** Full plan for the view/edit screens. */
export const toPlanDetail = (doc) => ({
  ...toPlanRow(doc),
  content: {
    description: doc.content?.description ?? null,
    inclusions: doc.content?.inclusions ?? null,
    whatNext: doc.content?.whatNext ?? null,
    termsAndConditions: doc.content?.termsAndConditions ?? null,
    eligibility: doc.content?.eligibility ?? null,
  },
  deletedAt: iso(doc.deletedAt),
  legacy: doc.legacy?.packageId != null
    ? {
        source: doc.legacy.source ?? null,
        packageId: doc.legacy.packageId,
        createdBy: doc.legacy.createdBy ?? null,
        updatedAt: iso(doc.legacy.updatedAt),
        updatedBy: doc.legacy.updatedBy ?? null,
      }
    : null,
  migration: doc.migration?.runId
    ? { runId: doc.migration.runId, migratedAt: iso(doc.migration.migratedAt), version: doc.migration.version ?? null }
    : null,
});

export const buildPlanFilter = ({ search, planType, coachLevel, status } = {}) => {
  // Archived plans stay out of the default list, exactly like a deleted row would.
  const filter = { status: status ?? 'active' };
  if (planType) filter.planType = planType;
  if (coachLevel) filter.coachLevel = coachLevel;

  const term = String(search ?? '').trim();
  if (term !== '') {
    // The old list's only text filter was the plan name.
    filter.name = new RegExp(escapeRegex(term), 'i');
  }
  return filter;
};

/** One page of plans. Always paginated and capped. Default order matches the old list (oldest first). */
export const listPlans = async (params = {}) => {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);

  const sortField = SORTABLE[params.sortKey] ?? SORTABLE.createdAt;
  const sortDir = params.sortDir === 'desc' ? -1 : 1;

  const filter = buildPlanFilter(params);
  const [docs, total] = await Promise.all([
    GogetfitPlan.find(filter)
      .sort({ [sortField]: sortDir, _id: sortDir })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    GogetfitPlan.countDocuments(filter),
  ]);

  return {
    rows: docs.map(toPlanRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

/**
 * The member-facing plan: what the app's plan screens show, and nothing else.
 * Its own allow-list - no status, legacy ids, migration stamp or audit trail.
 */
export const toMemberPlan = (doc) => ({
  id: String(doc._id),
  name: doc.name ?? null,
  planType: doc.planType ?? null,
  coachLevel: doc.coachLevel ?? null,
  durationWeeks: doc.durationWeeks ?? null,
  personsAllowed: doc.personsAllowed ?? null,
  pricing: {
    basePrice: doc.pricing?.basePrice ?? null,
    reward: doc.pricing?.reward ?? null,
    currency: PLAN_CURRENCY,
  },
  content: {
    description: doc.content?.description ?? null,
    inclusions: doc.content?.inclusions ?? null,
    whatNext: doc.content?.whatNext ?? null,
    termsAndConditions: doc.content?.termsAndConditions ?? null,
    eligibility: doc.content?.eligibility ?? null,
  },
});

/**
 * Plans a coach of [coachLevel] offers: every ACTIVE plan of exactly that level.
 * The level always comes from the coach document (see coach-member.controller),
 * never from the request - so no client can ask for another level's plans.
 * Oldest first, like the admin list.
 */
export const listActivePlansForLevel = async (coachLevel, params = {}) => {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);

  const filter = { status: 'active', coachLevel };
  const [docs, total] = await Promise.all([
    GogetfitPlan.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    GogetfitPlan.countDocuments(filter),
  ]);

  return {
    rows: docs.map(toMemberPlan),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

export const getPlanById = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await GogetfitPlan.findById(id).lean();
  return doc ? toPlanDetail(doc) : null;
};

export const createPlan = async (input, adminId) => {
  const created = await GogetfitPlan.create({
    name: input.name,
    planType: input.planType,
    coachLevel: input.coachLevel,
    durationWeeks: input.durationWeeks,
    personsAllowed: input.personsAllowed,
    pricing: input.pricing,
    content: input.content,
    status: input.status ?? 'active',
    createdBy: adminId,
    updatedBy: adminId,
  });
  return toPlanDetail(created.toObject());
};

/**
 * Controlled update: each supplied field is $set by its own path, so the legacy
 * metadata, migration stamp and createdAt/createdBy survive untouched. Every
 * field is editable, as it was in the legacy admin.
 */
export const updatePlan = async (id, patch, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const current = await GogetfitPlan.findById(id).lean();
  if (!current) return null;

  // The Challenge rule is checked against the plan as it will be stored.
  assertChallengeReward({
    planType: patch.planType ?? current.planType,
    reward: patch.pricing?.reward !== undefined ? patch.pricing.reward : current.pricing?.reward,
    basePrice: patch.pricing?.basePrice ?? current.pricing?.basePrice,
  });

  const update = { updatedBy: adminId };
  for (const key of ['name', 'planType', 'coachLevel', 'durationWeeks', 'personsAllowed']) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }
  for (const [key, value] of Object.entries(patch.pricing ?? {})) update[`pricing.${key}`] = value;
  for (const [key, value] of Object.entries(patch.content ?? {})) update[`content.${key}`] = value;
  if (patch.status !== undefined) {
    update.status = patch.status;
    if (patch.status === 'active') {
      update.deletedAt = null;
      update.deletedBy = null;
    } else if (current.status !== 'archived') {
      update.deletedAt = new Date();
      update.deletedBy = adminId;
    }
  }

  const doc = await GogetfitPlan.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true }).lean();
  return doc ? toPlanDetail(doc) : null;
};

/**
 * "Delete" archives. The legacy admin never deleted a package, and enrollments
 * point at plans by id - removing the document would orphan that history.
 * Reversible with PATCH { status: "active" }.
 */
export const archivePlan = async (id, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await GogetfitPlan.findByIdAndUpdate(
    id,
    { $set: { status: 'archived', deletedAt: new Date(), deletedBy: adminId, updatedBy: adminId } },
    { new: true },
  ).lean();
  return doc ? toPlanDetail(doc) : null;
};
