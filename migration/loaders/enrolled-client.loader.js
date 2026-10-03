import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import Coupon from '../../src/models/coupon.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { migrationEnv } from '../config/migration.env.js';
import {
  transformLegacyEnrollment,
  unparseableDates,
} from '../transformers/enrollment.transformer.js';
import { buildCoachDirectory, resolveLegacyCoach } from '../mappings/legacy-coach.mapping.js';

/**
 * Loads legacy enrollments into EnrolledClient.
 *
 * Identity is (legacy.source, legacy.enrollmentId), backed by a partial unique
 * index, so a re-run updates the same documents and can never create a second
 * one for the same legacy enrollment.
 *
 * Every relationship is resolved from an existing mapping; nothing is created
 * here. A row whose member cannot be resolved is skipped and reported, because
 * an enrollment without a member would be a broken reference. A row whose coach
 * or coupon cannot be resolved is still migrated, with the legacy identifier
 * preserved and the gap reported - losing the enrollment would be worse than
 * carrying it with a null coach.
 */

/**
 * Builds the id maps the load needs. Read once, up front, rather than per row.
 *
 * @param {object[]} legacyCoupons - m_coupon rows (coupon_id, coupon_code)
 * @param {object[]} legacyCoaches - m_coach rows, only used when linking by email
 */
export const buildMappings = async ({
  source = migrationEnv.source,
  legacyCoupons = [],
  legacyCoaches = [],
  linkCoachesByEmail = false,
} = {}) => {
  const [users, plans] = await Promise.all([
    User.find({ 'legacy.userId': { $exists: true } }, { 'legacy.userId': 1, roles: 1 }).lean(),
    GogetfitPlan.find(
      { 'legacy.packageId': { $exists: true } },
      { 'legacy.packageId': 1 },
    ).lean(),
  ]);

  const userByLegacyId = new Map(users.map((u) => [u.legacy.userId, u]));
  const planByPackageId = new Map(plans.map((p) => [p.legacy.packageId, p._id]));

  // Legacy coupon codes are not unique (m_coupon has GOGETFIT10 twice), so a
  // code maps to a LIST of legacy coupon ids. A code with more than one is
  // ambiguous and is never resolved by guessing.
  const legacyCouponIdsByCode = new Map();
  for (const row of legacyCoupons) {
    const code = String(row.coupon_code ?? '').trim().toUpperCase();
    if (code === '') continue;
    if (!legacyCouponIdsByCode.has(code)) legacyCouponIdsByCode.set(code, []);
    legacyCouponIdsByCode.get(code).push(Number(row.coupon_id));
  }

  const coupons = await Coupon.find(
    { 'legacy.couponId': { $exists: true } },
    { 'legacy.couponId': 1 },
  ).lean();
  const couponByLegacyId = new Map(coupons.map((c) => [c.legacy.couponId, c._id]));

  /**
   * Legacy coach id -> Coach._id, only when explicitly asked for.
   *
   * The new Coach collection carries no legacy identity, so there is no mapping
   * the legacy data proves. With the flag, a legacy coach is linked when its
   * email matches exactly one new coach's user email - an inference, recorded
   * as such on the document.
   */
  /**
   * Legacy coach id -> the name and email m_coach holds. Built from every run,
   * with or without the link flag: the name is preserved on the enrollment so a
   * screen can say "Karthik M" rather than "coach 17" even where no Coach
   * document exists to point at.
   */
  const coachInfoByLegacyId = new Map();
  for (const row of legacyCoaches) {
    const name = [row.first_name, row.last_name]
      .map((part) => String(part ?? '').trim())
      .filter((part) => part !== '')
      .join(' ');
    coachInfoByLegacyId.set(Number(row.coach_id), {
      name: name === '' ? null : name,
      email: String(row.email ?? '').trim() || null,
    });
  }

  // Legacy coach -> Coach._id through the ONE shared mapping
  // (migration/mappings/legacy-coach.mapping.js): exact email, then exact
  // normalized name, and only when exactly one coach matches. `resolvedBy`
  // records which rule linked it.
  const coachByLegacyId = new Map();
  const coachResolvedByLegacyId = new Map();
  if (linkCoachesByEmail && legacyCoaches.length > 0) {
    const directory = await buildCoachDirectory();
    for (const row of legacyCoaches) {
      const info = coachInfoByLegacyId.get(Number(row.coach_id));
      const result = resolveLegacyCoach({ name: info?.name, email: info?.email }, directory);
      if (result.status === 'matched') {
        coachByLegacyId.set(Number(row.coach_id), new mongoose.Types.ObjectId(result.coach.coachId));
        coachResolvedByLegacyId.set(Number(row.coach_id), result.by);
      }
    }
  }
  // Coaches that exist now, so a link made earlier is only kept while it is valid.
  const existingCoachIds = new Set((await Coach.find({}, { _id: 1 }).lean()).map((c) => String(c._id)));

  return {
    source,
    userByLegacyId,
    planByPackageId,
    legacyCouponIdsByCode,
    couponByLegacyId,
    coachByLegacyId,
    coachResolvedByLegacyId,
    coachInfoByLegacyId,
    existingCoachIds,
  };
};

