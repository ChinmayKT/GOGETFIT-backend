import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import {
  CleanupAbort,
  applyUserCleanup,
  assertNotProduction,
  planUserCleanup,
  verifyUserCleanup,
} from '../../migration/scripts/cleanup-users.js';
import { clearTestDb, connectTestDb, disconnectTestDb } from '../helpers/test-server.js';

const PROTECTED = ['8123260930', '9900298489', '9871749771'];
const T = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
const D = (day) => new Date(Date.UTC(2024, 0, day));
let db;

const oid = (n) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
let seq = 0;
const user = (phone, roles, createdAt = T(0)) => {
  seq += 1;
  return {
    _id: oid(seq),
    phone: { raw: phone, normalized: phone.length === 10 ? `91${phone}` : phone },
    profile: { name: `U${phone}` },
    roles,
    createdAt,
    updatedAt: createdAt,
  };
};
const enroll = (userId, enrollDate) => ({ _id: new mongoose.Types.ObjectId(), userId, enrollDate, planId: new mongoose.Types.ObjectId() });

/**
 * 3 protected: P1 (admin, coach, 2 enrollments), P2 and P3 (coaches, not enrolled).
 * 6 enrolled users E0-E5 (E0 has 3 records, E1 2, the rest 1 with different dates).
 * `nonEnrolled` plain users N0.. with increasing createdAt (N-last is newest).
 */
const seed = async ({ nonEnrolled = 8 } = {}) => {
  seq = 0;
  const P1 = user('8123260930', ['user', 'admin', 'coach', 'client']);
  const P2 = user('9900298489', ['user', 'coach']);
  const P3 = user('9871749771', ['user', 'coach']);
  const E = [0, 1, 2, 3, 4, 5].map((i) => user(`90000001${i}0`, ['user', 'client']));
  const N = Array.from({ length: nonEnrolled }, (_, i) => user(`90000003${String(i).padStart(2, '0')}`, ['user'], T(10 + i)));
  await db.collection('users').insertMany([P1, P2, P3, ...E, ...N]);
  const enrollments = [
    enroll(P1._id, D(1)),
    enroll(P1._id, D(2)),
    enroll(E[0]._id, D(1)),
    enroll(E[0]._id, D(2)),
    enroll(E[0]._id, D(3)),
    enroll(E[1]._id, D(1)),
    enroll(E[1]._id, D(9)),
    enroll(E[2]._id, D(5)),
    enroll(E[3]._id, D(20)), // newest single enrollment
    enroll(E[4]._id, D(5)), // ties E2 on count and date; _id ascending decides
    enroll(E[5]._id, D(1)),
  ];
  await db.collection('enrolledclients').insertMany(enrollments);
  await db.collection('coaches').insertMany([
    { userId: P1._id, createdBy: P1._id },
    { userId: P2._id, createdBy: P1._id },
    { userId: P3._id, createdBy: P1._id },
  ]);
  return { P1, P2, P3, E, N, enrollments };
};

const snapshot = async () =>
  JSON.stringify(
    await Promise.all(['users', 'enrolledclients', 'coaches'].map((c) => db.collection(c).find().sort({ _id: 1 }).toArray())),
  );
const ids = (rows) => rows.map((u) => String(u.id ?? u._id));

before(async () => {
  await connectTestDb();
  db = mongoose.connection.db;
});
beforeEach(async () => {
  await clearTestDb();
  // Raw collections the helper does not clear.
  for (const name of ['users', 'enrolledclients', 'coaches']) await db.collection(name).deleteMany({});
});
after(disconnectTestDb);

test('15. refuses anything that looks like production', () => {
  assert.throws(() => assertNotProduction({ nodeEnv: 'production', databaseName: 'gogetfit', host: 'x' }), CleanupAbort);
  assert.throws(() => assertNotProduction({ nodeEnv: 'development', databaseName: 'gogetfit_prod', host: 'x' }), CleanupAbort);
  assert.throws(() => assertNotProduction({ nodeEnv: 'development', databaseName: 'g', host: 'prod-cluster.mongodb.net' }), CleanupAbort);
  assert.doesNotThrow(() => assertNotProduction({ nodeEnv: 'development', databaseName: 'gogetfit', host: 'dev.mongodb.net' }));
});

