/**
 * Links migrated enrollments to their new Coach through the legacy coach name
 * and email the enrollment already carries (legacy.coachName / coachEmail).
 *
 *   npm run migrate:link-coaches               # dry run (default - never writes)
 *   npm run migrate:link-coaches -- --apply    # assign the unambiguous matches
 *
 * Per legacy enrollment:
 *   - a coachId pointing at an existing Coach is left exactly as it is;
 *   - otherwise the legacy coach is resolved with the shared mapping
 *     (migration/mappings/legacy-coach.mapping.js - exact email, then exact
 *     normalized name, exactly one coach or nothing) and, on --apply, coachId
 *     is set and legacy.coachResolvedBy records how ('email' | 'name');
 *   - unmatched / ambiguous / conflicting enrollments are untouched and listed.
 *
 * Nothing is deleted, no legacy field is changed or removed, and a re-run only
 * touches enrollments that still have no valid coach (idempotent). Works on any
 * database it is pointed at - nothing about a coach, an id or a count is fixed.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import env from '../../src/config/env.js';
import logger from '../../src/config/logger.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { buildCoachDirectory, normalizeEmail, normalizeName, resolveLegacyCoach } from '../mappings/legacy-coach.mapping.js';
import { writeReport } from '../reports/migration-report.js';

const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : null);

/** Read-only: classifies every legacy enrollment and groups them by legacy coach. */
export const planCoachLinks = async () => {
  const enrollments = await EnrolledClient.find(
    { 'legacy.enrollmentId': { $exists: true } },
    { userId: 1, planId: 1, coachId: 1, enrollDate: 1, isDeleted: 1, legacy: 1 },
  ).lean();
  const directory = await buildCoachDirectory();

  const users = await User.find({ _id: { $in: enrollments.map((e) => e.userId) } }, { 'profile.name': 1, 'phone.normalized': 1, 'legacy.userId': 1 }).lean();
  const plans = await GogetfitPlan.find({ _id: { $in: enrollments.map((e) => e.planId) } }, { name: 1, 'legacy.packageId': 1 }).lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const planById = new Map(plans.map((p) => [String(p._id), p]));

  const row = (e) => {
    const user = userById.get(String(e.userId));
    const plan = planById.get(String(e.planId));
    return {
      enrollmentId: String(e._id),
      legacyEnrollmentId: e.legacy?.enrollmentId ?? null,
      userId: String(e.userId),
      userName: user?.profile?.name ?? null,
      phone: user?.phone?.normalized ?? null,
      legacyUserId: user?.legacy?.userId ?? e.legacy?.userId ?? null,
      plan: plan?.name ?? null,
      legacyPackageId: plan?.legacy?.packageId ?? e.legacy?.packageId ?? null,
      enrollDate: day(e.enrollDate),
      isDeleted: Boolean(e.isDeleted),
      currentCoachId: e.coachId ? String(e.coachId) : null,
    };
  };

  const alreadyLinked = [];
  const danglingLinks = [];
  const groups = new Map(); // legacy coach key -> { legacyName, legacyEmail, result, enrollments }

  for (const e of enrollments) {
    if (e.coachId && directory.ids.has(String(e.coachId))) {
      alreadyLinked.push(row(e));
      continue;
    }
    // A coachId that points at no Coach is not a valid relationship.
    if (e.coachId) danglingLinks.push(row(e));

    const legacyName = e.legacy?.coachName ?? null;
    const legacyEmail = e.legacy?.coachEmail ?? null;
    const key = `${normalizeEmail(legacyEmail) ?? ''}|${normalizeName(legacyName) ?? ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        legacyName,
        legacyEmail,
        legacyCoachIds: new Set(),
        result: resolveLegacyCoach({ name: legacyName, email: legacyEmail }, directory),
        enrollments: [],
      });
    }
    const group = groups.get(key);
    if (e.legacy?.coachId != null) group.legacyCoachIds.add(e.legacy.coachId);
    group.enrollments.push(row(e));
  }

  const list = [...groups.values()]
    .map((g) => ({ ...g, legacyCoachIds: [...g.legacyCoachIds] }))
    .sort((a, b) => b.enrollments.length - a.enrollments.length);
  const by = (status) => list.filter((g) => g.result.status === status);
  const count = (gs) => gs.reduce((n, g) => n + g.enrollments.length, 0);

  const summary = {
    totalLegacyEnrollments: enrollments.length,
    alreadyLinked: alreadyLinked.length,
    toLink: count(by('matched')),
    unmatched: count(by('unmatched')),
    ambiguous: count(by('ambiguous')),
    conflicting: count(by('conflict')),
    danglingLinks: danglingLinks.length,
    newCoaches: directory.entries.length,
  };
  // Every enrollment is accounted for exactly once - none can be silently dropped.
  const accounted = summary.alreadyLinked + summary.toLink + summary.unmatched + summary.ambiguous + summary.conflicting;
  if (accounted !== summary.totalLegacyEnrollments) {
    throw new Error(`Accounting error: ${accounted} classified vs ${summary.totalLegacyEnrollments} legacy enrollments`);
  }

  return { summary, groups: list, alreadyLinked, danglingLinks };
};

/**
 * Assigns coachId for every unambiguous match. Only enrollments that still
 * have no valid coach are written (the filter re-checks it), so a re-run - or a
 * link made in the meantime - is never overwritten.
 */
export const applyCoachLinks = async (plan, at = new Date()) => {
  const assignments = [];
  for (const group of plan.groups) {
    if (group.result.status !== 'matched') continue;
    const coachId = new mongoose.Types.ObjectId(group.result.coach.coachId);
    for (const e of group.enrollments) {
      const res = await EnrolledClient.collection.updateOne(
        {
          _id: new mongoose.Types.ObjectId(e.enrollmentId),
          // Unlinked, or the same dangling id the plan saw - never a valid link.
          coachId: e.currentCoachId ? new mongoose.Types.ObjectId(e.currentCoachId) : null,
        },
        { $set: { coachId, 'legacy.coachResolvedBy': group.result.by, updatedAt: at } },
      );
      assignments.push({ ...e, coachId: String(coachId), coachName: group.result.coach.name, by: group.result.by, written: res.modifiedCount === 1 });
    }
  }
  return { assignments, linked: assignments.filter((a) => a.written).length, skipped: assignments.filter((a) => !a.written).length };
};

// --- CLI ---------------------------------------------------------------------------------

const enrollmentLine = (e) =>
  `      ${String(e.legacyEnrollmentId ?? '-').padStart(5)}  ${String(e.userName ?? '-').slice(0, 24).padEnd(24)} ${String(e.phone ?? '-').padEnd(13)} ` +
  `user ${String(e.legacyUserId ?? '-').padEnd(5)} ${String(e.plan ?? '-').slice(0, 30).padEnd(30)} (pkg ${e.legacyPackageId ?? '-'})  ${e.enrollDate ?? '-'}` +
  `${e.isDeleted ? '  [deleted]' : ''}`;

const printPlan = (plan, meta) => {
  const s = plan.summary;
  const lines = [
    '',
    '────────── LEGACY ENROLLMENT → COACH LINKS ──────────',
    `mode       : ${meta.apply ? 'APPLY' : 'DRY RUN (no writes)'}`,
    `database   : ${meta.database} · environment ${meta.nodeEnv}`,
    '',
    `total legacy enrollments : ${s.totalLegacyEnrollments}`,
    `already linked           : ${s.alreadyLinked}`,
    `will be linked           : ${s.toLink}`,
    `unmatched                : ${s.unmatched}`,
    `ambiguous                : ${s.ambiguous}`,
    `conflicting              : ${s.conflicting}`,
    `dangling coachId         : ${s.danglingLinks}  (point at no Coach - re-resolved above)`,
    `new coaches in directory : ${s.newCoaches}`,
    '',
    'BY LEGACY COACH',
  ];
  for (const g of plan.groups) {
    const legacy = `${g.legacyName ?? '(no name)'} <${g.legacyEmail ?? 'no email'}>`;
    const n = `${g.enrollments.length} enrollment${g.enrollments.length === 1 ? '' : 's'}`;
    if (g.result.status === 'matched') {
      lines.push(
        '',
        `  ${legacy}  →  ${g.result.coach.name ?? '(no name)'} <${g.result.coach.email ?? 'no email'}>  coachId ${g.result.coach.coachId}  [by ${g.result.by}]  ${n}`,
      );
    } else {
      lines.push('', `  ${legacy}  →  ${g.result.status.toUpperCase()}: ${g.result.reason}  ${n}`);
      for (const c of g.result.candidates) lines.push(`      candidate: ${c.name} <${c.email}> ${c.coachId}`);
    }
    if (g.legacyCoachIds.length) lines.push(`      legacy coach_id: ${g.legacyCoachIds.join(', ')}`);
    lines.push('      legacy#  member                   phone         legacy user  plan                           enrolled');
    for (const e of g.enrollments) lines.push(enrollmentLine(e));
  }
  if (plan.alreadyLinked.length) {
    lines.push('', `ALREADY LINKED (left unchanged): ${plan.alreadyLinked.length}`);
    for (const e of plan.alreadyLinked) lines.push(enrollmentLine(e));
  }
  lines.push('─────────────────────────────────────────────────────');
  logger.info(lines.join('\n'));
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('link-legacy-coaches.js');
if (isEntryPoint) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const unknown = args.filter((a) => !['--apply', '--dry-run'].includes(a));
  if (unknown.length || (apply && args.includes('--dry-run'))) {
    logger.error('Usage: npm run migrate:link-coaches [-- --dry-run | -- --apply]');
    process.exit(1);
  }
  const runId = `link-coaches-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  Promise.resolve()
    .then(() => mongoose.connect(env.mongoUri))
    .then(async () => {
      const meta = { apply, database: mongoose.connection.db.databaseName, nodeEnv: env.nodeEnv };
      const plan = await planCoachLinks();
      printPlan(plan, meta);
      const report = { runId, ...meta, summary: plan.summary, groups: plan.groups, alreadyLinked: plan.alreadyLinked, danglingLinks: plan.danglingLinks, applied: null };
      if (apply) {
        const result = await applyCoachLinks(plan);
        for (const a of result.assignments) {
          logger.info(`${a.written ? 'linked ' : 'skipped'} enrollment ${a.legacyEnrollmentId ?? a.enrollmentId} (${a.userName ?? '-'}) → ${a.coachName} ${a.coachId} [by ${a.by}]`);
        }
        const after = await planCoachLinks();
        logger.info(
          `APPLIED: linked ${result.linked}, skipped ${result.skipped} (already linked meanwhile). ` +
            `Now: already linked ${after.summary.alreadyLinked}, still unmatched ${after.summary.unmatched}, ambiguous ${after.summary.ambiguous}, conflicting ${after.summary.conflicting}`,
        );
        report.applied = { ...result, after: after.summary };
      }
      const file = await writeReport(report);
      logger.info(`report: ${file}`);
    })
    .catch((error) => {
      logger.error(`Coach linking failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close().catch(() => {}));
}

export default { planCoachLinks, applyCoachLinks };
