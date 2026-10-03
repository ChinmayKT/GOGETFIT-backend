import Coupon from '../../src/models/coupon.model.js';
import User from '../../src/models/user.model.js';
import { ROLE_ADMIN } from '../../src/constants/roles.js';
import { migrationEnv } from '../config/migration.env.js';
import { transformLegacyCoupon } from '../transformers/coupon.transformer.js';
import { getCouponStatus } from '../../src/utils/coupon-status.js';

/**
 * m_coupon -> coupons.
 *
 * Identity is (legacy.source, legacy.couponId) - never the code, which legacy
 * does not keep unique. Rules:
 *   - malformed rows (date/discount/code) are reported and not inserted;
 *   - codes are unique across ALL coupons (there is no archived state). When
 *     legacy rows share a code, a live row (delete_flg 0) is taken before a
 *     deleted one, then the lower coupon_id; every other row with that code is
 *     reported as a conflict - never merged, deleted or renamed;
 *   - a coupon an admin has edited since migration (updatedBy set) is a
 *     conflict and is never overwritten.
 */

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Every legacy coupon was created by this admin (confirmed by the business). */
export const LEGACY_COUPON_CREATOR_EMAIL = 'prajwal@gogetfitonline.com';

export class CouponCreatorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CouponCreatorError';
  }
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The existing admin who owns every migrated legacy coupon. Looked up - never
 * created, never guessed. Throws (stopping the migration before any write) when
 * the email matches no user, more than one user, or a user without the admin role.
 */
export const resolveLegacyCouponCreator = async (email = LEGACY_COUPON_CREATOR_EMAIL) => {
  const matches = await User.find(
    { 'profile.email': new RegExp(`^${escapeRegex(email.trim())}$`, 'i') },
    { _id: 1, 'profile.email': 1, 'profile.name': 1, roles: 1, status: 1 },
  ).lean();

  if (matches.length === 0) throw new CouponCreatorError(`No user has the email ${email}; stopping - no coupon was written`);
  if (matches.length > 1) {
    throw new CouponCreatorError(`${matches.length} users have the email ${email} (${matches.map((u) => u._id).join(', ')}); stopping - resolve the duplicate first`);
  }
  const [user] = matches;
  if (!Array.isArray(user.roles) || !user.roles.includes(ROLE_ADMIN)) {
    throw new CouponCreatorError(`User ${user._id} (${email}) is not an admin; stopping - no coupon was written`);
  }
  return { id: user._id, email: user.profile?.email ?? email, name: user.profile?.name ?? null, roles: user.roles };
};

/**
 * "Edited in the admin portal since migration": the document changed after the
 * migration last wrote it. (updatedBy can no longer tell - the creator owns
 * every migrated coupon, and may edit one too.)
 */
// The first run stamped migratedAt a few ms before save set updatedAt; runs now
// stamp them equal. The tolerance only absorbs that first-run gap.
const EDIT_TOLERANCE_MS = 1000;
export const editedSinceMigration = (doc) =>
  Boolean(doc.migration?.migratedAt && doc.updatedAt) &&
  doc.updatedAt.getTime() - doc.migration.migratedAt.getTime() > EDIT_TOLERANCE_MS;

/** The migrated fields, as plain comparable values. */
export const comparable = (c) => ({
  code: c.code ?? null,
  description: c.description ?? null,
  discountType: c.discount?.type ?? null,
  discountValue: c.discount?.value ?? null,
  validFrom: iso(c.validFrom),
  validTo: iso(c.validTo),
  visibility: c.visibility ?? null,
  deleted: Boolean(c.legacy?.deleted),
  auditCreatedBy: c.legacy?.auditCreatedBy ?? null,
  auditUpdatedBy: c.legacy?.auditUpdatedBy ?? null,
  auditUpdatedAt: iso(c.legacy?.auditUpdatedAt),
});

export const diffFields = (a, b) => {
  const left = comparable(a);
  const right = comparable(b);
  return Object.keys(left).filter((k) => left[k] !== right[k]);
};

