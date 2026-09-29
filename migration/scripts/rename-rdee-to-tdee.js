/**
 * Renames profile.fitnessProfile.rdee to profile.fitnessProfile.tdee.
 *
 *   node migration/scripts/rename-rdee-to-tdee.js           # dry run
 *   node migration/scripts/rename-rdee-to-tdee.js --apply   # write
 *
 * The figure was always TDEE - the legacy column is m_user.tdee and the legacy
 * m_free_diet_plan row stores it as tdee too. This system briefly called it rdee;
 * that name is now retired everywhere, so the stored documents have to follow.
 *
 * MongoDB only: MariaDB is not touched, and neither is any other field. A
 * document that already has tdee is left alone, so the script is idempotent and
 * safe to re-run.
 */
import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import User from '../../src/models/user.model.js';
import { assertMigrationEnv } from '../config/migration.env.js';

export const runRdeeRename = async ({ apply = false } = {}) => {
  const dryRun = !apply;
  const c = User.collection;

  const withRdee = await c.countDocuments({ 'profile.fitnessProfile.rdee': { $exists: true } });
  const withBoth = await c.countDocuments({
    'profile.fitnessProfile.rdee': { $exists: true },
    'profile.fitnessProfile.tdee': { $exists: true },
  });
  const withTdee = await c.countDocuments({ 'profile.fitnessProfile.tdee': { $exists: true } });

  const summary = { withRdee, withBoth, withTdee, renamed: 0, remaining: withRdee };

  if (!dryRun && withRdee > 0) {
    if (withBoth > 0) {
      // Would silently discard one of the two values, so it stops instead.
      throw new Error(
        `${withBoth} document(s) hold both rdee and tdee; resolve those by hand before renaming`,
      );
    }

    const result = await c.updateMany(
      { 'profile.fitnessProfile.rdee': { $exists: true } },
      { $rename: { 'profile.fitnessProfile.rdee': 'profile.fitnessProfile.tdee' } },
    );
    summary.renamed = result.modifiedCount ?? 0;
    summary.remaining = await c.countDocuments({
      'profile.fitnessProfile.rdee': { $exists: true },
    });
    summary.withTdee = await c.countDocuments({
      'profile.fitnessProfile.tdee': { $exists: true },
    });
  }

  logger.info(
    [
      '',
      '────────── RDEE -> TDEE RENAME ──────────',
      `mode                     : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `documents holding rdee   : ${withRdee}`,
      `documents holding both   : ${withBoth}`,
      `${dryRun ? 'Would rename            ' : 'Renamed                 '} : ${dryRun ? withRdee : summary.renamed}`,
      `documents holding tdee   : ${summary.withTdee}`,
      `rdee still present       : ${summary.remaining}`,
      '─────────────────────────────────────────',
      '',
    ].join('\n'),
  );

  return summary;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('rename-rdee-to-tdee.js');

if (isEntryPoint) {
  const apply = process.argv.includes('--apply');

  Promise.resolve()
    // This backfill reads no MariaDB, but the production-database rail still applies.
    .then(() => assertMigrationEnv({ requireMysql: false }))
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => runRdeeRename({ apply }))
    .catch((error) => {
      logger.error(`rdee rename failed: ${error.message}`);
      logger.debug(error.stack);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.connection.close().catch(() => {});
    });
}

export default runRdeeRename;
