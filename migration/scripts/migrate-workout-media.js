/**
 * Copies a small, fixed SAMPLE of legacy workout media into this system's
 * storage and points those Workout documents at it.
 *
 *   npm run migrate:workout-media                           # dry run (HEAD only)
 *   npm run migrate:workout-media -- --apply                # copy the sample
 *   npm run migrate:workout-media -- --apply --workouts=10,16,24
 *   npm run migrate:workout-media -- --apply --replace      # re-copy over stored files
 *   npm run migrate:workout-media -- --apply --all --slots=thumbnail
 *                                                           # every workout's poster, no video
 *
 * Deliberately NOT a full media migration. The complete legacy set is roughly
 * 1 GB of video, which development has no reason to hold; this copies three
 * named workouts so the whole pipeline can be verified with real files.
 * Every other migrated workout keeps video: null and thumbnail: null, and no
 * legacy host URL is ever written into a document.
 *
 * This script only ever sets `video` and `thumbnail`. It creates no Workout,
 * changes no text field and touches no legacy identity.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import env from '../../src/config/env.js';
import logger from '../../src/config/logger.js';
import Workout from '../../src/models/workout.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import { extractWorkouts } from '../extractors/workout.extractor.js';
import {
  DEFAULT_MEDIA_SAMPLE,
  MEDIA_SLOTS,
  loadWorkoutMedia,
  verifyWorkoutMedia,
} from '../loaders/workout-media.loader.js';
import { writeReport } from '../reports/migration-report.js';

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const runWorkoutMediaMigration = async ({
  apply = false,
  runId = null,
  workoutIds = DEFAULT_MEDIA_SAMPLE,
  slots = MEDIA_SLOTS,
  replace = false,
} = {}) => {
  const dryRun = !apply;
  const id = runId ?? `workout-media-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  logger.info(`Workout media sample (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only]`);

  const rows = await extractWorkouts();
  const s = await loadWorkoutMedia(rows, { dryRun, workoutIds, slots, replace });
  const verify = await verifyWorkoutMedia({ sample: workoutIds });

  logger.info(
    [
      '',
      '────────── WORKOUT MEDIA SAMPLE (legacy wwwroot/WorkOut → local storage) ──────────',
      `mode                       : ${dryRun ? 'DRY RUN (HEAD only, no writes)' : 'APPLY'}${replace ? ' --replace' : ''}`,
      `run id                     : ${id}`,
      `media source               : ${migrationEnv.legacyWorkoutMediaBaseUrl}{Video,Thumbnail}/`,
      `storage driver             : ${env.storage.driver} → ${env.storage.localRoot}/workouts`,
      `limits                     : video ${mb(env.storage.maxVideoUploadBytes)} · image ${mb(env.storage.maxUploadBytes)}`,
      `scope                      : ${s.sample === 'all' ? `ALL ${s.requested} migrated workouts` : `legacy workout ids ${s.sample.join(', ')} (fixed in source)`}`,
      `slots                      : ${s.slots.join(', ')}${s.slots.includes('video') ? '' : '  (videos deliberately not copied)'}`,
      '',
      '── sample ──',
      ...(s.selected.length
        ? s.selected.slice(0, 6).flatMap((w) => [
            `  legacy ${String(w.workoutId).padEnd(4)} ${String(w.name).slice(0, 36)}`,
            `      mongo     : ${w.mongoId}`,
            `      video     : ${w.video ?? '-'}`,
            `      thumbnail : ${w.thumbnail ?? '-'}`,
          ])
        : ['  -']),
      s.selected.length > 6 ? `  … and ${s.selected.length - 6} more (full list in the report file)` : '',
      '',
      '── outcome ──',
      `${dryRun ? 'videos would copy          ' : 'videos copied              '}: ${s.videosCopied}`,
      `${dryRun ? 'thumbnails would copy      ' : 'thumbnails copied          '}: ${s.thumbnailsCopied}`,
      `${dryRun ? 'bytes to transfer          ' : 'bytes transferred          '}: ${mb(s.bytesTransferred)}`,
      `already had media          : ${s.alreadyHadMedia.length}`,
      `no legacy filename         : ${s.skippedNoFilename.length}`,
      `unreachable                : ${s.unreachable.length}${s.unreachable.length ? ' — ' + s.unreachable.map((u) => `${u.workoutId}/${u.slot} ${u.reason}`).join(', ') : ''}`,
      `invalid bytes              : ${s.invalid.length}${s.invalid.length ? ' — ' + s.invalid.map((u) => `${u.workoutId}/${u.slot} ${u.reason}`).join(', ') : ''}`,
      `not migrated               : ${s.notMigrated.length}`,
      `not in the legacy table    : ${s.notInLegacy.length ? s.notInLegacy.join(', ') : 'none'}`,
      `errors                     : ${s.errors.length}${s.errors.length ? ' — ' + s.errors.map((e) => `${e.workoutId}/${e.slot} ${e.reason}`).join(', ') : ''}`,
      '',
      '── verification (independent re-read of MongoDB) ──',
      `migrated workouts          : ${verify.migratedWorkouts}`,
      `with any media             : ${verify.withAnyMedia}`,
      `  with a thumbnail         : ${verify.withThumbnail}`,
      `  with a video             : ${verify.withVideo}`,
      `intentionally without media: ${verify.withoutMedia}`,
      Array.isArray(s.sample) ? `unexpected media           : ${verify.unexpected.length ? verify.unexpected.join(', ') : 'none'}` : '',
      `invariant problems         : ${verify.problems.length ? '' : 'none'}`,
      ...verify.problems.map((p) => `    ${p}`),
      '(the remaining legacy media is deliberately not copied - see docs/workouts-legacy.md)',
      '───────────────────────────────────────────────────────────────────────────────────',
    ]
      .filter((l) => l !== '')
      .join('\n'),
  );

  const report = {
    runId: id,
    dryRun,
    replace,
    source: migrationEnv.source,
    mediaBaseUrl: migrationEnv.legacyWorkoutMediaBaseUrl,
    sample: s.sample,
    slots,
    summary: s,
    verify,
    finishedAt: new Date().toISOString(),
  };
  const file = await writeReport(report);
  logger.info(`report: ${file ?? 'migration/reports/runs'}`);
  return report;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('migrate-workout-media.js');
if (isEntryPoint) {
  const apply = process.argv.includes('--apply');
  const replace = process.argv.includes('--replace');

  // An explicit sample overrides the fixed one; the default never varies.
  const arg = process.argv.find((a) => a.startsWith('--workouts='));
  const all = process.argv.includes('--all');
  const workoutIds = all
    ? 'all'
    : arg
      ? arg.split('=')[1].split(',').map((v) => Number.parseInt(v.trim(), 10))
      : DEFAULT_MEDIA_SAMPLE;
  if (workoutIds !== 'all' && workoutIds.some((v) => !Number.isInteger(v) || v <= 0)) {
    throw new Error('--workouts must be a comma-separated list of legacy workout ids');
  }

  // --slots=thumbnail copies the posters only: a few MB, where the videos are ~1 GB.
  const slotArg = process.argv.find((a) => a.startsWith('--slots='));
  const slots = slotArg ? slotArg.split('=')[1].split(',').map((s) => s.trim()) : MEDIA_SLOTS;
  const unknownSlots = slots.filter((s) => !MEDIA_SLOTS.includes(s));
  if (unknownSlots.length > 0) throw new Error(`--slots must be one of: ${MEDIA_SLOTS.join(', ')}`);

  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => runWorkoutMediaMigration({ apply, workoutIds, slots, replace }))
    .catch((error) => {
      logger.error(`Workout media migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runWorkoutMediaMigration;