export const loadCoupons = async (
  rows,
  { creatorId, dryRun = true, source = migrationEnv.source, runId = null, version = migrationEnv.version } = {},
) => {
  if (!creatorId) throw new CouponCreatorError('creatorId is required: resolve the legacy coupon creator first');
  const creator = String(creatorId);
  const summary = {
    createdByMapped: 0,
    updatedByMapped: 0,
    legacyRows: rows.length,
    toCreate: 0,
    toUpdate: 0,
    created: 0,
    updated: 0,
    alreadyMigrated: 0,
    skipped: [],
    malformed: [],
    conflicts: [],
    errors: [],
    malformedDates: 0,
    malformedDiscounts: 0,
    /** active/inactive = the date-driven status today; deleted = legacy delete_flg. */
    counts: { active: 0, inactive: 0, deleted: 0, public: 0, private: 0 },
    duplicateCodes: [],
    activeDuplicateConflicts: [],
    idMap: [],
  };

  // Duplicate code/status combinations in the source, reported up front.
  const byCode = new Map();
  for (const row of rows) {
    const t = transformLegacyCoupon(row, { source });
    if (!t.code) continue;
    if (!byCode.has(t.code)) byCode.set(t.code, []);
    byCode.get(t.code).push({ couponId: t.couponId, deleted: t.coupon.legacy.deleted });
  }
  for (const [code, list] of byCode) if (list.length > 1) summary.duplicateCodes.push({ code, coupons: list });

  // Codes already used in MongoDB by documents OTHER than these legacy rows'
  // own migrated copies (e.g. a coupon created in the portal).
  const legacyIds = rows.map((r) => Number(r.coupon_id)).filter(Number.isInteger);
  const taken = new Map(
    (await Coupon.find(
      { $nor: [{ 'legacy.source': source, 'legacy.couponId': { $in: legacyIds } }] },
      { code: 1, legacy: 1 },
    ).lean()).map((c) => [c.code, `mongo ${c._id}${c.legacy?.couponId ? ` (legacy ${c.legacy.couponId})` : ' (created in the portal)'}`]),
  );
  // Codes held by these legacy rows' own existing copies: a copy keeps its code.
  for (const c of await Coupon.find({ 'legacy.source': source, 'legacy.couponId': { $in: legacyIds } }, { code: 1, legacy: 1 }).lean()) {
    if (!taken.has(c.code)) taken.set(c.code, `legacy ${c.legacy.couponId}`);
  }

  // Live rows claim a shared code before deleted ones; then coupon_id order.
  const ordered = [...rows].sort((a, b) => {
    const da = String(a.delete_flg ?? '').trim() === '1' ? 1 : 0;
    const db = String(b.delete_flg ?? '').trim() === '1' ? 1 : 0;
    return da - db || Number(a.coupon_id) - Number(b.coupon_id);
  });

  const seen = new Set();
  for (const row of ordered) {
    const t = transformLegacyCoupon(row, { source });
    const ref = { couponId: t.couponId ?? row.coupon_id, code: t.rawCode };

    if (t.couponId !== null && seen.has(t.couponId)) {
      summary.skipped.push({ ...ref, reason: 'duplicate coupon_id in the source' });
      continue;
    }
    if (t.couponId !== null) seen.add(t.couponId);

    if (t.problems.length > 0) {
      if (t.malformedDate) summary.malformedDates += 1;
      if (t.malformedDiscount) summary.malformedDiscounts += 1;
      summary.malformed.push({ ...ref, reason: t.problems.join('; ') });
      continue;
    }

    const { coupon } = t;
    const tally = (status) => {
      summary.counts[status] += 1;
      summary.counts[coupon.visibility] += 1;
      if (coupon.legacy.deleted) summary.counts.deleted += 1;
    };

    try {
      const existing = await Coupon.findOne({ 'legacy.source': source, 'legacy.couponId': t.couponId }).lean();

      if (!existing) {
        const clash = taken.get(coupon.code);
        if (clash) {
          const conflict = { ...ref, reason: `duplicate code: "${coupon.code}" is already used by ${clash}` };
          summary.conflicts.push(conflict);
          summary.activeDuplicateConflicts.push(conflict);
          continue;
        }
        summary.toCreate += 1;
        let id = null;
        if (!dryRun) {
          const created = await Coupon.create({
            ...coupon,
            createdBy: creatorId,
            updatedBy: creatorId,
            migration: { runId, migratedAt: new Date(), version },
          });
          // Stamp migratedAt == updatedAt exactly, so a later portal edit is detectable.
          await Coupon.collection.updateOne({ _id: created._id }, { $set: { 'migration.migratedAt': created.updatedAt } });
          summary.created += 1;
          id = String(created._id);
        }
        summary.createdByMapped += 1;
        summary.updatedByMapped += 1;
        taken.set(coupon.code, `legacy ${t.couponId}`);
        const status = getCouponStatus(coupon.validFrom, coupon.validTo);
        tally(status);
        summary.idMap.push({ couponId: t.couponId, code: coupon.code, mongoId: id, status, deleted: coupon.legacy.deleted });
        continue;
      }

      // Ownership. Null -> the creator; the creator -> fine; anyone else -> report,
      // never replace. A later portal edit legitimately changes updatedBy.
      const edited = editedSinceMigration(existing);
      const ownership = {};
      const ownerConflicts = [];
      if (existing.createdBy == null) ownership.createdBy = creatorId;
      else if (String(existing.createdBy) !== creator) ownerConflicts.push(`createdBy is ${existing.createdBy}`);
      if (existing.updatedBy == null) ownership.updatedBy = creatorId;
      else if (String(existing.updatedBy) !== creator && !edited) ownerConflicts.push(`updatedBy is ${existing.updatedBy}`);

      if (ownerConflicts.length > 0) {
        summary.conflicts.push({
          ...ref,
          mongoId: String(existing._id),
          reason: `different owner than the legacy creator ${creator}: ${ownerConflicts.join('; ')} - not replaced`,
        });
        continue;
      }
      if (Object.keys(ownership).length > 0) {
        if (!dryRun) {
          // createdBy is immutable in the model (by design, for the API); the
          // one sanctioned write is filling a NULL owner here, so it goes to the
          // driver directly - guarded on null so nothing else can be replaced.
          const now = new Date();
          for (const [field, value] of Object.entries(ownership)) {
            await Coupon.collection.updateOne(
              { _id: existing._id, [field]: null },
              { $set: { [field]: value, updatedAt: now, 'migration.migratedAt': now, 'migration.runId': runId } },
            );
          }
        }
        if (ownership.createdBy) summary.createdByMapped += 1;
        if (ownership.updatedBy) summary.updatedByMapped += 1;
      }

      const changed = diffFields(existing, coupon);
      if (changed.length === 0) {
        summary.alreadyMigrated += 1;
      } else if (edited) {
        summary.conflicts.push({ ...ref, mongoId: String(existing._id), reason: `edited in the admin portal since migration; differs in: ${changed.join(', ')}` });
        continue;
      } else {
        const clash = coupon.code !== existing.code ? taken.get(coupon.code) : undefined;
        if (clash) {
          const conflict = { ...ref, mongoId: String(existing._id), reason: `duplicate code: "${coupon.code}" is already used by ${clash}` };
          summary.conflicts.push(conflict);
          summary.activeDuplicateConflicts.push(conflict);
          continue;
        }
        summary.toUpdate += 1;
        if (!dryRun) {
          const now = new Date();
          await Coupon.collection.updateOne(
            { _id: existing._id },
            {
              $set: {
                code: coupon.code,
                description: coupon.description,
                discount: coupon.discount,
                validFrom: coupon.validFrom,
                validTo: coupon.validTo,
                visibility: coupon.visibility,
                legacy: coupon.legacy,
                updatedAt: now,
                migration: { runId, migratedAt: now, version },
              },
            },
          );
          summary.updated += 1;
        }
      }
      const status = getCouponStatus(coupon.validFrom, coupon.validTo);
      tally(status);
      summary.idMap.push({ couponId: t.couponId, code: coupon.code, mongoId: String(existing._id), status, deleted: coupon.legacy.deleted });
    } catch (error) {
      if (error?.code === 11000) {
        const conflict = { ...ref, reason: `active duplicate code rejected by the database index: "${coupon.code}"` };
        summary.conflicts.push(conflict);
        summary.activeDuplicateConflicts.push(conflict);
      } else {
        summary.errors.push({ ...ref, reason: error.message });
      }
    }
  }

  return summary;
};

