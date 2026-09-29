import User from '../../src/models/user.model.js';
import logger from '../../src/config/logger.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Writes validated legacy users into MongoDB.
 *
 * Idempotency is enforced by the database, not by the script: the partial
 * unique index on (legacy.source, legacy.userId) makes a second migration of
 * the same legacy account impossible, and the unique index on
 * phone.normalized makes a duplicate login identity impossible. Both are
 * reported as skips rather than being retried or overwritten.
 */
export const loadUsers = async (transformedUsers, { runId, dryRun = false, now = new Date() } = {}) => {
  const summary = {
    attempted: transformedUsers.length,
    inserted: 0,
    skippedAlreadyMigrated: 0,
    skippedDuplicatePhone: 0,
    failed: [],
    insertedLegacyUserIds: [],
  };

  if (transformedUsers.length === 0) return summary;

  if (dryRun) {
    // A dry run still checks the database for pre-existing identities so the
    // report reflects what a real run would actually do.
    const legacyIds = transformedUsers.map((user) => user.legacyUserId);
    const phones = transformedUsers.map((user) => user.document.phone.normalized);

    const [existingLegacy, existingPhones] = await Promise.all([
      User.find({ 'legacy.source': migrationEnv.source, 'legacy.userId': { $in: legacyIds } })
        .select('legacy.userId')
        .lean(),
      User.find({ 'phone.normalized': { $in: phones } })
        .select('phone.normalized')
        .lean(),
    ]);

    const legacySeen = new Set(existingLegacy.map((user) => user.legacy.userId));
    const phoneSeen = new Set(existingPhones.map((user) => user.phone.normalized));

    for (const user of transformedUsers) {
      if (legacySeen.has(user.legacyUserId)) {
        summary.skippedAlreadyMigrated += 1;
      } else if (phoneSeen.has(user.document.phone.normalized)) {
        summary.skippedDuplicatePhone += 1;
      } else {
        summary.inserted += 1;
        summary.insertedLegacyUserIds.push(user.legacyUserId);
      }
    }

    return summary;
  }

  const documents = transformedUsers.map((user) => ({
    ...user.document,
    migration: { runId, migratedAt: now, version: migrationEnv.version },
  }));

  try {
    const inserted = await User.insertMany(documents, { ordered: false, rawResult: true });
    summary.inserted = inserted.insertedCount ?? documents.length;
    summary.insertedLegacyUserIds = transformedUsers.map((user) => user.legacyUserId);
  } catch (error) {
    // insertMany with ordered:false reports per-document failures and still
    // writes everything else.
    summary.inserted = error.insertedDocs?.length ?? error.result?.insertedCount ?? 0;
    summary.insertedLegacyUserIds = (error.insertedDocs || []).map((doc) => doc.legacy?.userId);

    // Mongoose wraps each driver error, so the code and message live one level
    // down on .err; the flat shape is still handled for direct driver errors.
    const writeErrors = (error.writeErrors || []).map((writeError) => {
      const detail = writeError.err || writeError;
      return {
        index: writeError.index ?? detail.index,
        code: detail.code,
        message: detail.errmsg || detail.message || String(writeError),
      };
    });

    const duplicates = writeErrors.filter((writeError) => writeError.code === 11000);

    // A document can violate both unique indexes at once and MongoDB only
    // reports whichever it checked first, so the skip reason is determined from
    // the actual database state rather than from the error message.
    const duplicateDocuments = duplicates.map((writeError) => documents[writeError.index]);
    const alreadyMigrated = new Set();

    if (duplicateDocuments.length > 0) {
      const legacyIds = duplicateDocuments
        .map((document) => document?.legacy?.userId)
        .filter((id) => Number.isInteger(id));

      if (legacyIds.length > 0) {
        const existing = await User.find({
          'legacy.source': migrationEnv.source,
          'legacy.userId': { $in: legacyIds },
        })
          .select('legacy.userId')
          .lean();

        for (const user of existing) alreadyMigrated.add(user.legacy.userId);
      }
    }

    for (const writeError of writeErrors) {
      const failedDocument = documents[writeError.index];
      const legacyUserId = failedDocument?.legacy?.userId ?? null;

      if (writeError.code !== 11000) {
        summary.failed.push({ legacyUserId, reason: writeError.message });
        continue;
      }

      if (alreadyMigrated.has(legacyUserId)) {
        summary.skippedAlreadyMigrated += 1;
      } else if (writeError.message.includes('uniq_phone_normalized')) {
        summary.skippedDuplicatePhone += 1;
      } else {
        summary.failed.push({ legacyUserId, reason: writeError.message });
      }
    }

    if (!error.writeErrors) {
      logger.error('Unexpected load failure', error.message);
      throw error;
    }
  }

  return summary;
};

export default loadUsers;
