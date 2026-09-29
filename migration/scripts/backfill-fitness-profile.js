/**
 * Backfills profile.fitnessProfile from the legacy m_user fitness columns.
 *
 *   node migration/scripts/backfill-fitness-profile.js           # dry run
 *   node migration/scripts/backfill-fitness-profile.js --apply   # write
 *
 * height, weight, fat, bmr and tdee come from MariaDB (read-only). Legacy bmr
 * lands on fitnessProfile.bmr and legacy tdee on fitnessProfile.tdee - the same
 * figure under this system's name, copied without recalculation. activityLevel,
 * foodType and goal have no confirmed legacy source, so they are initialized to
 * null and left for the member to set from Edit Profile - never guessed and
 * never derived from unrelated columns.
 *
 * The original user migration is not involved and is not re-run.
 */
import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import User from '../../src/models/user.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import { extractUserFitness, resolveFitnessColumns } from '../extractors/user.extractor.js';
import { backfillFitnessProfiles } from '../loaders/fitness-profile.loader.js';

export const runFitnessBackfill = async ({ apply = false } = {}) => {
  const dryRun = !apply;

  logger.info(
    `Fitness profile backfill (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only]`,
  );

  const columns = await resolveFitnessColumns();
  const rows = await extractUserFitness();
  const summary = await backfillFitnessProfiles(rows, { dryRun });

  const zeros = summary.zeroTreatedAsMissing;
  const negatives = summary.negativeTreatedAsMissing;

  logger.info(
    [
      '',
      '────────── FITNESS PROFILE BACKFILL ──────────',
      `mode                        : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `legacy source               : ${migrationEnv.source}`,
      `legacy database             : ${migrationEnv.mysql.database}`,
      '',
      `Legacy users inspected      : ${summary.legacyInspected}`,
      `Mongo users matched         : ${summary.matched}`,
      `Height values available     : ${summary.withHeight}`,
      `Weight values available     : ${summary.withWeight}`,
      `Body fat values available   : ${summary.withBodyFat}`,
      `Activity level values       : ${summary.withActivityLevel}  (no legacy source -> null)`,
      `Food type values            : ${summary.withFoodType}  (no legacy source -> null)`,
      `Goal values                 : ${summary.withGoal}  (no legacy source -> null)`,
      `BMR values available        : ${summary.withBmr}  (legacy bmr -> fitnessProfile.bmr)`,
      `TDEE values available       : ${summary.withTdee}  (legacy tdee -> fitnessProfile.tdee)`,
      `Missing Mongo users         : ${summary.missingMongoUser.length}`,
      `Conflicts                   : ${summary.conflicts.length}`,
      `Errors                      : ${summary.errors.length}`,
      '',
      `${dryRun ? 'Would write                ' : 'Written                    '} : ${summary.toWrite}`,
      `Already in place            : ${summary.alreadyInPlace}`,
      !dryRun ? `Documents modified          : ${summary.updated}` : '',
      '',
      `Legacy zeros read as missing: height ${zeros.height}, weight ${zeros.weight}, fat ${zeros.fat}, bmr ${zeros.bmr}, tdee ${zeros.tdee}`,
      `Legacy negatives as missing : bmr ${negatives.bmr}, tdee ${negatives.tdee}`,
      `Legacy columns present      : ${columns.available.join(', ') || 'none'}`,
      columns.missing.length > 0
        ? `Legacy columns ABSENT       : ${columns.missing.join(', ')}  (read as null, nothing invented)`
        : '',
      '──────────────────────────────────────────────',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  if (summary.conflicts.length > 0) {
    logger.warn(
      `${summary.conflicts.length} user(s) already hold a different value; the legacy figure was NOT written:`,
    );
    for (const conflict of summary.conflicts.slice(0, 10)) {
      logger.warn(
        `  legacy ${conflict.legacyUserId}: ${conflict.fields.join(', ')} ` +
          `existing ${JSON.stringify(conflict.existing)} vs legacy ${JSON.stringify(conflict.legacy)}`,
      );
    }
  }

  if (summary.missingMongoUser.length > 0) {
    const shown = summary.missingMongoUser.slice(0, 25).join(', ');
    logger.warn(
      `Legacy user ids with no migrated Mongo user (skipped, never created): ${shown}` +
        (summary.missingMongoUser.length > 25 ? ' ...' : ''),
    );
  }

  return summary;
};

const isEntryPoint =
  process.argv[1] && process.argv[1].endsWith('backfill-fitness-profile.js');

if (isEntryPoint) {
  const apply = process.argv.includes('--apply');

  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => User.syncIndexes())
    .then(() => runFitnessBackfill({ apply }))
    .catch((error) => {
      logger.error(`Fitness backfill failed: ${error.message}`);
      logger.debug(error.stack);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runFitnessBackfill;
