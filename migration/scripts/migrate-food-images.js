/**
 * Copies the legacy food pictures into this system's storage and points the
 * migrated Food documents at them - the same lifecycle the coach pictures use.
 *
 *   npm run migrate:food-images                            # dry run (HEAD only, writes nothing)
 *   npm run migrate:food-images -- --apply                 # download, validate, store
 *   npm run migrate:food-images -- --apply --replace       # also re-store foods that already have an image
 *   npm run migrate:food-images -- --apply --max-bytes=N   # migration-only size ceiling
 *
 * The legacy database only ever held a filename (m_food.image_file_name); the
 * files live in the legacy admin's wwwroot/Images and are fetched over HTTP
 * from MIGRATION_LEGACY_IMAGE_BASE_URL. Each file is validated by its real
 * signature, stored through the project's storage driver and recorded as
 * { url, storageKey } - the legacy filename is never written to the document.
 *
 * Once this has run the new system serves every food picture itself, so the
 * legacy server is no longer a runtime dependency.
 *
 * This script only ever sets `image`. It creates no Food, changes no nutrition
 * and touches no legacy identity.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import env from '../../src/config/env.js';
import logger from '../../src/config/logger.js';
import Food from '../../src/models/food.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import { countFoodsWithoutImageName, extractFoodImageNames } from '../extractors/food-image.extractor.js';
import { loadFoodImages, verifyFoodImages } from '../loaders/food-image.loader.js';
import { writeReport } from '../reports/migration-report.js';

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const rowsOf = (items, limit = 25) => {
  if (items.length === 0) return ['    -'];
  const shown = items.slice(0, limit).map(
    (i) => `    ${String(i.foodId).padEnd(6)} ${String(i.name ?? '').slice(0, 32).padEnd(34)} ${i.reason ?? ''}`,
  );
  if (items.length > limit) shown.push(`    … and ${items.length - limit} more (see the report file)`);
  return shown;
};

export const runFoodImageMigration = async ({
  apply = false,
  runId = null,
  maxBytes = env.storage.maxUploadBytes,
  replace = false,
} = {}) => {
  const dryRun = !apply;
  const id = runId ?? `food-images-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  logger.info(`Food image migration (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only]`);
  logger.info(`image source: ${migrationEnv.legacyImageBaseUrl}`);

  const rows = await extractFoodImageNames();
  const withoutName = await countFoodsWithoutImageName();
  const before = await Food.countDocuments({ 'image.storageKey': { $exists: true, $ne: null } });

  const s = await loadFoodImages(rows, { dryRun, maxBytes, replace });
  const verify = await verifyFoodImages();

  const typeLine = Object.entries(s.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type} ${n}`)
    .join(' · ');

  logger.info(
    [
      '',
      '────────── FOOD IMAGE MIGRATION (legacy wwwroot/Images → local storage) ──────────',
      `mode                       : ${dryRun ? 'DRY RUN (HEAD only, no writes)' : 'APPLY'}${replace ? ' --replace' : ''}`,
      `run id                     : ${id}`,
      `legacy database            : ${migrationEnv.mysql.database} (${migrationEnv.foodTable})`,
      `image source               : ${migrationEnv.legacyImageBaseUrl}`,
      `storage driver             : ${env.storage.driver} → ${env.storage.localRoot}/foods (served at ${env.storage.publicPath}/foods)`,
      `size limit                 : ${mb(maxBytes)}${maxBytes === env.storage.maxUploadBytes ? ' (the app upload limit)' : ` (--max-bytes override; the app limit is ${mb(env.storage.maxUploadBytes)})`}`,
      '',
      '── source ──',
      `legacy foods with a filename: ${s.legacyRows}`,
      `legacy foods with none      : ${withoutName}`,
      '',
      '── outcome ──',
      `not migrated (no Food)      : ${s.notMigrated.length}`,
      `already stored locally      : ${s.alreadyStored.length}`,
      `${dryRun ? 'would store                 ' : 'stored locally              '}: ${dryRun ? s.toStore : s.stored}`,
      `  of those, external links replaced: ${s.replacedLinks}`,
      `unreachable (HTTP error)    : ${s.skippedUnreachable.length}`,
      `not a valid image           : ${s.skippedInvalid.length}`,
      `over the size limit         : ${s.skippedTooLarge.length}`,
      `errors                      : ${s.errors.length}`,
      `${dryRun ? 'bytes to transfer           ' : 'bytes transferred           '}: ${mb(s.bytesTransferred)} (largest ${mb(s.largestBytes)})`,
      `types                       : ${typeLine || '-'}`,
      '',
      'not migrated:', ...rowsOf(s.notMigrated),
      'unreachable:', ...rowsOf(s.skippedUnreachable),
      'not a valid image:', ...rowsOf(s.skippedInvalid),
      'over the size limit:', ...rowsOf(s.skippedTooLarge),
      'errors:', ...rowsOf(s.errors),
      '',
      '── verification (independent re-read of MongoDB) ──',
      `migrated foods              : ${verify.total}`,
      `stored locally              : ${before} before → ${verify.withImage - verify.stillLinked} now`,
      `still an external link      : ${verify.stillLinked}`,
      `without an image            : ${verify.withoutImage}`,
      `invariant problems          : ${verify.problems.length ? '' : 'none'}`,
      ...verify.problems.slice(0, 20).map((p) => `    ${p}`),
      '─────────────────────────────────────────────────────────────────────────────────',
    ]
      .filter((l) => l !== '')
      .join('\n'),
  );

  const report = {
    runId: id,
    dryRun,
    replace,
    source: migrationEnv.source,
    database: migrationEnv.mysql.database,
    imageBaseUrl: migrationEnv.legacyImageBaseUrl,
    maxBytes,
    legacyFoodsWithoutFilename: withoutName,
    before,
    summary: s,
    verify,
    finishedAt: new Date().toISOString(),
  };
  const file = await writeReport(report);
  logger.info(`report: ${file ?? 'migration/reports/runs'}`);
  return report;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('migrate-food-images.js');
if (isEntryPoint) {
  const apply = process.argv.includes('--apply');
  const replace = process.argv.includes('--replace');

  /**
   * Migration-only size ceiling: some legacy pictures are far larger than the
   * app's own upload limit, and raising that limit would change what admins may
   * upload. This override applies to this run alone.
   */
  const maxBytesArg = process.argv.find((arg) => arg.startsWith('--max-bytes='));
  const maxBytes = maxBytesArg ? Number.parseInt(maxBytesArg.split('=')[1], 10) : undefined;
  if (maxBytesArg && (!Number.isInteger(maxBytes) || maxBytes <= 0)) {
    throw new Error(`--max-bytes must be a positive integer, got "${maxBytesArg.split('=')[1]}"`);
  }

  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => runFoodImageMigration({ apply, replace, ...(maxBytes ? { maxBytes } : {}) }))
    .catch((error) => {
      logger.error(`Food image migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runFoodImageMigration;