const plan10 = () => planUserCleanup(db, { target: 10, enrolledTarget: 4, protectedPhones: PROTECTED });

test('1, 2, 4, 5, 8, 9, 11. dry run: exact total, exact enrolled users, protected kept, non-enrolled fill, zero writes', async () => {
  const s = await seed();
  const before = await snapshot();
  const plan = await plan10();
  // 11. Nothing written.
  assert.equal(await snapshot(), before);

  // 4-5. Users are counted, not enrollment documents: 7 enrolled users, 11 records.
  assert.deepEqual(plan.current, { users: 17, enrolledUsers: 7, nonEnrolledUsers: 10, enrollments: 11 });
  assert.equal(plan.protectedUsers.find((p) => p.normalized === '918123260930').enrollments, 2);

  // 2. Exactly 4 enrolled: protected P1 first, then E0 (3 records), E1 (2), E3 (newest single).
  assert.deepEqual(ids(plan.keepEnrolled), ids([s.P1, s.E[0], s.E[1], s.E[3]]));
  // 9. Exactly 6 non-enrolled: protected P2, P3, then the newest non-enrolled users.
  assert.deepEqual(ids(plan.keepNonEnrolled), ids([s.P2, s.P3, s.N[7], s.N[6], s.N[5], s.N[4]]));
  // 1, 8.
  assert.equal(plan.keep.length, 10);
  for (const p of [s.P1, s.P2, s.P3]) assert.ok(ids(plan.keep).includes(String(p._id)));
  assert.deepEqual(plan.final, {
    users: 10,
    enrolled: 4,
    nonEnrolled: 6,
    enrolledLosingEnrollments: 3,
    usersDeleted: 7,
    enrollmentsKept: 8,
    enrollmentsDeleted: 3,
  });
  assert.deepEqual(plan.problems, []);
  // Same data, same plan.
  assert.deepEqual((await plan10()).keep, plan.keep);
});

test('3. enrolled users that are not selected lose their enrollments and can fill the non-enrolled slots', async () => {
  // Like dev today: almost everyone is enrolled, only the two protected coaches are not.
  const s = await seed({ nonEnrolled: 0 });
  const plan = await planUserCleanup(db, { target: 9, enrolledTarget: 4, protectedPhones: PROTECTED });
  assert.deepEqual(ids(plan.keepEnrolled), ids([s.P1, s.E[0], s.E[1], s.E[3]]));
  // P2, P3, then E2, E4, E5 (equal createdAt -> _id ascending), now without enrollments.
  assert.deepEqual(ids(plan.keepNonEnrolled), ids([s.P2, s.P3, s.E[2], s.E[4], s.E[5]]));
  assert.equal(plan.final.usersDeleted, 0);
  assert.equal(plan.final.enrollmentsDeleted, 3);
  assert.deepEqual(plan.problems, []);

  await applyUserCleanup(mongoose.connection, plan);
  assert.equal(await db.collection('users').countDocuments(), 9);
  assert.equal((await db.collection('enrolledclients').distinct('userId')).length, 4);
  // E2 keeps its user document (and roles) but has no enrollment left.
  assert.deepEqual((await db.collection('users').findOne({ _id: s.E[2]._id })).roles, ['user', 'client']);
  assert.equal(await db.collection('enrolledclients').countDocuments({ userId: s.E[2]._id }), 0);
});