/** Resolves the coupon for one row. Never picks between ambiguous candidates. */
export const resolveCoupon = (code, mappings) => {
  const normalized = String(code ?? '').trim().toUpperCase();
  if (normalized === '') return { couponId: null, reason: null };

  const legacyIds = mappings.legacyCouponIdsByCode.get(normalized) ?? [];
  if (legacyIds.length === 0) return { couponId: null, reason: 'not_found' };
  if (legacyIds.length > 1) return { couponId: null, reason: 'ambiguous' };

  const couponId = mappings.couponByLegacyId.get(legacyIds[0]) ?? null;
  return { couponId, reason: couponId ? null : 'not_found' };
};

export const loadEnrolledClients = async (
  rows,
  {
    dryRun = true,
    runId = null,
    version = migrationEnv.version,
    mappings,
    updateRoles = true,
  } = {},
) => {
  const summary = {
    inspected: rows.length,
    toCreate: 0,
    toUpdate: 0,
    unchanged: 0,
    created: 0,
    updated: 0,
    rolesUpdated: 0,
    skipped: [],
    conflicts: {
      missingUser: [],
      missingPlan: [],
      missingCoach: [],
      missingCoupon: [],
      ambiguousCoupon: [],
      missingPayment: [],
      malformedDate: [],
      duplicateLegacyId: [],
      unknownPaymentStatus: [],
    },
    errors: [],
  };

  const seenLegacyIds = new Set();
  const documents = [];

  for (const row of rows) {
    const doc = transformLegacyEnrollment(row, { source: mappings.source });
    const legacyId = doc.legacy.enrollmentId;

    if (legacyId === null) {
      // Without an identity a re-run could not recognise the document.
      summary.skipped.push({ enrollmentId: null, reason: 'no legacy enrollment_id' });
      continue;
    }
    if (seenLegacyIds.has(legacyId)) {
      summary.conflicts.duplicateLegacyId.push(legacyId);
      continue;
    }
    seenLegacyIds.add(legacyId);

    // --- relationships ---
    const user = mappings.userByLegacyId.get(doc.legacy.userId);
    if (!user) {
      // An enrollment with no member is not migrated: the reference would be
      // broken and no member can be invented.
      summary.conflicts.missingUser.push({
        enrollmentId: legacyId,
        legacyUserId: doc.legacy.userId,
      });
      summary.skipped.push({ enrollmentId: legacyId, reason: 'missing user' });
      continue;
    }

    const planId = mappings.planByPackageId.get(doc.legacy.packageId) ?? null;
    if (!planId) {
      summary.conflicts.missingPlan.push({
        enrollmentId: legacyId,
        legacyPackageId: doc.legacy.packageId,
      });
      summary.skipped.push({ enrollmentId: legacyId, reason: 'missing plan' });
      continue;
    }

    // The legacy coach's own details, whether or not a Coach document was found.
    const coachInfo = mappings.coachInfoByLegacyId?.get(doc.legacy.coachId) ?? null;
    doc.legacy.coachName = coachInfo?.name ?? null;
    doc.legacy.coachEmail = coachInfo?.email ?? null;

    const coachId = mappings.coachByLegacyId.get(doc.legacy.coachId) ?? null;
    if (!coachId) {
      summary.conflicts.missingCoach.push({
        enrollmentId: legacyId,
        legacyCoachId: doc.legacy.coachId,
      });
    } else {
      doc.legacy.coachResolvedBy = mappings.coachResolvedByLegacyId?.get(doc.legacy.coachId) ?? 'email';
    }

    const { couponId, reason } = resolveCoupon(doc.legacy.couponCode, mappings);
    doc.legacy.couponUnresolvedReason = reason;
    if (reason === 'ambiguous') {
      summary.conflicts.ambiguousCoupon.push({
        enrollmentId: legacyId,
        couponCode: doc.legacy.couponCode,
      });
    } else if (reason === 'not_found') {
      summary.conflicts.missingCoupon.push({
        enrollmentId: legacyId,
        couponCode: doc.legacy.couponCode,
      });
    }

    // --- data quality, reported and preserved rather than repaired ---
    if (!row.p_transaction_id) {
      summary.conflicts.missingPayment.push({
        enrollmentId: legacyId,
        transactionId: doc.payment.transactionId,
      });
    }
    const badDates = unparseableDates(row);
    if (badDates.length > 0) {
      summary.conflicts.malformedDate.push({ enrollmentId: legacyId, fields: badDates });
    }
    if (doc.payment.status !== null && doc.payment.status !== 'Success') {
      // 'Success' is the only value the legacy data has ever held; anything
      // else is stored verbatim and flagged rather than mapped to a guess.
      summary.conflicts.unknownPaymentStatus.push({
        enrollmentId: legacyId,
        status: doc.payment.status,
      });
    }

    documents.push({ doc, userId: user._id, planId, coachId, couponId, roles: user.roles ?? [] });
  }

  // What already exists, so the run can report create vs update honestly.
  const existing = await EnrolledClient.collection
    .find(
      {
        'legacy.source': mappings.source,
        'legacy.enrollmentId': { $in: documents.map((d) => d.doc.legacy.enrollmentId) },
      },
      {
        projection: {
          'legacy.enrollmentId': 1,
          'legacy.coachName': 1,
          'legacy.coachEmail': 1,
          'legacy.coachResolvedBy': 1,
          userId: 1,
          planId: 1,
          coachId: 1,
          couponId: 1,
          payment: 1,
          enrollDate: 1,
          startDate: 1,
          endDate: 1,
          hasStarted: 1,
          isDeleted: 1,
        },
      },
    )
    .toArray();
  const existingByLegacyId = new Map(existing.map((d) => [d.legacy.enrollmentId, d]));

  const operations = [];
  const usersNeedingRole = new Set();

  for (const entry of documents) {
    const { doc, userId, planId, couponId } = entry;
    let { coachId } = entry;
    const current = existingByLegacyId.get(doc.legacy.enrollmentId);

    // Never undo a coach link: when this run resolves no coach but the stored
    // enrollment already points at a coach that still exists (linked by an
    // earlier run or by link-legacy-coaches), that link - and how it was made -
    // is kept.
    if (!coachId && current?.coachId && mappings.existingCoachIds?.has(String(current.coachId))) {
      coachId = current.coachId;
      doc.legacy.coachResolvedBy = current.legacy?.coachResolvedBy ?? null;
      summary.conflicts.missingCoach = summary.conflicts.missingCoach.filter((m) => m.enrollmentId !== doc.legacy.enrollmentId);
    }

    if (!current) summary.toCreate += 1;
    else if (isSame(current, { ...doc, userId, planId, coachId, couponId })) {
      summary.unchanged += 1;
      if (!entry.roles.includes('client')) usersNeedingRole.add(String(userId));
      continue;
    } else summary.toUpdate += 1;

    if (!entry.roles.includes('client')) usersNeedingRole.add(String(userId));

    operations.push({
      updateOne: {
        filter: {
          'legacy.source': mappings.source,
          'legacy.enrollmentId': doc.legacy.enrollmentId,
        },
        update: {
          $set: {
            userId,
            planId,
            coachId,
            couponId,
            enrollDate: doc.enrollDate,
            startDate: doc.startDate,
            endDate: doc.endDate,
            hasStarted: doc.hasStarted,
            isDeleted: doc.isDeleted,
            payment: doc.payment,
            legacy: doc.legacy,
            migration: { runId, migratedAt: new Date(), version },
          },
          $setOnInsert: { createdBy: null, updatedBy: null },
        },
        upsert: true,
      },
    });
  }

  summary.rolesToUpdate = usersNeedingRole.size;

  if (dryRun) return summary;

  if (operations.length > 0) {
    try {
      const result = await EnrolledClient.collection.bulkWrite(operations, { ordered: false });
      summary.created = result.upsertedCount ?? 0;
      summary.updated = result.modifiedCount ?? 0;
    } catch (error) {
      for (const writeError of error.writeErrors || []) {
        const detail = writeError.err || writeError;
        summary.errors.push(detail.errmsg || detail.message || String(writeError));
      }
      if (!error.writeErrors) throw error;
    }
  }

  if (updateRoles && usersNeedingRole.size > 0) {
    // $addToSet, so an existing coach or admin grant is kept: ["user","coach"]
    // becomes ["user","coach","client"], never ["client"].
    const result = await User.updateMany(
      { _id: { $in: [...usersNeedingRole].map((id) => new mongoose.Types.ObjectId(id)) } },
      { $addToSet: { roles: 'client' } },
    );
    summary.rolesUpdated = result.modifiedCount ?? 0;
  }

  return summary;
};

