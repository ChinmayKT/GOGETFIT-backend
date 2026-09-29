import User from '../../src/models/user.model.js';
import { CONFLICT_TYPES } from '../../src/models/migration-conflict.model.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Partitions migration candidates against what MongoDB already holds, BEFORE
 * anything is written. Three outcomes:
 *
 *   alreadyMigrated - this legacy account already has a Mongo user. It is not
 *                     inserted again and it is not overwritten.
 *   phoneCollision  - the phone belongs to a DIFFERENT Mongo user (a natively
 *                     registered user, or another legacy account). Neither user
 *                     is touched; the row becomes a conflict and is skipped.
 *   insertable      - genuinely new identities.
 *
 * The unique indexes remain the real guarantee; this check exists so the dry
 * run can report accurate numbers and so collisions surface as conflicts
 * rather than as anonymous skip counters.
 */
export const partitionAgainstExisting = async (candidates, { source = migrationEnv.source } = {}) => {
  const result = { insertable: [], alreadyMigrated: [], phoneCollision: [], conflicts: [] };

  if (candidates.length === 0) return result;

  const legacyIds = candidates.map((candidate) => candidate.legacyUserId);
  const phones = candidates.map((candidate) => candidate.document.phone.normalized);

  const [existingLegacy, existingPhones] = await Promise.all([
    User.find({ 'legacy.source': source, 'legacy.userId': { $in: legacyIds } })
      .select('_id legacy.userId')
      .lean(),
    User.find({ 'phone.normalized': { $in: phones } })
      .select('_id phone.normalized legacy')
      .lean(),
  ]);

  const legacyOwners = new Map(existingLegacy.map((user) => [user.legacy.userId, user._id]));
  const phoneOwners = new Map(existingPhones.map((user) => [user.phone.normalized, user]));

  for (const candidate of candidates) {
    const phone = candidate.document.phone.normalized;
    const existingByLegacy = legacyOwners.get(candidate.legacyUserId);

    if (existingByLegacy) {
      result.alreadyMigrated.push({ candidate, userId: existingByLegacy });
      continue;
    }

    const existingByPhone = phoneOwners.get(phone);

    if (existingByPhone) {
      result.phoneCollision.push({ candidate, userId: existingByPhone._id });
      result.conflicts.push({
        type: CONFLICT_TYPES.PHONE_COLLISION_WITH_EXISTING_USER,
        phone,
        legacyUserIds: [candidate.legacyUserId],
        details: {
          existingUserId: String(existingByPhone._id),
          existingLegacyUserId: existingByPhone.legacy?.userId ?? null,
          existingIsNativeUser: !existingByPhone.legacy,
          rawPhone: candidate.document.phone.raw,
        },
      });
      continue;
    }

    result.insertable.push(candidate);
  }

  return result;
};

export default partitionAgainstExisting;
