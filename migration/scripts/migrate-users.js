/**
 * Legacy m_user -> MongoDB User migration.
 *
 *   node migration/scripts/migrate-users.js                 # dry run (default)
 *   node migration/scripts/migrate-users.js --apply         # write to MongoDB
 *   node migration/scripts/migrate-users.js --limit 100     # bounded rehearsal
 *   node migration/scripts/migrate-users.js --run-id my-run # reuse a run id
 *
 * Pipeline: extract -> transform -> group by phone -> detect conflicts ->
 * apply recorded resolutions -> validate -> load -> report.
 *
 * Dry run is the default. Nothing is ever written to MariaDB.
 */
import crypto from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import User from '../../src/models/user.model.js';
import MigrationConflict, {
  CONFLICT_STATUS,
  CONFLICT_TYPES,
} from '../../src/models/migration-conflict.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import { extractUsersArray } from '../extractors/user.extractor.js';
import { transformLegacyUser } from '../transformers/user.transformer.js';
import { detectConflicts, persistConflicts } from '../identity/conflict-detector.js';
import { partitionAgainstExisting } from '../identity/existing-identity-check.js';
import { applyResolution, markConflictApplied } from '../identity/conflict-resolver.js';
import { validateBatch } from '../validators/migration.validator.js';
import { loadUsers } from '../loaders/user.loader.js';
import {
  createReport,
  finishReport,
  printSummary,
  writeReport,
} from '../reports/migration-report.js';

const parseArgs = (argv) => {
  const args = { apply: false, limit: null, runId: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++index], 10);
    else if (arg === '--run-id') args.runId = argv[++index];
  }

  return args;
};