/** Whether the stored document already matches the source, field by field. */
const isSame = (current, next) => {
  const id = (value) => (value ? String(value) : null);
  if (id(current.userId) !== id(next.userId)) return false;
  if (id(current.planId) !== id(next.planId)) return false;
  if (id(current.coachId) !== id(next.coachId)) return false;
  if (id(current.couponId) !== id(next.couponId)) return false;

  // The legacy coach's name, so a run that first learns it updates the document.
  if ((current.legacy?.coachName ?? null) !== (next.legacy?.coachName ?? null)) return false;
  if ((current.legacy?.coachEmail ?? null) !== (next.legacy?.coachEmail ?? null)) return false;

  const date = (value) => (value ? new Date(value).getTime() : null);
  if (date(current.enrollDate) !== date(next.enrollDate)) return false;
  if (date(current.startDate) !== date(next.startDate)) return false;
  if (date(current.endDate) !== date(next.endDate)) return false;
  if (Boolean(current.hasStarted) !== Boolean(next.hasStarted)) return false;
  if (Boolean(current.isDeleted) !== Boolean(next.isDeleted)) return false;

  const a = current.payment ?? {};
  const b = next.payment ?? {};
  for (const key of [
    'transactionId',
    'amount',
    'currency',
    'originalAmount',
    'discountPercent',
    'status',
    'referenceId',
    'description',
    'customerName',
    'contact',
    'email',
  ]) {
    if ((a[key] ?? null) !== (b[key] ?? null)) return false;
  }
  if (date(a.paidAt) !== date(b.paidAt)) return false;

  return true;
};

export default loadEnrolledClients;
