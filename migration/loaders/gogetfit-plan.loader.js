import GogetfitPlan, { PLAN_LEVELS, PLAN_TYPES } from '../../src/models/gogetfit-plan.model.js';
import { migrationEnv } from '../config/migration.env.js';
import { transformLegacyPackage } from '../transformers/package.transformer.js';

/**
 * Loads legacy packages into GogetfitPlan.
 *
 * Identity is (legacy.source, legacy.packageId), backed by a partial unique
 * index, so re-running updates the same documents and never creates a copy.
 *
 * A plan an admin has already edited in the new portal (updatedBy is set) is a
 * CONFLICT: it is reported and left alone rather than overwritten from legacy.
 */

/** The fields compared between legacy and Mongo, as plain comparable values. */
export const comparable = (plan) => ({
  name: plan.name ?? null,
  planType: plan.planType ?? null,
  coachLevel: plan.coachLevel ?? null,
  durationWeeks: plan.durationWeeks ?? null,
  personsAllowed: plan.personsAllowed ?? null,
  basePrice: plan.pricing?.basePrice ?? null,
  reward: plan.pricing?.reward ?? null,
  description: plan.content?.description ?? null,
  inclusions: plan.content?.inclusions ?? null,
  whatNext: plan.content?.whatNext ?? null,
  termsAndConditions: plan.content?.termsAndConditions ?? null,
  eligibility: plan.content?.eligibility ?? null,
  legacyCreatedBy: plan.legacy?.createdBy ?? null,
  legacyUpdatedAt: plan.legacy?.updatedAt ? new Date(plan.legacy.updatedAt).toISOString() : null,
  legacyUpdatedBy: plan.legacy?.updatedBy ?? null,
});

export const diffFields = (a, b) => {
  const left = comparable(a);
  const right = comparable(b);
  return Object.keys(left).filter((key) => left[key] !== right[key]);
};

export const loadGogetfitPlans = async (
  rows,
  { dryRun = true, source = migrationEnv.source, runId = null, version = migrationEnv.version } = {},
) => {
  const summary = {
    inspected: rows.length,
    toCreate: 0,
    toUpdate: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    conflicts: [],
    errors: [],
    duplicateLegacyIds: [],
    quality: {
      unknownTypes: {},
      unknownLevels: {},
      challengeWithoutReward: [],
      enrollmentWithReward: [],
      zeroDuration: [],
      zeroPersons: [],
      leadingQuoteInclusions: [],
    },
  };

  const seen = new Set();
  for (const row of rows) {
    const { plan, errors } = transformLegacyPackage(row, { source });
    const id = plan.legacy.packageId;

    if (errors.length > 0) {
      summary.errors.push(`package ${row.package_id}: ${errors.join('; ')}`);
      continue;
    }
    if (seen.has(id)) {
      summary.duplicateLegacyIds.push(id);
      continue;
    }
    seen.add(id);

    const q = summary.quality;
    if (!PLAN_TYPES.includes(plan.planType)) q.unknownTypes[plan.planType] = (q.unknownTypes[plan.planType] ?? 0) + 1;
    if (plan.coachLevel !== null && !PLAN_LEVELS.includes(plan.coachLevel)) {
      q.unknownLevels[plan.coachLevel] = (q.unknownLevels[plan.coachLevel] ?? 0) + 1;
    }
    if (plan.planType === 'Challenge' && !plan.pricing.reward) q.challengeWithoutReward.push(id);
    if (plan.planType === 'Enrollment' && plan.pricing.reward) q.enrollmentWithReward.push(id);
    if (plan.durationWeeks === 0) q.zeroDuration.push(id);
    if (plan.personsAllowed === 0) q.zeroPersons.push(id);
    if (plan.content.inclusions?.startsWith('"')) q.leadingQuoteInclusions.push(id);

    try {
      const existing = await GogetfitPlan.findOne({ 'legacy.source': source, 'legacy.packageId': id }).lean();

      if (!existing) {
        summary.toCreate += 1;
        if (!dryRun) {
          await GogetfitPlan.create({ ...plan, migration: { runId, migratedAt: new Date(), version } });
          summary.created += 1;
        }
        continue;
      }

      const changed = diffFields(existing, plan);
      if (changed.length === 0) {
        summary.unchanged += 1;
        continue;
      }
      if (existing.updatedBy) {
        summary.conflicts.push({ packageId: id, planId: String(existing._id), fields: changed, reason: 'edited in the new admin portal' });
        continue;
      }

      summary.toUpdate += 1;
      if (!dryRun) {
        await GogetfitPlan.updateOne(
          { _id: existing._id },
          {
            $set: {
              name: plan.name,
              planType: plan.planType,
              coachLevel: plan.coachLevel,
              durationWeeks: plan.durationWeeks,
              personsAllowed: plan.personsAllowed,
              pricing: plan.pricing,
              content: plan.content,
              legacy: plan.legacy,
              migration: { runId, migratedAt: new Date(), version },
            },
          },
        );
        summary.updated += 1;
      }
    } catch (error) {
      summary.errors.push(`package ${id}: ${error.message}`);
    }
  }

  return summary;
};

/**
 * Independent check after a run: every legacy row must have exactly one plan
 * whose fields equal the source, and no migrated plan may lack a legacy row.
 */
export const verifyGogetfitPlans = async (rows, { source = migrationEnv.source } = {}) => {
  const docs = await GogetfitPlan.find({ 'legacy.source': source, 'legacy.packageId': { $type: 'number' } }).lean();
  const byId = new Map(docs.map((doc) => [doc.legacy.packageId, doc]));
  const legacyIds = new Set();

  const result = { legacyCount: rows.length, mongoCount: docs.length, missing: [], mismatches: [], extra: [] };
  for (const row of rows) {
    const { plan } = transformLegacyPackage(row, { source });
    legacyIds.add(plan.legacy.packageId);
    const doc = byId.get(plan.legacy.packageId);
    if (!doc) {
      result.missing.push(plan.legacy.packageId);
      continue;
    }
    const fields = diffFields(doc, plan);
    if (fields.length > 0) result.mismatches.push({ packageId: plan.legacy.packageId, fields, editedInPortal: Boolean(doc.updatedBy) });
  }
  for (const doc of docs) if (!legacyIds.has(doc.legacy.packageId)) result.extra.push(doc.legacy.packageId);
  return result;
};
