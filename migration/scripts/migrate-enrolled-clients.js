/**
 * Migrates the legacy enrollment/purchase flow (t_enrollment + t_payment) into
 * the EnrolledClient collection.
 *
 *   npm run migrate:enrolled-clients                              # dry run
 *   npm run migrate:enrolled-clients -- --apply                   # write
 *   npm run migrate:enrolled-clients -- --link-coaches-by-email   # see below
 *
 * MariaDB is read-only throughout, and the production-database rail in
 * assertMigrationEnv applies, so this cannot touch production without
 * MIGRATION_ALLOW_PRODUCTION=true.
 *
 * Requires the User, GoGetFit Plan and Coupon migrations to have run first -
 * this resolves against their legacy ids and creates none of them. The
 * prerequisites are checked before anything is written.
 *
 * --link-coaches-by-email is opt-in because the legacy coach relationship has no
 * verified mapping: the new Coach collection has no legacy identity. With the
 * flag, a legacy coach whose email matches exactly one new coach is linked and
 * the document records that it was resolved by email rather than proven by the
 * legacy data. Without it, every coachId stays null and legacy.coachId keeps the
 * original number.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import Coupon from '../../src/models/coupon.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import {
  countEnrollments,
  countPayments,
  extractCoaches,
  extractCoupons,
  extractEnrollments,
  resolveEnrollmentColumns,
} from '../extractors/enrollment.extractor.js';
import { buildMappings, loadEnrolledClients } from '../loaders/enrolled-client.loader.js';

const list = (values, limit = 15) => {
  const shown = values.slice(0, limit).join(', ');
  return values.length > limit ? `${shown} ...` : shown;
};

/**
 * The migrations this one depends on. Reported rather than assumed, so a run
 * against a half-migrated database explains itself instead of producing a pile
 * of "missing user" conflicts.
 */
export const checkPrerequisites = async () => {
  const [users, plans, coupons] = await Promise.all([
    User.countDocuments({ 'legacy.userId': { $exists: true } }),
    GogetfitPlan.countDocuments({ 'legacy.packageId': { $exists: true } }),
    Coupon.countDocuments({ 'legacy.couponId': { $exists: true } }),
  ]);
  return { users, plans, coupons, ready: users > 0 && plans > 0 };
};

