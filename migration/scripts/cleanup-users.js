/**
 * Staging/dev data cleanup: leave exactly TARGET users, of whom exactly
 * ENROLLED_TARGET are enrolled and the rest have no enrollment at all.
 *
 *   npm run cleanup:users                  # dry run (default - never writes)
 *   npm run cleanup:users -- --dry-run     # same
 *   npm run cleanup:users -- --apply       # write, inside one transaction
 *
 * "Enrolled" means: the user's _id appears in enrolledclients.userId. The roles
 * array is NOT used to decide that, and no role is ever added or removed.
 *
 * Selection (deterministic, never random), at USER level:
 *   1. Enrolled: exactly ENROLLED_TARGET users - protected enrolled users first,
 *      then more enrollment records, then newest enrollDate, then _id ascending.
 *      A selected user keeps ALL of their enrollment records.
 *   2. Enrolled users not selected lose ALL of their enrollment records. They are
 *      then ordinary non-enrolled users and compete for the remaining slots.
 *   3. Non-enrolled: exactly TARGET - ENROLLED_TARGET users - protected first,
 *      then newest createdAt, then _id ascending.
 *   4. Every other user is deleted (their enrollments were already removed in 2).
 *
 * Any reference to a deleted user other than enrolledclients.userId (coaches,
 * coupons, plans, ...) fails validation - nothing is deleted blindly.
 *
 * Refuses to run when NODE_ENV is production or the database/host looks like
 * production. Uses the app's MONGODB_URI and the app's phone normalization.
 */
import { createHash, randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import env from '../../src/config/env.js';
import logger from '../../src/config/logger.js';
import { normalizePhone } from '../../src/utils/phone.js';
import { writeReport } from '../reports/migration-report.js';

export const TARGET_USERS = 50;
export const ENROLLED_TARGET = 25;
export const PROTECTED_PHONES = ['8123260930', '9900298489', '9871749771'];

export class CleanupAbort extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'CleanupAbort';
    this.problems = problems;
  }
}

/** Refuse anything that looks like production. */
export const assertNotProduction = ({ nodeEnv = env.nodeEnv, databaseName, host = '' }) => {
  const problems = [];
  if (nodeEnv === 'production') problems.push(`NODE_ENV is "${nodeEnv}"`);
  if (/prod/i.test(databaseName ?? '')) problems.push(`database name "${databaseName}" looks like production`);
  if (/prod/i.test(host ?? '')) problems.push(`host "${host}" looks like production`);
  if (problems.length) throw new CleanupAbort('Refusing to run against what looks like production', problems);
};

const time = (d) => (d instanceof Date ? d.getTime() : 0);
const byIdAsc = (a, b) => String(a._id).localeCompare(String(b._id));

/**
 * Every field, in every collection, whose ObjectId value (at any depth) points at
 * one of `ids`. Generic on purpose, so a collection without a model is not missed.
 */
export const findReferences = async (db, ids, { session } = {}) => {
  const wanted = new Set([...ids].map(String));
  const refs = [];
  if (!wanted.size) return refs;
  const walk = (value, path, hit) => {
    if (value instanceof mongoose.Types.ObjectId) {
      if (wanted.has(String(value))) hit(path, String(value));
    } else if (Array.isArray(value)) {
      value.forEach((v) => walk(v, `${path}[]`, hit));
    } else if (value && typeof value === 'object' && !(value instanceof Date) && value._bsontype === undefined) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, hit);
    }
  };
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  for (const name of collections) {
    for await (const doc of db.collection(name).find({}, { session })) {
      for (const [key, value] of Object.entries(doc)) {
        if (key === '_id') continue;
        walk(value, key, (field, userId) => refs.push({ collection: name, field, docId: String(doc._id), userId }));
      }
    }
  }
  return refs;
};

/** Order-independent fingerprint of the users and enrollments a plan was made from. */
const fingerprintOf = (userIds, enrollmentIds) =>
  createHash('sha256')
    .update([...userIds].map(String).sort().join(','))
    .update('|')
    .update([...enrollmentIds].map(String).sort().join(','))
    .digest('hex');

