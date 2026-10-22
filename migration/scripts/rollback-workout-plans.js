/**
 * Removes the workout plans ONE apply run created - nothing else.
 * See docs/workout-plans-design.md.
 *
 *   npm run migration:workout-plans:rollback -- --run-id=<id> --manifest=<.manifest.json>                    # check only
 *   npm run migration:workout-plans:rollback -- --run-id=<id> --manifest=<.manifest.json> --confirm=<id>     # delete
 *
 * Deletes only when the manifest and the database agree exactly: every listed
 * document exists with this run id and its legacy plan id and is unmodified,
 * and no unlisted document carries the run id. Otherwise it deletes nothing
 * and says why. Documents that existed before the run, or came from another
 * run, are never selected. Development target only, same guards as the apply.
 */
import fs from 'node:fs/promises';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import { assertMigrationEnv } from '../config/migration.env.js';
import { rollbackWorkoutPlanRun } from '../loaders/workout-plan.loader.js';
import { assertApplyTarget } from './apply-workout-plans.js';

export const parseRollbackArgs = (argv) => {
  const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const runId = value('run-id');
  const manifest = value('manifest');
  if (!runId || !manifest) throw new Error('--run-id=<id> and --manifest=<file> are required');
  const confirm = value('confirm');
  if (confirm != null && confirm !== runId) throw new Error('--confirm must repeat the run id exactly');
  return { runId, manifest, confirm: confirm === runId };
};

export const runWorkoutPlanRollback = async ({ runId, manifest, confirm, assertTarget = () => assertApplyTarget() }) => {
  assertTarget();
  const data = JSON.parse(await fs.readFile(manifest, 'utf8'));
  const result = await rollbackWorkoutPlanRun({ runId, manifest: data, confirm });
  logger.info(
    [
      '',
      `──── workout plans ROLLBACK ${runId} (${confirm ? 'DELETE' : 'CHECK ONLY'}) ────`,
      `listed in manifest : ${data.inserted?.length ?? 0}`,
      `problems           : ${result.problems.length}${result.problems.map((p) => `\n    ${p}`).join('')}`,
      `would delete       : ${result.wouldDelete}`,
      `deleted            : ${result.deleted}`,
    ].join('\n'),
  );
  return result;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('rollback-workout-plans.js');
if (isEntryPoint) {
  Promise.resolve()
    .then(() => parseRollbackArgs(process.argv.slice(2)))
    .then(async (options) => {
      assertMigrationEnv({ requireMysql: false });
      await mongoose.connect(process.env.MONGODB_URI, { autoCreate: false, autoIndex: false });
      return runWorkoutPlanRollback(options);
    })
    .then((result) => { if (result.problems.length) process.exitCode = 1; })
    .catch((error) => {
      logger.error(`Workout plan rollback failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close().catch(() => {}));
}

export default runWorkoutPlanRollback;
