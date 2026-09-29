/**
 * Rounds already-stored profile.fitnessProfile.bodyFatPercentage to two
 * decimal places.
 *
 *   node migration/scripts/round-body-fat.js           # dry run
 *   node migration/scripts/round-body-fat.js --apply   # write
 *
 * Legacy fat was float(6,3), so migrated values can carry a third decimal
 * (16.923 -> 16.92). Only this one field is written; nulls are left alone, and
 * a value that already has two decimals or fewer is untouched, so re-running
 * changes nothing.
 *
 * MongoDB only; the production guard on the legacy database still applies.
 */
import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import User from '../../src/models/user.model.js';
import { roundBodyFat } from '../../src/utils/round.js';
import { assertMigrationEnv } from '../config/migration.env.js';

export const roundStoredBodyFat = async ({ dryRun = true } = {}) => {
  const collection = User.collection;

  const candidates = await collection
    .find(
      { 'profile.fitnessProfile.bodyFatPercentage': { $ne: null } },
      { projection: { _id: 1, 'profile.fitnessProfile.bodyFatPercentage': 1 } },
    )
    .toArray();

  const summary = {
    withValue: candidates.length,
    alreadyRounded: 0,
    toRound: 0,
    updated: 0,
    samples: [],
    errors: [],
  };

  const operations = [];

  for (const doc of candidates) {
    const current = doc.profile.fitnessProfile.bodyFatPercentage;
    const rounded = roundBodyFat(current);

    if (rounded === current) {
      summary.alreadyRounded += 1;
      continue;
    }

    summary.toRound += 1;
    if (summary.samples.length < 5) {
      summary.samples.push({ userId: String(doc._id), from: current, to: rounded });
    }

    operations.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { 'profile.fitnessProfile.bodyFatPercentage': rounded } },
      },
    });
  }

  if (dryRun || operations.length === 0) return summary;

  try {
    const result = await collection.bulkWrite(operations, { ordered: false });
    summary.updated = result.modifiedCount ?? 0;
  } catch (error) {
    for (const writeError of error.writeErrors || []) {
      const detail = writeError.err || writeError;
      summary.errors.push(detail.errmsg || detail.message || String(writeError));
    }
    if (!error.writeErrors) throw error;
  }

  return summary;
};

export const runBodyFatRounding = async ({ apply = false } = {}) => {
  const dryRun = !apply;
  logger.info(`Body fat rounding (${dryRun ? 'DRY RUN' : 'APPLY'}) [MongoDB only]`);

  const summary = await roundStoredBodyFat({ dryRun });

  logger.info(
    [
      '',
      '──── BODY FAT ROUNDING (2 dp) ────',
      `mode                  : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      '',
      `Users with a value    : ${summary.withValue}`,
      `Already at 2 decimals : ${summary.alreadyRounded}`,
      `${dryRun ? 'Would round         ' : 'Rounded             '}  : ${summary.toRound}`,
      !dryRun ? `Documents modified    : ${summary.updated}` : '',
      `Errors                : ${summary.errors.length}`,
      '──────────────────────────────────',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  for (const sample of summary.samples) {
    logger.info(`  ${sample.userId}: ${sample.from} -> ${sample.to}`);
  }

  return summary;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('round-body-fat.js');

if (isEntryPoint) {
  const apply = process.argv.includes('--apply');

  Promise.resolve()
    .then(() => assertMigrationEnv({ requireMysql: false }))
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => runBodyFatRounding({ apply }))
    .catch((error) => {
      logger.error(`Body fat rounding failed: ${error.message}`);
      logger.debug(error.stack);
      process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close().catch(() => {}));
}

export default runBodyFatRounding;
