/**
 * Which legacy clients do the workout plans need that MongoDB does not have -
 * and could the established user migration bring each of them over? READ ONLY.
 *
 *   node migration/scripts/reconcile-workout-plan-clients.js [--report=<dir>]
 *
 * For every m_workout_plan.user_id with no users.legacy.userId, applies the
 * same rules as migrate-users.js / migrate-single-user.js, without writing:
 *   - the row must exist in m_user (the user table the migration reads);
 *   - its phone must normalize (transformLegacyUser), the record must pass
 *     validateBatch;
 *   - no other legacy row may share its normalized phone (the full run parks
 *     those as DUPLICATE_LEGACY_PHONE conflicts for a recorded resolution);
 *   - loadUsers in dry-run mode: would insert, already migrated, or a phone
 *     already held by a different MongoDB user (never merged, never guessed).
 * Recorded MigrationConflict rows naming the id are listed too.
 *
 * user_id 0 is reported apart: no legacy table records another owner for
 * those plans (r_workout_plan_dates has no client column; created_by is the
 * author), so they stay blocked.
 *
 * Output names clients by legacy id only - no names, phones or emails.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import User from '../../src/models/user.model.js';
import MigrationConflict from '../../src/models/migration-conflict.model.js';
import { closePool, query } from '../config/mariadb.js';
import { assertMigrationEnv, migrationEnv } from '../config/migration.env.js';
import { resolveSelectableColumns } from '../extractors/user.extractor.js';
import { transformLegacyUser } from '../transformers/user.transformer.js';
import { transformLegacyPhone } from '../transformers/phone.transformer.js';
import { validateBatch } from '../validators/migration.validator.js';
import { loadUsers } from '../loaders/user.loader.js';

const count = (list) => list.reduce((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});

/**
 * The verdict for each candidate, from facts gathered elsewhere. Pure.
 * @returns 'would_migrate' | 'absent_from_legacy' | 'unusable_phone' | 'invalid_record'
 *        | 'duplicate_legacy_phone' | 'phone_held_by_other_user' | 'already_migrated' | 'no_owner'
 */
export const verdictFor = ({ legacyUserId, row, phoneOk, invalid, sharedPhoneWith, load }) => {
  if (legacyUserId === 0) return 'no_owner';
  if (!row) return 'absent_from_legacy';
  if (!phoneOk) return 'unusable_phone';
  if (invalid) return 'invalid_record';
  if (sharedPhoneWith.length) return 'duplicate_legacy_phone';
  if (load === 'already_migrated') return 'already_migrated';
  if (load === 'phone_collision') return 'phone_held_by_other_user';
  return 'would_migrate';
};

