/**
 * Writes the legacy workout plans a passing dry run planned: CREATE ONLY,
 * development MongoDB only. See docs/workout-plans-design.md.
 *
 *   npm run migration:workout-plans:apply -- --source=staging --from-report=<dry-run .json> [--max-age-hours=24] [--manifest-dir=<dir>]
 *
 * Refuses unless:
 *   - assertMigrationEnv, the configured legacy database is the --source
 *     snapshot, and the development guards hold (NODE_ENV=development,
 *     MIGRATION_ALLOW_PRODUCTION off, the dev cluster / gogetfit database);
 *   - --from-report is a passing workout-plan dry run, at most
 *     --max-age-hours old, and re-running every dry-run step now yields the
 *     same source snapshot, the same planned documents and the same target
 *     state (fingerprints) - and still passes;
 *   - the unique (legacy.source, legacy.workoutPlanId) index exists.
 *
 * Then inserts, one by one, the planned documents not yet present, each
 * tagged migration.runId = this run. Never updates, replaces or deletes;
 * any conflicting document already there stops the run before a write.
 * A manifest (document ids and legacy plan ids only) is rewritten after every
 * insert, so a partial failure still says exactly what was written; a rerun
 * (after a fresh dry run) skips what is already present.
 *
 * Undo: rollback-workout-plans.js, for this run id only.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import WorkoutPlan from '../../src/models/workout-plan.model.js';
import { closePool } from '../config/mariadb.js';
import { assertDevelopmentConnection, assertDevelopmentTarget } from '../config/dev-target.js';
import { assertMigrationEnv, migrationEnv } from '../config/migration.env.js';
import { applyWorkoutPlans, staleReportReasons } from '../loaders/workout-plan.loader.js';
import { SOURCES, assertSource, prepareWorkoutPlanRun } from './migrate-workout-plans.js';

const LABEL = 'apply workout plans';
export const UNIQUE_INDEX = 'uniq_legacy_source_workoutplan';

export const parseApplyArgs = (argv) => {
  const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const source = value('source');
  if (!source || !SOURCES[source]) throw new Error(`--source must be one of: ${Object.keys(SOURCES).join(', ')}`);
  const fromReport = value('from-report');
  if (!fromReport) throw new Error('--from-report=<dry-run report .json> is required');
  const maxAgeHours = Number(value('max-age-hours') ?? 24);
  if (!(maxAgeHours > 0)) throw new Error('--max-age-hours must be a positive number');
  return { source, fromReport, maxAgeHours, manifestDir: value('manifest-dir') };
};

/** Both development guards, in the order the CLI applies them. Throws on anything else. */
export const assertApplyTarget = (env = process.env, connection = undefined) => {
  assertDevelopmentTarget(env, LABEL);
  return assertDevelopmentConnection(connection, LABEL);
};

export const runWorkoutPlanApply = async ({
  source,
  fromReport,
  maxAgeHours = 24,
  manifestDir = null,
  extract,
  runtime,
  assertTarget = () => assertApplyTarget(),
  now = new Date(),
}) => {
  const target = assertTarget();
  const report = JSON.parse(await fs.readFile(fromReport, 'utf8'));
  const runId = `workout-plans-apply-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  logger.info(`Workout plan APPLY ${runId}: legacy ${SOURCES[source]} [read-only] -> MongoDB ${target.database} [create only]`);

  // Re-prove everything the report claimed, against the data as it is now.
  const accepted = new Set(report.acceptedDecisionCodes ?? []);
  const { report: current, documents, pass } = await prepareWorkoutPlanRun({
    source, accepted, runId, targetDatabase: target.database, extract, runtime,
  });
  const reasons = staleReportReasons(report, current, { now, maxAgeHours });
  if (!pass) reasons.push(`the checks do not pass now (${current.result})`);
  if (reasons.length) throw new Error(`Refusing to ${LABEL}: ${reasons.join('; ')}`);

  const indexes = await WorkoutPlan.collection.indexes().catch(() => []);
  if (!indexes.some((i) => i.name === UNIQUE_INDEX)) {
    throw new Error(`Refusing to ${LABEL}: the ${UNIQUE_INDEX} index is missing (start the API once, which syncs it)`);
  }

  const dir = manifestDir ?? path.join(process.cwd(), 'migration', 'reports', 'runs');
  await fs.mkdir(dir, { recursive: true });
  const manifestFile = path.join(dir, `${runId}.manifest.json`);
  const manifest = {
    kind: 'workout-plans-apply-manifest',
    runId,
    source,
    legacyDatabase: SOURCES[source],
    target: { database: target.database },
    fromReport: { runId: report.runId, file: path.basename(fromReport) },
    fingerprints: current.fingerprints,
    startedAt: now.toISOString(),
  };
  const write = async (state) => {
    await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  };

  const state = await applyWorkoutPlans(documents, { runId, version: migrationEnv.version, now, onProgress: write });
  logger.info(
    [
      '',
      `──── workout plans APPLY ${runId} ────`,
      `status            : ${state.status}`,
      `inserted          : ${state.inserted.length}`,
      `already present   : ${state.alreadyPresent.length}`,
      `conflicts         : ${state.conflicts.length}${state.conflicts.length ? `  [${state.conflicts.map((c) => c.workoutPlanId).join(', ')}]` : ''}`,
      `failed            : ${state.failed.length}${state.failed.map((f) => `\n    plan ${f.workoutPlanId}: ${f.code}`).join('')}`,
      `not attempted     : ${state.notAttempted.length}`,
      `manifest          : ${manifestFile}`,
    ].join('\n'),
  );
  return { ...state, runId, manifestFile };
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('apply-workout-plans.js');
if (isEntryPoint) {
  let options;
  Promise.resolve()
    .then(() => { options = parseApplyArgs(process.argv.slice(2)); })
    .then(() => assertMigrationEnv())
    .then(() => assertSource(options.source))
    .then(() => assertDevelopmentTarget(process.env, LABEL))
    // Collections and indexes are never created implicitly; the index check above needs the real one.
    .then(() => mongoose.connect(process.env.MONGODB_URI, { autoCreate: false, autoIndex: false }))
    .then(() => runWorkoutPlanApply(options))
    .then((result) => { if (result.status !== 'complete') process.exitCode = 1; })
    .catch((error) => {
      logger.error(`Workout plan apply failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runWorkoutPlanApply;
