/**
 * Post-apply validation of migrated MongoDB users.
 *
 *   node migration/scripts/validate-migration.js
 *   node migration/scripts/validate-migration.js --run-id <runId>
 *
 * Read-only against MongoDB. Does not touch MariaDB at all. Exits non-zero if
 * any check fails, so it can gate a migration rehearsal.
 */
import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import User, { isProfileComplete } from '../../src/models/user.model.js';
import MigrationConflict, { CONFLICT_STATUS } from '../../src/models/migration-conflict.model.js';
import { calculateAge } from '../../src/utils/age.js';
import { migrationEnv } from '../config/migration.env.js';

const FORBIDDEN_KEYS = [
  'password',
  'login_token',
  'loginToken',
  'otp',
  'otp_expiry',
  'otpExpiry',
  'registration_otp',
  'registrationOtp',
];

const collectKeys = (value, keys = new Set()) => {
  if (value === null || typeof value !== 'object' || value instanceof Date) return keys;
  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    collectKeys(nested, keys);
  }
  return keys;
};

export const validateMigration = async ({ runId = null, now = new Date() } = {}) => {
  const scope = runId
    ? { 'migration.runId': runId }
    : { 'legacy.source': migrationEnv.source, 'legacy.userId': { $exists: true } };

  const migrated = await User.find(scope).lean();
  const checks = [];

  const record = (name, passed, detail) => {
    checks.push({ name, passed, detail });
    const line = `${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`;
    if (passed) logger.info(line);
    else logger.error(line);
  };

  logger.info(`Validating ${migrated.length} migrated user(s)${runId ? ` from run ${runId}` : ''}`);

  // 5. Identity completeness.
  const missingIdentity = migrated.filter(
    (user) =>
      !user._id ||
      !user.phone?.normalized ||
      user.legacy?.source !== migrationEnv.source ||
      !Number.isInteger(user.legacy?.userId),
  );
  record(
    'every migrated user has _id, phone.normalized, legacy.source and legacy.userId',
    missingIdentity.length === 0,
    missingIdentity.length ? `${missingIdentity.length} incomplete` : null,
  );

  // 6. Phone uniqueness across the whole collection, not just this run.
  const duplicatePhones = await User.aggregate([
    { $group: { _id: '$phone.normalized', total: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { total: { $gt: 1 } } },
  ]);
  record(
    'no duplicate phone.normalized in MongoDB',
    duplicatePhones.length === 0,
    duplicatePhones.length ? `${duplicatePhones.length} duplicated value(s)` : null,
  );

  // Legacy identity uniqueness.
  const duplicateLegacy = await User.aggregate([
    { $match: { 'legacy.userId': { $exists: true } } },
    { $group: { _id: { source: '$legacy.source', userId: '$legacy.userId' }, total: { $sum: 1 } } },
    { $match: { total: { $gt: 1 } } },
  ]);
  record(
    'no legacy account migrated twice',
    duplicateLegacy.length === 0,
    duplicateLegacy.length ? `${duplicateLegacy.length} duplicated legacy id(s)` : null,
  );

  // 7, 8, 9. No legacy credentials anywhere in the document tree.
  const leaked = migrated.filter((user) => {
    const keys = collectKeys(user);
    return FORBIDDEN_KEYS.some((key) => keys.has(key));
  });
  record(
    'no password, login_token or OTP field on any migrated user',
    leaked.length === 0,
    leaked.length ? `${leaked.length} user(s) carry credential fields` : null,
  );

  // 10. Age is consistent with DOB.
  const wrongAge = migrated.filter((user) => {
    const expected = calculateAge(user.profile?.dateOfBirth, now);
    return (user.profile?.age ?? null) !== expected;
  });
  record(
    'profile.age matches profile.dateOfBirth',
    wrongAge.length === 0,
    wrongAge.length ? `${wrongAge.length} stale age value(s)` : null,
  );

  // 11. profileCompleted reflects the required fields.
  const wrongCompletion = migrated.filter((user) => user.profileCompleted !== isProfileComplete(user.profile || {}));
  record(
    'profileCompleted matches the required profile fields',
    wrongCompletion.length === 0,
    wrongCompletion.length ? `${wrongCompletion.length} mismatch(es)` : null,
  );

  // 12. Migration metadata present and traceable.
  const missingMetadata = migrated.filter(
    (user) => !user.migration?.runId || !user.migration?.migratedAt || !user.migration?.version,
  );
  record(
    'every migrated user carries migration.runId, migratedAt and version',
    missingMetadata.length === 0,
    missingMetadata.length ? `${missingMetadata.length} missing metadata` : null,
  );

  // Legacy id -> Mongo _id mapping is usable for future child-data migration.
  const sample = migrated.slice(0, 1)[0];
  record(
    'legacy.userId -> Mongo _id mapping is resolvable',
    migrated.length === 0 || Boolean(sample?.legacy?.userId && sample?._id),
    sample ? `example: legacy ${sample.legacy.userId} -> ${sample._id}` : 'no migrated users',
  );

  const [pendingConflicts, nativeUsers] = await Promise.all([
    MigrationConflict.countDocuments({ status: CONFLICT_STATUS.PENDING }),
    User.countDocuments({ 'legacy.userId': { $exists: false } }),
  ]);

  const summary = {
    migratedUsers: migrated.length,
    nativeUsers,
    pendingConflicts,
    checksPassed: checks.filter((check) => check.passed).length,
    checksFailed: checks.filter((check) => !check.passed).length,
  };

  logger.info(
    `Migrated users: ${summary.migratedUsers} | native users: ${summary.nativeUsers} | pending conflicts: ${summary.pendingConflicts}`,
  );
  logger.info(`Checks passed: ${summary.checksPassed}, failed: ${summary.checksFailed}`);

  return { checks, summary, ok: summary.checksFailed === 0 };
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('validate-migration.js');

if (isEntryPoint) {
  const runIdIndex = process.argv.indexOf('--run-id');
  const runId = runIdIndex === -1 ? null : process.argv[runIdIndex + 1];

  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => validateMigration({ runId }))
    .then((result) => {
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      logger.error(`Validation failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close().catch(() => {}));
}

export default validateMigration;