const readState = async (db, { session } = {}) => {
  const users = await db
    .collection('users')
    .find({}, { session, projection: { phone: 1, 'profile.name': 1, roles: 1, createdAt: 1 } })
    .toArray();
  const enrollments = await db
    .collection('enrolledclients')
    .find({}, { session, projection: { userId: 1, enrollDate: 1 } })
    .toArray();
  return { users, enrollments, fingerprint: fingerprintOf(users.map((u) => u._id), enrollments.map((e) => e._id)) };
};

/** Read-only. Builds the full plan and validates it; never writes. */
export const planUserCleanup = async (
  db,
  { target = TARGET_USERS, enrolledTarget = ENROLLED_TARGET, protectedPhones = PROTECTED_PHONES } = {},
) => {
  const { users, enrollments, fingerprint } = await readState(db);
  const nonEnrolledTarget = target - enrolledTarget;
  const problems = [];

  // Enrolled users, from enrolledclients.userId only.
  const stats = new Map();
  for (const e of enrollments) {
    const key = String(e.userId);
    const s = stats.get(key) ?? { count: 0, latest: 0, enrollmentIds: [] };
    s.count += 1;
    s.latest = Math.max(s.latest, time(e.enrollDate));
    s.enrollmentIds.push(String(e._id));
    stats.set(key, s);
  }
  const userIds = new Set(users.map((u) => String(u._id)));
  const orphansNow = enrollments.filter((e) => !userIds.has(String(e.userId)));
  if (orphansNow.length) problems.push(`${orphansNow.length} enrollment records already reference missing users`);
  const statOf = (u) => stats.get(String(u._id)) ?? { count: 0, latest: 0, enrollmentIds: [] };

  // Protected users.
  const protectedUsers = protectedPhones.map((input) => {
    const normalized = normalizePhone(input);
    const matches = users.filter((u) => u.phone?.normalized === normalized);
    if (matches.length !== 1) problems.push(`protected phone ${normalized}: ${matches.length} users found (need exactly 1)`);
    return { input, normalized, user: matches[0] ?? null };
  });
  const protectedIds = new Set(protectedUsers.filter((p) => p.user).map((p) => String(p.user._id)));
  const isProtected = (u) => protectedIds.has(String(u._id));

  // 1. Exactly `enrolledTarget` enrolled users.
  const enrolledRanked = users
    .filter((u) => statOf(u).count > 0)
    .sort(
      (a, b) =>
        Number(isProtected(b)) - Number(isProtected(a)) ||
        statOf(b).count - statOf(a).count ||
        statOf(b).latest - statOf(a).latest ||
        byIdAsc(a, b),
    );
  const keptEnrolled = enrolledRanked.slice(0, enrolledTarget);
  const rejectedEnrolled = enrolledRanked.slice(enrolledTarget);
  const keptEnrolledIds = new Set(keptEnrolled.map((u) => String(u._id)));
  const rejectedEnrolledIds = new Set(rejectedEnrolled.map((u) => String(u._id)));

  // 2-3. Non-enrolled after step 2 = never enrolled + rejected enrolled.
  const nonEnrolledRanked = users
    .filter((u) => !keptEnrolledIds.has(String(u._id)))
    .sort((a, b) => Number(isProtected(b)) - Number(isProtected(a)) || time(b.createdAt) - time(a.createdAt) || byIdAsc(a, b));
  const keptNonEnrolled = nonEnrolledRanked.slice(0, Math.max(0, nonEnrolledTarget));
  const keptNonEnrolledIds = new Set(keptNonEnrolled.map((u) => String(u._id)));
  const keepIds = new Set([...keptEnrolledIds, ...keptNonEnrolledIds]);

  const reasonOf = (u) => {
    const id = String(u._id);
    const was = statOf(u).count > 0;
    if (keptEnrolledIds.has(id)) return isProtected(u) ? 'protected, enrolled - keeps all enrollments' : `enrolled: in the top ${enrolledTarget}`;
    if (keptNonEnrolledIds.has(id)) {
      if (isProtected(u)) return 'protected, non-enrolled';
      return was ? `enrolled: outside the top ${enrolledTarget} - enrollments deleted, kept as non-enrolled` : 'non-enrolled: newest createdAt';
    }
    return was ? `enrolled: outside the top ${enrolledTarget} - enrollments deleted, user deleted` : 'non-enrolled: no slot left - user deleted';
  };
  const row = (u) => {
    const s = statOf(u);
    const id = String(u._id);
    return {
      id,
      phone: u.phone?.normalized ?? null,
      name: u.profile?.name ?? null,
      roles: u.roles ?? [],
      createdAt: u.createdAt ?? null,
      enrollments: s.count,
      latestEnrollDate: s.latest ? new Date(s.latest) : null,
      protected: protectedIds.has(id),
      enrolledNow: s.count > 0,
      enrolledAfter: keptEnrolledIds.has(id),
      decision: keepIds.has(id) ? 'KEEP' : 'DELETE',
      enrollmentDecision: s.count === 0 ? '-' : keptEnrolledIds.has(id) ? 'KEEP ALL' : 'DELETE ALL',
      reason: reasonOf(u),
    };
  };
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const keepRows = [...keptEnrolled, ...keptNonEnrolled].map(row);
  const removeRows = users.filter((u) => !keepIds.has(String(u._id))).map(row);

  const enrollmentsKept = keptEnrolled.flatMap((u) => statOf(u).enrollmentIds);
  const enrollmentsDeleted = rejectedEnrolled.flatMap((u) => statOf(u).enrollmentIds);

  // Anything other than enrolledclients.userId that points at a user to delete is a blocker.
  const removeIds = removeRows.map((u) => u.id);
  const references = await findReferences(db, removeIds);
  const blockingRefs = references.filter((r) => !(r.collection === 'enrolledclients' && r.field === 'userId'));

  // Validation.
  if (enrolledTarget > target) problems.push(`enrolled target ${enrolledTarget} exceeds the user target ${target}`);
  if (users.length < target) problems.push(`only ${users.length} users exist; cannot reach ${target} without inventing users`);
  if (stats.size < enrolledTarget) problems.push(`only ${stats.size} enrolled users exist; need exactly ${enrolledTarget}`);
  const protectedEnrolled = [...protectedIds].filter((id) => stats.has(id)).length;
  if (protectedEnrolled > enrolledTarget) problems.push(`${protectedEnrolled} protected users are enrolled, more than ${enrolledTarget}`);
  if (keepRows.length !== target) problems.push(`plan keeps ${keepRows.length} users, expected exactly ${target}`);
  if (keptEnrolled.length !== enrolledTarget) problems.push(`plan keeps ${keptEnrolled.length} enrolled users, expected exactly ${enrolledTarget}`);
  if (keptNonEnrolled.length !== nonEnrolledTarget) problems.push(`plan keeps ${keptNonEnrolled.length} non-enrolled users, expected exactly ${nonEnrolledTarget}`);
  for (const p of protectedUsers) if (p.user && !keepIds.has(String(p.user._id))) problems.push(`protected ${p.normalized} would be deleted`);
  for (const id of keepIds) if (!byId.has(id)) problems.push(`kept user ${id} is not in the users collection`);
  // Every retained enrollment belongs to a kept enrolled user; every deleted one to a rejected user.
  const enrollmentById = new Map(enrollments.map((e) => [String(e._id), e]));
  if (enrollmentsKept.some((id) => !keptEnrolledIds.has(String(enrollmentById.get(id).userId)))) problems.push('a retained enrollment references a user that is not kept as enrolled');
  if (enrollmentsDeleted.some((id) => !rejectedEnrolledIds.has(String(enrollmentById.get(id).userId)))) problems.push('a deleted enrollment belongs to a retained enrolled user');
  if (enrollmentsKept.length + enrollmentsDeleted.length + orphansNow.length !== enrollments.length) problems.push('enrollment accounting does not add up');
  // No kept non-enrolled user may end up with an enrollment.
  for (const id of keptNonEnrolledIds) {
    if (stats.has(id) && !rejectedEnrolledIds.has(id)) problems.push(`non-enrolled user ${id} would keep enrollments`);
  }
  const phoneCounts = new Map();
  for (const u of keepRows) phoneCounts.set(u.phone, (phoneCounts.get(u.phone) ?? 0) + 1);
  const duplicatePhones = [...phoneCounts].filter(([, n]) => n > 1).map(([p]) => p);
  if (duplicatePhones.length) problems.push(`duplicate normalized phones would remain: ${duplicatePhones.join(', ')}`);
  for (const r of blockingRefs) problems.push(`${r.collection}.${r.field} (doc ${r.docId}) references user ${r.userId}, which would be deleted`);

  return {
    target,
    enrolledTarget,
    nonEnrolledTarget,
    fingerprint,
    current: { users: users.length, enrolledUsers: stats.size, nonEnrolledUsers: users.length - stats.size, enrollments: enrollments.length },
    protectedUsers: protectedUsers.map((p) => ({ input: p.input, normalized: p.normalized, ...(p.user ? row(p.user) : { id: null }) })),
    enrolledRows: enrolledRanked.map(row),
    nonEnrolledRows: users.filter((u) => statOf(u).count === 0).sort((a, b) => time(b.createdAt) - time(a.createdAt) || byIdAsc(a, b)).map(row),
    keepEnrolled: keptEnrolled.map(row),
    keepNonEnrolled: keptNonEnrolled.map(row),
    keep: keepRows,
    remove: removeRows,
    rejectedEnrolledIds: [...rejectedEnrolledIds],
    final: {
      users: keepRows.length,
      enrolled: keptEnrolled.length,
      nonEnrolled: keptNonEnrolled.length,
      enrolledLosingEnrollments: rejectedEnrolled.length,
      usersDeleted: removeRows.length,
      enrollmentsKept: enrollmentsKept.length,
      enrollmentsDeleted: enrollmentsDeleted.length,
    },
    references,
    blockingRefs,
    problems,
  };
};