export const runEnrolledClientMigration = async ({
  apply = false,
  linkCoachesByEmail = false,
  runId = null,
} = {}) => {
  const dryRun = !apply;
  const id = runId ?? `enrolled-${new Date().toISOString()}-${randomUUID().slice(0, 6)}`;

  logger.info(
    `Enrolled client migration (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only]`,
  );

  const prerequisites = await checkPrerequisites();
  if (!prerequisites.ready) {
    throw new Error(
      `Prerequisite migrations are missing (users with legacy ids: ${prerequisites.users}, ` +
        `plans: ${prerequisites.plans}). Run migrate:users and migrate:gogetfit-plans first.`,
    );
  }

  const columns = await resolveEnrollmentColumns();
  const [sourceEnrollments, sourcePayments] = await Promise.all([
    countEnrollments(),
    countPayments(),
  ]);

  const [rows, legacyCoupons, legacyCoaches] = await Promise.all([
    extractEnrollments(),
    extractCoupons(),
    // Always read m_coach: the coach's name is preserved on every enrollment,
    // whether or not the opt-in link resolves a Coach document.
    extractCoaches(),
  ]);

  const mappings = await buildMappings({ legacyCoupons, legacyCoaches, linkCoachesByEmail });
  const summary = await loadEnrolledClients(rows, { dryRun, runId: id, mappings });
  const c = summary.conflicts;

  logger.info(
    [
      '',
      '────────── ENROLLED CLIENT MIGRATION ──────────',
      `mode                        : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `run id                      : ${id}`,
      `legacy source               : ${migrationEnv.source}`,
      `legacy database             : ${migrationEnv.mysql.database}`,
      `legacy tables               : ${migrationEnv.enrollmentTable} + ${migrationEnv.paymentTable}`,
      `coach linking               : ${linkCoachesByEmail ? 'by email (opt-in, inferred)' : 'off - coachId stays null'}`,
      '',
      `Prerequisites               : ${prerequisites.users} users, ${prerequisites.plans} plans, ${prerequisites.coupons} coupons with legacy ids`,
      `Source t_enrollment rows    : ${sourceEnrollments}`,
      `Source t_payment rows       : ${sourcePayments}`,
      `Enrollments inspected       : ${summary.inspected}`,
      '',
      `${dryRun ? 'Would create               ' : 'Created                    '} : ${dryRun ? summary.toCreate : summary.created}`,
      `${dryRun ? 'Would update               ' : 'Updated                    '} : ${dryRun ? summary.toUpdate : summary.updated}`,
      `Already migrated, unchanged : ${summary.unchanged}`,
      `Skipped (not migratable)    : ${summary.skipped.length}`,
      `Users gaining "client" role : ${dryRun ? summary.rolesToUpdate : summary.rolesUpdated}`,
      `Errors                      : ${summary.errors.length}`,
      '',
      '── unresolved relationships (reported, never guessed) ──',
      `Missing user   (skipped)    : ${c.missingUser.length}${c.missingUser.length ? ` -> enrollment ${list(c.missingUser.map((x) => `${x.enrollmentId}(user ${x.legacyUserId})`))}` : ''}`,
      `Missing plan   (skipped)    : ${c.missingPlan.length}${c.missingPlan.length ? ` -> enrollment ${list(c.missingPlan.map((x) => x.enrollmentId))}` : ''}`,
      `Unmapped coach (migrated)   : ${c.missingCoach.length}${c.missingCoach.length ? ` -> legacy coach ${list([...new Set(c.missingCoach.map((x) => x.legacyCoachId))])}` : ''}`,
      `Coupon not found            : ${c.missingCoupon.length}`,
      `Coupon ambiguous            : ${c.ambiguousCoupon.length}${c.ambiguousCoupon.length ? ` -> ${list([...new Set(c.ambiguousCoupon.map((x) => x.couponCode))])}` : ''}`,
      `Missing payment row         : ${c.missingPayment.length}`,
      `Malformed dates             : ${c.malformedDate.length}`,
      `Duplicate legacy ids        : ${c.duplicateLegacyId.length}`,
      `Unknown payment status      : ${c.unknownPaymentStatus.length}`,
      '',
      `Legacy columns present      : ${migrationEnv.enrollmentTable}(${columns.enrollment.length}), ${migrationEnv.paymentTable}(${columns.payment.length})`,
      columns.enrollmentMissing.length > 0
        ? `Legacy columns ABSENT       : ${migrationEnv.enrollmentTable}(${columns.enrollmentMissing.join(', ')})`
        : '',
      columns.paymentMissing.length > 0
        ? `Legacy columns ABSENT       : ${migrationEnv.paymentTable}(${columns.paymentMissing.join(', ')})`
        : '',
      '───────────────────────────────────────────────',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  if (summary.errors.length > 0) {
    for (const error of summary.errors.slice(0, 10)) logger.error(`  ${error}`);
  }

  // Field-level verification against the source, on the rows that were written.
  const verify = dryRun ? null : await verifyAgainstLegacy(rows, mappings);
  if (verify) {
    logger.info(
      [
        '── verification (legacy row vs stored document) ──',
        `Legacy rows compared        : ${verify.compared}`,
        `Documents found             : ${verify.found}`,
        `Field mismatches            : ${verify.mismatches.length}`,
        `Whitespace-only trims       : ${verify.trimmed.length}  (legacy value had surrounding spaces)`,
        ...verify.mismatches.slice(0, 10).map((m) => `    enrollment ${m.enrollmentId}: ${m.field} legacy=${m.legacy} mongo=${m.mongo}`),
        '',
      ].join('\n'),
    );
  }

  return { summary, verify };
};

/**
 * Re-reads what was written and compares it field by field with the legacy row,
 * so "migrated" is a checked claim rather than a bulkWrite return value.
 */
export const verifyAgainstLegacy = async (rows, mappings) => {
  const byLegacyId = new Map(rows.map((r) => [Number(r.enrollment_id), r]));
  const docs = await EnrolledClient.find(
    { 'legacy.source': mappings.source },
    {
      'legacy.enrollmentId': 1,
      'legacy.coachId': 1,
      'legacy.userId': 1,
      'legacy.packageId': 1,
      'legacy.couponCode': 1,
      payment: 1,
      enrollDate: 1,
      startDate: 1,
      endDate: 1,
      hasStarted: 1,
      isDeleted: 1,
      userId: 1,
      planId: 1,
    },
  ).lean();

  const mismatches = [];
  /**
   * Differences that are only surrounding whitespace. The transformer trims
   * text, so a legacy 'Rakesh ' is stored as 'Rakesh'. Counted separately
   * rather than reported as a mismatch or hidden entirely - it is the one place
   * a stored string is not byte-identical to the legacy value.
   */
  const trimmed = [];
  const time = (value) => (value ? new Date(value).getTime() : null);
  const legacyTime = (value) => (value ? new Date(String(value).replace(' ', 'T')).getTime() : null);

  for (const doc of docs) {
    const row = byLegacyId.get(doc.legacy.enrollmentId);
    if (!row) continue;

    const checks = [
      ['legacy.userId', Number(row.user_id), doc.legacy.userId],
      ['legacy.packageId', Number(row.package_id), doc.legacy.packageId],
      ['legacy.coachId', Number(row.coach_id), doc.legacy.coachId],
      ['enrollDate', legacyTime(row.enroll_date), time(doc.enrollDate)],
      ['startDate', legacyTime(row.start_date), time(doc.startDate)],
      ['endDate', legacyTime(row.end_date), time(doc.endDate)],
      ['hasStarted', String(row.start_flg) === '1', doc.hasStarted],
      ['isDeleted', String(row.delete_flg) === '1', doc.isDeleted],
      ['payment.transactionId', String(row.transaction_id ?? '').trim(), doc.payment?.transactionId],
      ['payment.amount', row.p_amount === null || row.p_amount === undefined ? null : Number(row.p_amount), doc.payment?.amount ?? null],
      ['payment.status', row.p_status ?? null, doc.payment?.status ?? null],
      ['payment.paidAt', legacyTime(row.p_payment_date), time(doc.payment?.paidAt)],
      ['payment.customerName', row.p_customer_name ?? null, doc.payment?.customerName ?? null],
      ['payment.originalAmount', row.p_original_amount === null || row.p_original_amount === undefined ? null : Number(row.p_original_amount), doc.payment?.originalAmount ?? null],
      ['payment.discountPercent', row.p_discount_percent === null || row.p_discount_percent === undefined ? null : Number(row.p_discount_percent), doc.payment?.discountPercent ?? null],
    ];

    for (const [field, legacy, mongo] of checks) {
      if (legacy === mongo) continue;

      if (typeof legacy === 'string' && typeof mongo === 'string' && legacy.trim() === mongo) {
        trimmed.push({ enrollmentId: doc.legacy.enrollmentId, field });
        continue;
      }
      mismatches.push({ enrollmentId: doc.legacy.enrollmentId, field, legacy, mongo });
    }
  }

  return { compared: byLegacyId.size, found: docs.length, mismatches, trimmed };
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('migrate-enrolled-clients.js');

if (isEntryPoint) {
  const apply = process.argv.includes('--apply');
  const linkCoachesByEmail = process.argv.includes('--link-coaches-by-email');

  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => EnrolledClient.syncIndexes())
    .then(() => runEnrolledClientMigration({ apply, linkCoachesByEmail }))
    .catch((error) => {
      logger.error(`Enrolled client migration failed: ${error.message}`);
      logger.debug(error.stack);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runEnrolledClientMigration;
