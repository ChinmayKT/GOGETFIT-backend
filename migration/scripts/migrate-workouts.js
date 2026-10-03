/**
 * Migrates the legacy workout master (m_workout) into the workouts collection.
 *
 *   npm run migrate:workouts              # dry run (report only)
 *   npm run migrate:workouts -- --apply   # write
 *
 * MariaDB is read-only throughout and the production-database rail applies.
 * Safe to re-run: identity is (legacy.source, legacy.workoutId). An already
 * migrated workout is never updated, never overwritten and never deleted.
 *
 * Media is NOT part of this run. Legacy stores only filenames, and the files
 * live on the legacy host; the migration records the filename mapping in its
 * report and leaves video/thumbnail null rather than inventing a reference.
 * See docs/workouts-legacy.md.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import Workout from '../../src/models/workout.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import {
  countPlanReferences,
  countWorkouts,
  extractWorkouts,
  resolveWorkoutColumns,
} from '../extractors/workout.extractor.js';
import { loadWorkouts, resolveWorkoutOwner, verifyWorkouts } from '../loaders/workout.loader.js';
import { writeReport } from '../reports/migration-report.js';

const rowsOf = (items) =>
  items.length
    ? items.map((i) => `    ${String(i.workoutId).padEnd(6)} ${String(i.name ?? '').slice(0, 34).padEnd(36)} ${i.reason}`)
    : ['    -'];

const tally = (counts) =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ') || '-';

export const runWorkoutMigration = async ({ apply = false, runId = null } = {}) => {
  const dryRun = !apply;
  const id = runId ?? `workouts-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  logger.info(`Workout migration (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only]`);

  // Before anything else: the admin every migrated workout is attributed to.
  // Throws - stopping the run with nothing written - if not exactly one admin matches.
  const owner = await resolveWorkoutOwner();
  logger.info(`workout owner: ${owner.email} -> User ${owner.id} (roles: ${owner.roles.join(', ')})`);

  const columns = await resolveWorkoutColumns();
  const sourceCount = await countWorkouts();
  const references = await countPlanReferences();
  const rows = await extractWorkouts();
  const before = await Workout.countDocuments();

  const s = await loadWorkouts(rows, { dryRun, runId: id, ownerId: owner.id });
  const verify = dryRun ? null : await verifyWorkouts(rows, { ownerId: owner.id });
  const after = await Workout.countDocuments();

  logger.info(
    [
      '',
      '────────── WORKOUT MIGRATION (m_workout → workouts) ──────────',
      `mode                       : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `run id                     : ${id}`,
      `source                     : ${migrationEnv.mysql.database}.${migrationEnv.workoutTable}`,
      `owner (createdBy/updatedBy): ${owner.email} = User ${owner.id}`,
      '',
      '── source ──',
      `legacy workouts            : ${sourceCount}`,
      `referenced by plans        : ${references.workouts} workouts via ${references.links} ${migrationEnv.workoutPlanLinkTable} rows`,
      `plan rows pointing nowhere : ${references.orphanLinks} (pre-existing legacy orphans, untouched)`,
      '',
      '── migration ──',
      `eligible                   : ${s.eligible}`,
      `  active                   : ${s.counts.active}`,
      `  archived (delete_flg = 1): ${s.counts.archived}`,
      `already migrated           : ${s.alreadyMigrated}`,
      `${dryRun ? 'would insert               ' : 'newly migrated             '}: ${dryRun ? s.toCreate : s.created}`,
      `invalid / unmappable       : ${s.invalid.length}`,
      `duplicate source ids       : ${s.duplicateSourceIds.length}`,
      `failed                     : ${s.errors.length}`,
      '',
      `type                       : ${tally(s.byType)}`,
      `equipment                  : ${tally(s.byEquipment)}`,
      `level                      : ${tally(s.byLevel)}`,
      '',
      '── media (not migrated by this run) ──',
      `legacy video filenames     : ${s.withLegacyVideo}`,
      `legacy thumbnail filenames : ${s.withLegacyThumbnail}`,
      `youtube links              : ${s.withYoutube}`,
      '(video/thumbnail are left null; the filename map is in the report file)',
      '',
      'invalid:', ...rowsOf(s.invalid),
      'duplicate source ids:', ...rowsOf(s.duplicateSourceIds),
      'failed:', ...rowsOf(s.errors),
      ...(verify
        ? [
            '',
            '── verification (independent re-read of MongoDB) ──',
            `workouts in MongoDB        : ${before} before → ${after} after`,
            `migrated workouts          : ${verify.migratedInMongo}`,
            `eligible legacy workouts   : ${verify.eligibleCount}`,
            `eligible but missing       : ${verify.missing.length ? verify.missing.join(', ') : 'none'}`,
            `migrated but not eligible  : ${verify.notEligible.length ? verify.notEligible.join(', ') : 'none'}`,
            `duplicate legacy ids       : ${verify.duplicateLegacyIds.length ? verify.duplicateLegacyIds.join(', ') : 'none'}`,
            `archived in MongoDB        : ${verify.archived}`,
            `without media              : ${verify.withoutMedia}`,
            `invariant problems         : ${verify.problems.length ? '' : 'none'}`,
            ...verify.problems.slice(0, 20).map((p) => `    ${p}`),
            `field mismatches vs legacy : ${verify.mismatches.length ? '' : 'none'}`,
            ...verify.mismatches.map((m) => `    ${m.workoutId}: ${m.fields.join(', ')}`),
            `portal workouts with legacy: ${verify.portalWorkoutsWithLegacy}`,
          ]
        : []),
      columns.missing.length ? `\nlegacy columns ABSENT      : ${columns.missing.join(', ')}` : '',
      '──────────────────────────────────────────────────────────────',
    ]
      .filter((l) => l !== '')
      .join('\n'),
  );

  const report = {
    runId: id,
    dryRun,
    source: migrationEnv.source,
    database: migrationEnv.mysql.database,
    table: migrationEnv.workoutTable,
    owner: { id: String(owner.id), email: owner.email, roles: owner.roles },
    sourceCount,
    references,
    before,
    after,
    summary: s,
    verify,
    finishedAt: new Date().toISOString(),
  };
  const file = await writeReport(report);
  logger.info(`report (incl. legacy workout_id → Mongo _id and media filename map): ${file ?? 'migration/reports/runs'}`);
  return report;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('migrate-workouts.js');
if (isEntryPoint) {
  const apply = process.argv.includes('--apply');
  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => Workout.syncIndexes())
    .then(() => runWorkoutMigration({ apply }))
    .catch((error) => {
      logger.error(`Workout migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runWorkoutMigration;