/**
 * Independent re-read of MongoDB after a run: every migrated row present once
 * with the right fields, the invariants of the new model, and portal coupons
 * untouched (no legacy object).
 */
export const verifyCoupons = async (rows, { source = migrationEnv.source, expectedIds = null, creatorId = null } = {}) => {
  const docs = await Coupon.find({ 'legacy.source': source }).lean();
  const byLegacy = new Map();
  const duplicateLegacyIds = [];
  for (const d of docs) {
    if (byLegacy.has(d.legacy.couponId)) duplicateLegacyIds.push(d.legacy.couponId);
    byLegacy.set(d.legacy.couponId, d);
  }

  const problems = [];
  for (const d of docs) {
    const where = `legacy ${d.legacy?.couponId} (mongo ${d._id})`;
    if (typeof d.legacy?.couponId !== 'number') problems.push(`${where}: legacy.couponId missing`);
    if (d.code !== d.code.trim().toUpperCase()) problems.push(`${where}: code not normalised`);
    if (!(d.validFrom instanceof Date) || !(d.validTo instanceof Date)) problems.push(`${where}: dates are not Date values`);
    if (d.discount?.type !== 'percent' || typeof d.discount?.value !== 'number') problems.push(`${where}: discount shape`);
    if (creatorId) {
      if (String(d.createdBy) !== String(creatorId)) problems.push(`${where}: createdBy is ${d.createdBy}, expected ${creatorId}`);
      if (String(d.updatedBy) !== String(creatorId) && !editedSinceMigration(d)) problems.push(`${where}: updatedBy is ${d.updatedBy}, expected ${creatorId}`);
    }
    if (!d.legacy?.auditCreatedBy && d.legacy?.auditCreatedBy !== null) problems.push(`${where}: legacy.auditCreatedBy missing`);
  }

  const mismatches = [];
  for (const row of rows) {
    const t = transformLegacyCoupon(row, { source });
    if (t.problems.length > 0) continue;
    if (expectedIds && !expectedIds.has(t.couponId)) continue;
    const doc = byLegacy.get(t.couponId);
    if (!doc) continue;
    const fields = diffFields(doc, t.coupon);
    if (fields.length) mismatches.push({ couponId: t.couponId, fields, editedInPortal: Boolean(doc.updatedBy) });
  }

  // Portal coupons are the ones without legacy data; none may have gained any.
  const portalWithLegacy = await Coupon.countDocuments({ legacy: { $exists: true }, 'legacy.source': { $ne: source } });
  return { migratedInMongo: docs.length, duplicateLegacyIds, problems, mismatches, portalCouponsWithLegacy: portalWithLegacy };
};
