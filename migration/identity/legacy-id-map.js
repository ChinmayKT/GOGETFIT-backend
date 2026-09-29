import User from '../../src/models/user.model.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * The only supported way to migrate a legacy child record (payments,
 * enrollments, food logs, ...) is:
 *
 *   t_<table>.user_id  ->  users.legacy.userId  ->  users._id
 *
 * Phone number is the authentication identity and must never be used as a
 * foreign key for historical relationships.
 */
export const buildLegacyIdMap = async (legacyUserIds, { source = migrationEnv.source } = {}) => {
  const ids = [...new Set(legacyUserIds.map(Number).filter((id) => Number.isInteger(id)))];
  if (ids.length === 0) return new Map();

  const users = await User.find({ 'legacy.source': source, 'legacy.userId': { $in: ids } })
    .select('_id legacy.userId')
    .lean();

  return new Map(users.map((user) => [user.legacy.userId, user._id]));
};

/**
 * Resolves one legacy id. Returns null when the legacy account was never
 * migrated (for example because it is stuck in an unresolved conflict) so the
 * caller can quarantine the child record instead of guessing an owner.
 */
export const resolveLegacyUserId = async (legacyUserId, options = {}) => {
  const map = await buildLegacyIdMap([legacyUserId], options);
  return map.get(Number(legacyUserId)) ?? null;
};

/**
 * Re-points a batch of legacy child rows at Mongo user ids. Rows whose owner is
 * unresolved are returned separately and are never written with a guessed or
 * phone-derived owner.
 */
export const mapChildRecords = async (rows, { legacyUserIdField = 'user_id', source } = {}) => {
  const map = await buildLegacyIdMap(
    rows.map((row) => row[legacyUserIdField]),
    { source },
  );

  const resolved = [];
  const unresolved = [];

  for (const row of rows) {
    const legacyUserId = Number(row[legacyUserIdField]);
    const mongoId = map.get(legacyUserId);

    if (mongoId) {
      resolved.push({ row, legacyUserId, userId: mongoId });
    } else {
      unresolved.push({ row, legacyUserId, reason: 'NO_MIGRATED_USER_FOR_LEGACY_USER_ID' });
    }
  }

  return { resolved, unresolved, map };
};

export default buildLegacyIdMap;
