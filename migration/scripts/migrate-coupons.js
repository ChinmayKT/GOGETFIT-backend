/**
 * Migrates the legacy admin coupons (m_coupon) into the coupons collection.
 *
 *   npm run migrate:coupons              # dry run (report only)
 *   npm run migrate:coupons -- --apply   # write
 *
 * MariaDB is read-only throughout and the production-database rail applies.
 * Safe to re-run: identity is the legacy coupon_id. See docs/coupons-legacy.md.
 * Only m_coupon - not ambassador/renewal codes, payments or enrollments.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import Coupon from '../../src/models/coupon.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import { countCoupons, extractCoupons, resolveCouponColumns } from '../extractors/coupon.extractor.js';
import { loadCoupons, resolveLegacyCouponCreator, verifyCoupons } from '../loaders/coupon.loader.js';
import { writeReport } from '../reports/migration-report.js';

const rowsOf = (items) => (items.length ? items.map((i) => `    ${i.couponId}  ${String(i.code ?? '').padEnd(20)} ${i.reason}`) : ['    -']);

export const runCouponMigration = async ({ apply = false, runId = null } = {}) => {
  const dryRun = !apply;
  const id = runId ?? `coupons-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  logger.info(`Coupon migration (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only]`);

  // Before anything else: the existing admin who owns every legacy coupon.
  // Throws - and so stops the run with nothing written - if not exactly one admin matches.
  const creator = await resolveLegacyCouponCreator();
  logger.info(`legacy coupon creator: ${creator.email} -> User ${creator.id} (roles: ${creator.roles.join(', ')})`);

  const columns = await resolveCouponColumns();
  const sourceCount = await countCoupons();
  const rows = await extractCoupons();
  const before = await Coupon.countDocuments();

  const s = await loadCoupons(rows, { dryRun, runId: id, creatorId: creator.id });
  const verify = dryRun ? null : await verifyCoupons(rows, { creatorId: creator.id });
  const after = await Coupon.countDocuments();

  logger.info(
    [
      '',
      '────────── COUPON MIGRATION (m_coupon → coupons) ──────────',
      `mode                       : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `run id                     : ${id}`,
      `source                     : ${migrationEnv.mysql.database}.${migrationEnv.couponTable}`,
      `legacy rows found          : ${sourceCount}`,
      `${dryRun ? 'would migrate (new)' : 'migrated (new)     '}        : ${dryRun ? s.toCreate : s.created}`,
      `${dryRun ? 'would update       ' : 'updated from legacy'}        : ${dryRun ? s.toUpdate : s.updated}`,
      `already migrated, unchanged: ${s.alreadyMigrated}`,
      `skipped                    : ${s.skipped.length}`,
      `malformed                  : ${s.malformed.length}  (dates ${s.malformedDates}, discounts ${s.malformedDiscounts})`,
      `conflicts                  : ${s.conflicts.length}  (active duplicates ${s.activeDuplicateConflicts.length})`,
      `errors                     : ${s.errors.length}`,
      `creator (createdBy/updatedBy): ${creator.email} = User ${creator.id}`,
      `${dryRun ? 'would map' : 'mapped   '} createdBy          : ${s.createdByMapped}`,
      `${dryRun ? 'would map' : 'mapped   '} updatedBy          : ${s.updatedByMapped}`,
      '',
      `migratable (status by today's date): active ${s.counts.active} / inactive ${s.counts.inactive} · public ${s.counts.public} / private ${s.counts.private} · legacy-deleted ${s.counts.deleted}`,
      `duplicate codes in source  : ${s.duplicateCodes.length ? '' : '-'}`,
      ...s.duplicateCodes.map((d) => `    ${d.code}: ${d.coupons.map((c) => `#${c.couponId}${c.deleted ? ' (deleted in legacy)' : ''}`).join(', ')}`),
      'skipped:', ...rowsOf(s.skipped),
      'malformed:', ...rowsOf(s.malformed),
      'conflicts:', ...rowsOf(s.conflicts),
      'errors:', ...rowsOf(s.errors),
      '',
      'legacy coupon_id → Mongo _id:',
      ...s.idMap.map((m) => `    ${String(m.couponId).padEnd(5)} ${m.code.padEnd(20)} ${m.status.padEnd(9)} ${(m.deleted ? 'deleted' : '').padEnd(8)} ${m.mongoId ?? '(dry run)'}`),
      ...(verify
        ? [
            '',
            '── verification (independent re-read of MongoDB) ──',
            `coupons in MongoDB         : ${before} before → ${after} after`,
            `migrated coupons in MongoDB: ${verify.migratedInMongo}`,
            `duplicate legacy ids       : ${verify.duplicateLegacyIds.length ? verify.duplicateLegacyIds.join(', ') : 'none'}`,
            `invariant problems         : ${verify.problems.length ? '' : 'none'}`,
            ...verify.problems.map((p) => `    ${p}`),
            `field mismatches vs legacy : ${verify.mismatches.length ? '' : 'none'}`,
            ...verify.mismatches.map((m) => `    ${m.couponId}: ${m.fields.join(', ')}${m.editedInPortal ? ' (edited in portal)' : ''}`),
            `portal coupons with legacy : ${verify.portalCouponsWithLegacy}`,
          ]
        : []),
      columns.missing.length ? `legacy columns ABSENT      : ${columns.missing.join(', ')}` : '',
      '───────────────────────────────────────────────────────────',
    ].filter((l) => l !== '').join('\n'),
  );

  const report = {
    runId: id,
    dryRun,
    source: migrationEnv.source,
    table: migrationEnv.couponTable,
    creator: { id: String(creator.id), email: creator.email, roles: creator.roles },
    sourceCount,
    before,
    after,
    summary: s,
    verify,
    finishedAt: new Date().toISOString(),
  };
  const file = await writeReport(report);
  logger.info(`report (incl. legacy → Mongo id map): ${file ?? 'migration/reports/runs'}`);
  return report;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('migrate-coupons.js');
if (isEntryPoint) {
  const apply = process.argv.includes('--apply');
  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => Coupon.syncIndexes())
    .then(() => runCouponMigration({ apply }))
    .catch((error) => {
      logger.error(`Coupon migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runCouponMigration;