test('6, 7, 10, 12, 14. apply: transaction, kept users keep all records, deleted users lose theirs, roles untouched', async () => {
  const s = await seed();
  const rolesBefore = Object.fromEntries((await db.collection('users').find().toArray()).map((u) => [String(u._id), u.roles]));
  const plan = await plan10();
  const result = await applyUserCleanup(mongoose.connection, plan);
  assert.deepEqual(result, { deletedEnrollments: 3, deletedUsers: 7 });

  assert.equal(await db.collection('users').countDocuments(), 10);
  assert.equal((await db.collection('enrolledclients').distinct('userId')).length, 4);
  // 6. All of E0's three records (and P1's two) are still there.
  assert.equal(await db.collection('enrolledclients').countDocuments({ userId: s.E[0]._id }), 3);
  assert.equal(await db.collection('enrolledclients').countDocuments({ userId: s.P1._id }), 2);
  assert.equal(await db.collection('enrolledclients').countDocuments(), 8);
  // 7. Records of users not selected are gone.
  assert.equal(await db.collection('enrolledclients').countDocuments({ userId: { $in: [s.E[2]._id, s.E[4]._id, s.E[5]._id] } }), 0);
  // 10. No role added or removed on any kept user.
  for (const u of await db.collection('users').find().toArray()) assert.deepEqual(u.roles, rolesBefore[String(u._id)]);
  assert.deepEqual((await db.collection('users').findOne({ _id: s.P2._id })).roles, ['user', 'coach']);
  assert.equal(await db.collection('coaches').countDocuments(), 3);

  // 14. No orphans; the independent re-read agrees.
  const v = await verifyUserCleanup(db, plan);
  assert.deepEqual(v.problems, []);
  assert.deepEqual([v.total, v.enrolledUsers, v.nonEnrolledUsers, v.orphaned, v.protectedRetained], [10, 4, 6, 0, 3]);
});

test('12. apply is all-or-nothing: a failure after the first delete rolls everything back', async () => {
  await seed();
  const plan = await plan10();
  const before = await snapshot();
  // Sabotage the expected enrollment count: the enrollment delete runs, then the check throws.
  await assert.rejects(applyUserCleanup(mongoose.connection, { ...plan, final: { ...plan.final, enrollmentsDeleted: 99 } }), /planned 99/);
  assert.equal(await snapshot(), before);
});

test('13. apply aborts with nothing written if users or enrollments changed after the dry run', async () => {
  const s = await seed();
  const plan = await plan10();
  await db.collection('enrolledclients').insertOne(enroll(s.N[0]._id, D(30)));
  const before = await snapshot();
  await assert.rejects(applyUserCleanup(mongoose.connection, plan), /changed since the plan/);
  assert.equal(await snapshot(), before);
});

test('a non-enrollment reference (e.g. a Coach) to a user being deleted fails validation', async () => {
  const s = await seed();
  await db.collection('coaches').insertOne({ userId: s.N[0]._id, createdBy: s.P1._id });
  const plan = await plan10();
  assert.ok(plan.problems.some((p) => p.startsWith('coaches.userId') && p.includes(String(s.N[0]._id))));
  await assert.rejects(applyUserCleanup(mongoose.connection, plan), CleanupAbort);
  assert.equal(await db.collection('users').countDocuments(), 17);
});

test('validation fails on a missing protected user, too few users, or too few enrolled users', async () => {
  await seed();
  await db.collection('users').deleteOne({ 'phone.normalized': '919871749771' });
  const missing = await plan10();
  assert.ok(missing.problems.some((p) => p.includes('919871749771')));

  const tooFewUsers = await planUserCleanup(db, { target: 50, enrolledTarget: 4, protectedPhones: PROTECTED.slice(0, 2) });
  assert.ok(tooFewUsers.problems.some((p) => p.includes('cannot reach 50')));

  const tooFewEnrolled = await planUserCleanup(db, { target: 10, enrolledTarget: 9, protectedPhones: PROTECTED.slice(0, 2) });
  assert.ok(tooFewEnrolled.problems.some((p) => p.includes('need exactly 9')));
  await assert.rejects(applyUserCleanup(mongoose.connection, tooFewEnrolled), CleanupAbort);
});
