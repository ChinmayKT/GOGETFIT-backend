import MigrationConflict, {
  CONFLICT_STATUS,
  CONFLICT_TYPES,
} from '../../src/models/migration-conflict.model.js';
import { groupByNormalizedPhone } from './phone-grouper.js';

/**
 * Turns grouping output into conflict records. A duplicate phone group is never
 * merged, never arbitrarily narrowed to one winner, and never silently dropped:
 * it becomes a pending decision that a human must resolve.
 */
export const detectConflicts = (transformedUsers) => {
  const { unique, duplicates, unusable } = groupByNormalizedPhone(transformedUsers);

  const conflicts = [];

  for (const group of duplicates) {
    conflicts.push({
      type: CONFLICT_TYPES.DUPLICATE_LEGACY_PHONE,
      phone: group.phone,
      legacyUserIds: group.members.map((member) => member.legacyUserId),
      details: {
        members: group.members.map((member) => ({
          legacyUserId: member.legacyUserId,
          rawPhone: member.phone.raw,
          name: member.document.profile.name,
          dateOfBirth: member.document.profile.dateOfBirth,
          city: member.document.profile.city,
        })),
      },
    });
  }

  for (const member of unusable) {
    const type =
      member.phone.reason === 'MISSING'
        ? CONFLICT_TYPES.MISSING_LEGACY_PHONE
        : CONFLICT_TYPES.INVALID_LEGACY_PHONE;

    conflicts.push({
      type,
      // Keyed by legacy id because there is no usable phone to key on.
      phone: `legacy:${member.legacyUserId}`,
      legacyUserIds: [member.legacyUserId],
      details: { rawPhone: member.phone.raw, reason: member.phone.reason },
    });
  }

  return { migratable: unique, conflicts, duplicateGroups: duplicates, unusable };
};

/** Persists conflicts for a run. Re-running the same runId is idempotent. */
export const persistConflicts = async (runId, conflicts) => {
  if (conflicts.length === 0) return { created: 0, existing: 0 };

  const operations = conflicts.map((conflict) => ({
    updateOne: {
      // Keyed by identity, not by run, so a re-run refreshes the existing
      // record rather than opening a second pending decision.
      filter: { type: conflict.type, phone: conflict.phone },
      update: {
        $setOnInsert: {
          runId,
          type: conflict.type,
          phone: conflict.phone,
          status: CONFLICT_STATUS.PENDING,
          resolution: null,
        },
        // Refreshed every run so a decision is always made against the current
        // state of the legacy data.
        $set: {
          lastSeenRunId: runId,
          legacyUserIds: conflict.legacyUserIds,
          details: conflict.details,
        },
        $addToSet: { seenInRuns: runId },
      },
      upsert: true,
    },
  }));

  const result = await MigrationConflict.bulkWrite(operations, { ordered: false });

  return {
    created: result.upsertedCount ?? 0,
    existing: conflicts.length - (result.upsertedCount ?? 0),
  };
};

export const listPendingConflicts = (runId = null) =>
  MigrationConflict.find(
    runId ? { runId, status: CONFLICT_STATUS.PENDING } : { status: CONFLICT_STATUS.PENDING },
  ).sort({ type: 1, phone: 1 });

export default detectConflicts;
