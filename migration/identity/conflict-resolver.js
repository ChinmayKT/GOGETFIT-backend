import MigrationConflict, {
  CONFLICT_STATUS,
  CONFLICT_TYPES,
  RESOLUTION_STRATEGIES,
} from '../../src/models/migration-conflict.model.js';
import { tryNormalizePhone } from '../../src/utils/phone.js';

/**
 * Applies an operator's recorded decision to a duplicate-phone group and
 * returns the legacy users that may now be migrated. Nothing here chooses a
 * winner on its own - it only carries out a decision that was made explicitly.
 */
export const applyResolution = (conflict, groupMembers) => {
  if (!conflict.resolution) {
    return { admitted: [], excluded: groupMembers.map((member) => member.legacyUserId) };
  }

  const { strategy, keepLegacyUserId, phoneAssignments } = conflict.resolution;

  if (strategy === RESOLUTION_STRATEGIES.EXCLUDE_ALL) {
    return { admitted: [], excluded: groupMembers.map((member) => member.legacyUserId) };
  }

  if (strategy === RESOLUTION_STRATEGIES.KEEP_ONE) {
    const winner = groupMembers.find((member) => member.legacyUserId === keepLegacyUserId);
    if (!winner) {
      throw new Error(
        `Conflict ${conflict._id}: keepLegacyUserId ${keepLegacyUserId} is not part of this group`,
      );
    }
    return {
      admitted: [winner],
      excluded: groupMembers
        .filter((member) => member.legacyUserId !== keepLegacyUserId)
        .map((member) => member.legacyUserId),
    };
  }

  if (strategy === RESOLUTION_STRATEGIES.REASSIGN_PHONES) {
    const assignments = new Map(
      (phoneAssignments || []).map((entry) => [entry.legacyUserId, entry.phone]),
    );

    const admitted = [];
    const excluded = [];

    for (const member of groupMembers) {
      const assigned = assignments.get(member.legacyUserId);
      if (!assigned) {
        excluded.push(member.legacyUserId);
        continue;
      }

      const normalized = tryNormalizePhone(assigned);
      if (!normalized.ok) {
        throw new Error(
          `Conflict ${conflict._id}: reassigned phone "${assigned}" for legacy user ${member.legacyUserId} is not valid`,
        );
      }

      admitted.push({
        ...member,
        phone: { ok: true, raw: String(assigned).trim(), normalized: normalized.normalized, reason: null },
        document: {
          ...member.document,
          phone: { raw: String(assigned).trim(), normalized: normalized.normalized },
        },
      });
    }

    const seen = new Set();
    for (const member of admitted) {
      if (seen.has(member.phone.normalized)) {
        throw new Error(
          `Conflict ${conflict._id}: reassignment still produces duplicate phone ${member.phone.normalized}`,
        );
      }
      seen.add(member.phone.normalized);
    }

    return { admitted, excluded };
  }

  throw new Error(`Conflict ${conflict._id}: unknown resolution strategy "${strategy}"`);
};

/** Records a decision against a pending conflict. */
export const resolveConflict = async (conflictId, resolution) => {
  const conflict = await MigrationConflict.findById(conflictId);
  if (!conflict) throw new Error(`Conflict ${conflictId} not found`);
  if (conflict.status !== CONFLICT_STATUS.PENDING) {
    throw new Error(`Conflict ${conflictId} is already ${conflict.status}`);
  }
  if (conflict.type !== CONFLICT_TYPES.DUPLICATE_LEGACY_PHONE) {
    throw new Error(
      `Conflict ${conflictId} is of type ${conflict.type}; only DUPLICATE_LEGACY_PHONE is resolvable this way`,
    );
  }

  conflict.resolution = resolution;
  conflict.status = CONFLICT_STATUS.RESOLVED;
  await conflict.save();

  return conflict;
};

export const markConflictApplied = (conflictId) =>
  MigrationConflict.updateOne(
    { _id: conflictId },
    { $set: { status: CONFLICT_STATUS.APPLIED } },
  );