export const runMigration = async ({ apply = false, limit = null, runId = null } = {}) => {
  const id = runId || `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const dryRun = !apply;

  const report = createReport(id, {
    dryRun,
    source: migrationEnv.source,
    database: migrationEnv.mysql.database,
  });

  logger.info(`Migration run ${id} (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()}`);
  logger.info(`legacy.source will be recorded as "${migrationEnv.source}"`);

  // STEP 1: extract (read-only).
  const rows = await extractUsersArray({ limit });
  report.extracted = rows.length;
  report.counts.legacyRows = rows.length;
  logger.info(`Extracted ${rows.length} legacy rows`);

  // STEP 2 + 7: transform and normalize phones.
  const transformed = rows.map((row) => transformLegacyUser(row));
  report.transformed = transformed.length;
  report.counts.transformed = transformed.length;

  // STEP 3 + 4 + 5: classify missing/invalid phones and duplicate phone groups.
  const { migratable, conflicts, duplicateGroups } = detectConflicts(transformed);

  report.conflicts.total = conflicts.length;
  for (const conflict of conflicts) {
    report.conflicts.byType[conflict.type] = (report.conflicts.byType[conflict.type] || 0) + 1;
  }

  report.counts.duplicatePhoneUsers = duplicateGroups.reduce(
    (total, group) => total + group.members.length,
    0,
  );
  report.counts.invalidPhone = conflicts.filter(
    (conflict) => conflict.type === CONFLICT_TYPES.INVALID_LEGACY_PHONE,
  ).length;
  report.counts.missingPhone = conflicts.filter(
    (conflict) => conflict.type === CONFLICT_TYPES.MISSING_LEGACY_PHONE,
  ).length;

  const persisted = await persistConflicts(id, conflicts);
  report.conflicts.created = persisted.created;
  report.conflicts.existing = persisted.existing;

  if (duplicateGroups.length > 0) {
    logger.warn(
      `${duplicateGroups.length} duplicate-phone group(s) covering ${report.counts.duplicatePhoneUsers} legacy account(s). None are migrated until resolved.`,
    );
  }

  // STEP 6: admit only duplicate-group members that carry a recorded decision.
  const resolvedConflicts = await MigrationConflict.find({
    status: CONFLICT_STATUS.RESOLVED,
    phone: { $in: duplicateGroups.map((group) => group.phone) },
  });

  const admittedFromResolutions = [];

  for (const conflict of resolvedConflicts) {
    const group = duplicateGroups.find((candidate) => candidate.phone === conflict.phone);
    if (!group) continue;

    const { admitted, excluded } = applyResolution(conflict, group.members);
    admittedFromResolutions.push(...admitted);

    report.notes.push(
      `Conflict ${conflict._id} (${conflict.phone}) resolved via ${conflict.resolution.strategy}: admitted ${admitted.map((member) => member.legacyUserId).join(', ') || 'none'}; excluded ${excluded.join(', ') || 'none'}`,
    );

    if (apply) await markConflictApplied(conflict._id);
  }

  report.counts.admittedByResolution = admittedFromResolutions.length;

  const candidates = [...migratable, ...admittedFromResolutions];
  report.migratable = candidates.length;
  report.counts.eligible = candidates.length;

  // STEP 8: validate before any write.
  const validation = validateBatch(candidates, { source: migrationEnv.source });
  report.validation.invalid = validation.invalid;
  report.validation.duplicateWithinBatch = validation.duplicateWithinBatch;

  if (!validation.valid) {
    report.counts.errors = validation.invalid.length + validation.duplicateWithinBatch.length;
    logger.error(
      `Validation failed: ${validation.invalid.length} invalid record(s), ${validation.duplicateWithinBatch.length} in-batch duplicate phone(s). Nothing was written.`,
    );
    report.notes.push('Aborted before load: validation failed');
    report.conflicts.pending = await MigrationConflict.countDocuments({
      status: CONFLICT_STATUS.PENDING,
    });
    finishReport(report);
    printSummary(report);
    return { report, aborted: true };
  }

  // Partition against what MongoDB already holds, so already-migrated accounts
  // and phone collisions with a different user are excluded and reported
  // before the write rather than surfacing as anonymous skips afterwards.
  const partition = await partitionAgainstExisting(candidates, { source: migrationEnv.source });

  report.counts.alreadyMigrated = partition.alreadyMigrated.length;
  report.counts.phoneCollision = partition.phoneCollision.length;

  if (partition.conflicts.length > 0) {
    const collisionPersisted = await persistConflicts(id, partition.conflicts);
    report.conflicts.total += partition.conflicts.length;
    report.conflicts.created += collisionPersisted.created;
    for (const conflict of partition.conflicts) {
      report.conflicts.byType[conflict.type] = (report.conflicts.byType[conflict.type] || 0) + 1;
    }
    logger.warn(
      `${partition.phoneCollision.length} legacy account(s) have a phone that already belongs to a different MongoDB user. Neither user is modified.`,
    );
  }

  // STEP 9 + 10 + 11: load (dry run reports only; --apply writes).
  report.load = await loadUsers(partition.insertable, { runId: id, dryRun });

  // Existing users are never overwritten by this migration, so updates are
  // always zero; the field exists so the report states that explicitly.
  report.counts.wouldUpdate = 0;

  if (dryRun) {
    report.counts.wouldInsert = report.load.inserted;
  } else {
    report.counts.inserted = report.load.inserted;
  }

  report.counts.errors = report.load.failed.length;
  report.counts.skipped =
    report.counts.duplicatePhoneUsers -
    report.counts.admittedByResolution +
    report.counts.invalidPhone +
    report.counts.missingPhone +
    report.counts.alreadyMigrated +
    report.counts.phoneCollision;

  report.conflicts.pending = await MigrationConflict.countDocuments({
    status: CONFLICT_STATUS.PENDING,
  });

  finishReport(report);
  const file = await writeReport(report);
  printSummary(report);
  logger.info(`Report written to ${file}`);

  return { report, aborted: false };
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('migrate-users.js');

if (isEntryPoint) {
  const args = parseArgs(process.argv.slice(2));

  Promise.resolve()
    .then(assertMigrationEnv)
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => Promise.all([User.syncIndexes(), MigrationConflict.syncIndexes()]))
    .then(() => runMigration(args))
    .catch((error) => {
      logger.error(`Migration failed: ${error.message}`);
      logger.debug(error.stack);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runMigration;