/** End-state checks, shared by the transaction and the post-apply re-read. */
const checkEndState = async (db, plan, { session } = {}) => {
  const problems = [];
  const users = db.collection('users');
  const total = await users.countDocuments({}, { session });
  const ids = new Set((await users.distinct('_id', {}, { session })).map(String));
  const enrolledIds = (await db.collection('enrolledclients').distinct('userId', {}, { session })).map(String);
  const enrollments = await db.collection('enrolledclients').countDocuments({}, { session });
  const orphaned = enrolledIds.filter((id) => !ids.has(id));
  const enrolledUsers = enrolledIds.filter((id) => ids.has(id)).length;
  const nonEnrolledUsers = total - enrolledUsers;
  if (total !== plan.target) problems.push(`users = ${total}, expected ${plan.target}`);
  if (enrolledUsers !== plan.enrolledTarget) problems.push(`enrolled users = ${enrolledUsers}, expected exactly ${plan.enrolledTarget}`);
  if (nonEnrolledUsers !== plan.nonEnrolledTarget) problems.push(`non-enrolled users = ${nonEnrolledUsers}, expected exactly ${plan.nonEnrolledTarget}`);
  if (orphaned.length) problems.push(`${orphaned.length} users referenced by enrollments do not exist`);
  if (enrollments !== plan.final.enrollmentsKept) problems.push(`enrollments = ${enrollments}, planned ${plan.final.enrollmentsKept}`);
  const enrolledSet = new Set(enrolledIds);
  for (const k of plan.keepEnrolled) if (!enrolledSet.has(k.id)) problems.push(`kept enrolled user ${k.id} has no enrollments`);
  for (const k of plan.keepNonEnrolled) if (enrolledSet.has(k.id)) problems.push(`kept non-enrolled user ${k.id} still has enrollments`);
  for (const k of plan.keep) if (!ids.has(k.id)) problems.push(`kept user ${k.id} missing`);
  let protectedRetained = 0;
  for (const p of plan.protectedUsers) {
    const n = await users.countDocuments({ 'phone.normalized': p.normalized }, { session });
    if (n === 1) protectedRetained += 1;
    else problems.push(`protected ${p.normalized}: ${n} users`);
  }
  const dup = await users
    .aggregate([{ $group: { _id: '$phone.normalized', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }], { session })
    .toArray();
  if (dup.length) problems.push(`duplicate phones: ${dup.map((d) => d._id).join(', ')}`);
  return { total, enrolledUsers, nonEnrolledUsers, enrollments, orphaned: orphaned.length, protectedRetained, problems };
};

/**
 * Applies a plan in one transaction. The database must still be exactly the one
 * the plan was made from; anything unexpected throws and nothing is written.
 */
export const applyUserCleanup = async (connection, plan) => {
  if (plan.problems.length) throw new CleanupAbort('Plan failed validation; nothing written', plan.problems);

  const db = connection.db;
  const toId = (id) => new mongoose.Types.ObjectId(id);
  const rejectedIds = plan.rejectedEnrolledIds.map(toId);
  const removeIds = plan.remove.map((u) => toId(u.id));
  const result = { deletedEnrollments: 0, deletedUsers: 0 };

  const session = await connection.startSession();
  try {
    await session.withTransaction(async () => {
      // 1-2. Same users, same enrollments, same protected users.
      const state = await readState(db, { session });
      if (state.fingerprint !== plan.fingerprint) {
        throw new CleanupAbort('The database changed since the plan was made (users or enrollments differ); re-run the dry run');
      }
      for (const p of plan.protectedUsers) {
        const u = await db.collection('users').findOne({ 'phone.normalized': p.normalized }, { session, projection: { _id: 1 } });
        if (!u || String(u._id) !== p.id) throw new CleanupAbort(`protected ${p.normalized} no longer resolves to ${p.id}`);
        if (removeIds.some((id) => String(id) === p.id)) throw new CleanupAbort(`protected ${p.normalized} is in the delete set`);
      }
      const blocking = (await findReferences(db, plan.remove.map((u) => u.id), { session })).filter(
        (r) => !(r.collection === 'enrolledclients' && r.field === 'userId'),
      );
      if (blocking.length) throw new CleanupAbort(`${blocking.length} non-enrollment references to users being deleted`);

      // 3. All enrollments of the enrolled users that were not selected - and only those.
      const gone = await db.collection('enrolledclients').deleteMany({ userId: { $in: rejectedIds } }, { session });
      if (gone.deletedCount !== plan.final.enrollmentsDeleted) {
        throw new CleanupAbort(`enrollment delete hit ${gone.deletedCount}, planned ${plan.final.enrollmentsDeleted}`);
      }
      // 4. Users outside the KEEP set.
      const deleted = await db.collection('users').deleteMany({ _id: { $in: removeIds } }, { session });
      if (deleted.deletedCount !== removeIds.length) throw new CleanupAbort(`user delete hit ${deleted.deletedCount}/${removeIds.length}`);

      // 5-10. End state, still inside the transaction; 11. any failure aborts all of it.
      const end = await checkEndState(db, plan, { session });
      if (end.problems.length) throw new CleanupAbort('End state failed validation; transaction aborted', end.problems);

      result.deletedEnrollments = gone.deletedCount;
      result.deletedUsers = deleted.deletedCount;
    });
  } finally {
    await session.endSession();
  }
  return result;
};

/** Independent re-read after apply. */
export const verifyUserCleanup = async (db, plan) => {
  const end = await checkEndState(db, plan);
  const dangling = await findReferences(db, plan.remove.map((u) => u.id));
  if (dangling.length) end.problems.push(`${dangling.length} references to deleted users remain`);
  const users = await db
    .collection('users')
    .find({}, { projection: { phone: 1, 'profile.name': 1, roles: 1 } })
    .toArray();
  const counts = new Map();
  for (const e of await db.collection('enrolledclients').find({}, { projection: { userId: 1 } }).toArray()) {
    counts.set(String(e.userId), (counts.get(String(e.userId)) ?? 0) + 1);
  }
  const protectedIds = new Set(plan.protectedUsers.map((p) => p.id));
  const finalUsers = users
    .map((u) => ({
      id: String(u._id),
      name: u.profile?.name ?? null,
      phone: u.phone?.normalized ?? null,
      roles: u.roles ?? [],
      enrollments: counts.get(String(u._id)) ?? 0,
      protected: protectedIds.has(String(u._id)),
    }))
    .sort((a, b) => b.enrollments - a.enrollments || a.id.localeCompare(b.id));
  return { ...end, finalUsers };
};

// --- CLI ---------------------------------------------------------------------------------

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
const cell = (v, n) => String(v ?? '-').slice(0, n).padEnd(n);
const yes = (b) => (b ? 'yes' : 'no ');

const printPlan = (plan, meta) => {
  const enrolledLine = (u, i) =>
    `  ${String(i + 1).padStart(2)}. ${u.id}  ${cell(u.name, 24)} ${cell(u.phone, 13)} n=${String(u.enrollments).padStart(2)} last=${day(
      u.latestEnrollDate,
    )} protected=${yes(u.protected)} user=${u.decision.padEnd(6)} enrollments=${u.enrollmentDecision.padEnd(10)} ${u.reason}`;
  const nonEnrolledLine = (u, i) =>
    `  ${String(i + 1).padStart(2)}. ${u.id}  ${cell(u.name, 24)} ${cell(u.phone, 13)} created=${day(u.createdAt)} protected=${yes(u.protected)} ${u.decision.padEnd(6)} ${u.reason}`;
  const finalLine = (u, i) =>
    `  ${String(i + 1).padStart(2)}. ${u.id}  ${cell(u.name, 24)} ${cell(u.phone, 13)} ${cell(u.roles.join(','), 24)} enrollments kept=${String(
      u.enrolledAfter ? u.enrollments : 0,
    ).padStart(2)} protected=${yes(u.protected)}${u.enrolledNow && !u.enrolledAfter ? `  (loses ${u.enrollments} enrollment${u.enrollments > 1 ? 's' : ''})` : ''}`;
  const lines = [
    '',
    '────────── USER CLEANUP PLAN ──────────',
    `mode        : ${meta.apply ? 'APPLY' : 'DRY RUN (no writes)'}`,
    `environment : ${meta.nodeEnv}`,
    `database    : ${meta.database} @ ${meta.host}`,
    `target      : exactly ${plan.target} users = ${plan.enrolledTarget} enrolled + ${plan.nonEnrolledTarget} non-enrolled`,
    '',
    'CURRENT',
    `  Users                  : ${plan.current.users}`,
    `  Distinct enrolled users: ${plan.current.enrolledUsers}`,
    `  Non-enrolled users     : ${plan.current.nonEnrolledUsers}`,
    `  Enrollment records     : ${plan.current.enrollments}`,
    '',
    'PROTECTED USERS',
    ...plan.protectedUsers.map((p) =>
      p.id
        ? `  ${p.normalized}  ${p.id}  ${cell(p.name, 16)} enrolled=${yes(p.enrolledNow)} enrollments=${p.enrollments}  ${p.decision}`
        : `  ${p.normalized}  NOT FOUND`,
    ),
    '',
    `ENROLLED USERS (${plan.enrolledRows.length}; order: protected, enrollments desc, latest enrollDate desc, _id asc)`,
    ...plan.enrolledRows.map(enrolledLine),
    '',
    `NON-ENROLLED USERS NOW (${plan.nonEnrolledRows.length})`,
    ...plan.nonEnrolledRows.map(nonEnrolledLine),
    '',
    `REMAINING - ${plan.keepEnrolled.length} ENROLLED`,
    ...plan.keepEnrolled.map(finalLine),
    '',
    `REMAINING - ${plan.keepNonEnrolled.length} NON-ENROLLED`,
    ...plan.keepNonEnrolled.map(finalLine),
    '',
    'FINAL PLAN',
    `  Users to keep                       : ${plan.final.users}`,
    `  Enrolled users to keep              : ${plan.final.enrolled}`,
    `  Non-enrolled users to keep          : ${plan.final.nonEnrolled}`,
    `  Enrolled users losing enrollments   : ${plan.final.enrolledLosingEnrollments}`,
    `  Users to delete                     : ${plan.final.usersDeleted}`,
    `  Enrollment records to delete        : ${plan.final.enrollmentsDeleted}`,
    `  Enrollment records to retain        : ${plan.final.enrollmentsKept}`,
    `  Roles changed                       : 0 (roles are never modified)`,
    `  Other references to deleted users   : ${plan.blockingRefs.length}`,
    '',
    `FINAL VALIDATION: ${plan.problems.length ? 'FAIL' : 'PASS'}`,
    ...plan.problems.map((p) => `  ✖ ${p}`),
    '───────────────────────────────────────',
  ];
  logger.info(lines.join('\n'));
};

export const runUserCleanup = async ({ apply = false } = {}) => {
  const connection = mongoose.connection;
  const meta = { apply, nodeEnv: env.nodeEnv, database: connection.db.databaseName, host: connection.host };
  assertNotProduction({ nodeEnv: meta.nodeEnv, databaseName: meta.database, host: meta.host });

  const plan = await planUserCleanup(connection.db);
  printPlan(plan, meta);

  const runId = `cleanup-users-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  const report = { runId, ...meta, plan, result: null, verify: null };

  if (!apply && plan.problems.length) process.exitCode = 1;
  if (apply) {
    report.result = await applyUserCleanup(connection, plan);
    const v = await verifyUserCleanup(connection.db, plan);
    report.verify = v;
    logger.info(
      [
        '',
        '────────── AFTER APPLY (independent re-read) ──────────',
        ...v.finalUsers.map(
          (u, i) =>
            `  ${String(i + 1).padStart(2)}. ${cell(u.name, 24)} ${cell(u.phone, 13)} ${cell(u.roles.join(','), 24)} enrolled=${yes(u.enrollments > 0)} enrollments=${String(
              u.enrollments,
            ).padStart(2)} protected=${yes(u.protected)}`,
        ),
        '',
        `Users               : ${v.total}`,
        `Enrolled users      : ${v.enrolledUsers}`,
        `Non-enrolled users  : ${v.nonEnrolledUsers}`,
        `Enrollment records  : ${v.enrollments}`,
        `Orphaned enrollments: ${v.orphaned}`,
        `Protected users     : ${v.protectedRetained}/${plan.protectedUsers.length}`,
        `Deleted             : ${report.result.deletedUsers} users, ${report.result.deletedEnrollments} enrollment records`,
        `verification        : ${v.problems.length ? 'FAIL' : 'PASS'}`,
        ...v.problems.map((p) => `  ✖ ${p}`),
      ].join('\n'),
    );
    if (v.problems.length) process.exitCode = 1;
  }

  const file = await writeReport(report);
  logger.info(`report: ${file}`);
  return report;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('cleanup-users.js');
if (isEntryPoint) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const unknown = args.filter((a) => !['--apply', '--dry-run'].includes(a));
  if ((apply && args.includes('--dry-run')) || unknown.length) {
    logger.error(`Usage: npm run cleanup:users [-- --dry-run | -- --apply]${unknown.length ? ` (unknown: ${unknown.join(' ')})` : ''}`);
    process.exit(1);
  }
  Promise.resolve()
    .then(() => mongoose.connect(env.mongoUri))
    .then(() => runUserCleanup({ apply }))
    .catch((error) => {
      logger.error(`User cleanup aborted: ${error.message}`);
      for (const p of error.problems ?? []) logger.error(`  ✖ ${p}`);
      process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close().catch(() => {}));
}

export default runUserCleanup;