export const reconcileWorkoutPlanClients = async ({ reportDir = null } = {}) => {
  const owners = await query(
    `SELECT p.user_id, COUNT(*) AS plans,
            SUM(EXISTS (SELECT 1 FROM r_workout_plan_dates d WHERE d.workout_plan_id = p.workout_plan_id)) AS dated
       FROM m_workout_plan p GROUP BY p.user_id ORDER BY p.user_id`,
  );
  const ownerIds = owners.map((o) => Number(o.user_id));
  const known = await User.find({ 'legacy.source': migrationEnv.source, 'legacy.userId': { $in: ownerIds } }).select('legacy.userId').lean();
  const knownIds = new Set(known.map((u) => u.legacy.userId));
  const missing = owners.filter((o) => !knownIds.has(Number(o.user_id)));
  const ids = missing.map((o) => Number(o.user_id)).filter(Boolean);

  const { selected } = await resolveSelectableColumns();
  const rows = ids.length ? await query('SELECT ?? FROM ?? WHERE user_id IN (?) ORDER BY user_id ASC', [selected, migrationEnv.userTable, ids]) : [];
  const rowById = new Map(rows.map((r) => [Number(r.user_id), r]));
  const transformed = rows.map((r) => transformLegacyUser(r));
  const usable = transformed.filter((u) => u.phone.ok);

  // Every legacy phone, normalized in memory only, to find shared numbers.
  const allPhones = await query('SELECT user_id, phone_number FROM ??', [migrationEnv.userTable]);
  const byPhone = new Map();
  for (const r of allPhones) {
    const p = transformLegacyPhone(r.phone_number);
    if (!p.ok) continue;
    if (!byPhone.has(p.normalized)) byPhone.set(p.normalized, []);
    byPhone.get(p.normalized).push(Number(r.user_id));
  }

  const validation = validateBatch(usable, { source: migrationEnv.source });
  const invalidIds = new Set(validation.invalid.map((e) => e.legacyUserId));
  // The loader's own dry run decides per id; it writes nothing when dryRun.
  const loadVerdict = new Map();
  for (const u of usable) {
    const one = await loadUsers([u], { runId: 'reconcile', dryRun: true });
    loadVerdict.set(u.legacyUserId, one.skippedAlreadyMigrated ? 'already_migrated' : one.skippedDuplicatePhone ? 'phone_collision' : 'insert');
  }
  const conflicts = ids.length
    ? await MigrationConflict.find({ legacyUserIds: { $in: ids } }).select('type status legacyUserIds').lean()
    : [];

  const enrollmentRows = ids.length
    ? await query('SELECT user_id, COUNT(*) AS n FROM ?? WHERE user_id IN (?) GROUP BY user_id', [migrationEnv.enrollmentTable, ids])
    : [];
  const enrollmentsOf = new Map(enrollmentRows.map((r) => [Number(r.user_id), Number(r.n)]));

  const clients = missing.map((o) => {
    const legacyUserId = Number(o.user_id);
    const t = transformed.find((u) => u.legacyUserId === legacyUserId);
    const sharedPhoneWith = t?.phone.ok ? (byPhone.get(t.phone.normalized) ?? []).filter((id) => id !== legacyUserId) : [];
    return {
      legacyUserId,
      plans: Number(o.plans),
      datedPlans: Number(o.dated),
      legacyEnrollments: enrollmentsOf.get(legacyUserId) ?? 0,
      verdict: verdictFor({
        legacyUserId,
        row: rowById.get(legacyUserId),
        phoneOk: Boolean(t?.phone.ok),
        invalid: invalidIds.has(legacyUserId),
        sharedPhoneWith,
        load: loadVerdict.get(legacyUserId),
      }),
      phoneReason: t && !t.phone.ok ? t.phone.reason : null,
      sharedPhoneWith,
      recordedConflicts: conflicts.filter((c) => c.legacyUserIds.includes(legacyUserId)).map((c) => ({ type: c.type, status: c.status })),
    };
  });

  const report = {
    kind: 'workout-plan-clients-reconciliation',
    legacyDatabase: migrationEnv.mysql.database,
    target: { database: mongoose.connection.name },
    planOwners: owners.length,
    ownersInMongo: owners.length - missing.length,
    missingOwners: missing.length,
    byVerdict: count(clients.map((c) => c.verdict)),
    plansByVerdict: clients.reduce((acc, c) => ({ ...acc, [c.verdict]: (acc[c.verdict] ?? 0) + c.plans }), {}),
    wouldMigrateIds: clients.filter((c) => c.verdict === 'would_migrate').map((c) => c.legacyUserId),
    clients,
    finishedAt: new Date().toISOString(),
  };

  const dir = reportDir ?? path.join(process.cwd(), 'migration', 'reports', 'runs');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `workout-plan-clients-${report.finishedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  logger.info(
    [
      '',
      '──── workout-plan clients missing from MongoDB (read only) ────',
      `plan owners / in MongoDB / missing : ${report.planOwners} / ${report.ownersInMongo} / ${report.missingOwners}`,
      ...Object.entries(report.byVerdict).map(([v, n]) => `${v.padEnd(28)}: ${n} clients, ${report.plansByVerdict[v]} plans`),
      ...clients.filter((c) => c.verdict !== 'would_migrate').map((c) => `  #${c.legacyUserId} ${c.verdict}${c.phoneReason ? ` (${c.phoneReason})` : ''}${c.sharedPhoneWith.length ? ` shares phone with ${c.sharedPhoneWith.join(',')}` : ''}`),
      `would migrate (ids)         : ${report.wouldMigrateIds.join(',') || 'none'}`,
      `report: ${file}`,
    ].join('\n'),
  );
  return report;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('reconcile-workout-plan-clients.js');
if (isEntryPoint) {
  const reportDir = process.argv.find((a) => a.startsWith('--report='))?.slice(9) ?? null;
  Promise.resolve()
    .then(() => assertMigrationEnv())
    // Reads only: no implicit collection or index creation.
    .then(() => mongoose.connect(process.env.MONGODB_URI, { autoCreate: false, autoIndex: false }))
    .then(() => reconcileWorkoutPlanClients({ reportDir }))
    .catch((error) => {
      logger.error(`Reconciliation failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default reconcileWorkoutPlanClients;
