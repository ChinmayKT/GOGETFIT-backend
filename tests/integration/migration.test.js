import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import User from '../../src/models/user.model.js';
import MigrationConflict, {
  CONFLICT_STATUS,
  CONFLICT_TYPES,
  RESOLUTION_STRATEGIES,
} from '../../src/models/migration-conflict.model.js';
import { legacyRow } from '../helpers/legacy-rows.js';
import { transformLegacyUser } from '../../migration/transformers/user.transformer.js';
import { detectConflicts, persistConflicts } from '../../migration/identity/conflict-detector.js';
import { applyResolution, resolveConflict } from '../../migration/identity/conflict-resolver.js';
import { loadUsers } from '../../migration/loaders/user.loader.js';
import { buildLegacyIdMap, mapChildRecords } from '../../migration/identity/legacy-id-map.js';
import { partitionAgainstExisting } from '../../migration/identity/existing-identity-check.js';
import { validateMigration } from '../../migration/scripts/validate-migration.js';
import { clearTestDb, connectTestDb, disconnectTestDb } from '../helpers/test-server.js';

const NOW = new Date('2026-09-22T00:00:00Z');
const RUN_ID = 'run-integration-test';

const transform = (rows) => rows.map((row) => transformLegacyUser(row, { now: NOW }));

before(connectTestDb);
beforeEach(clearTestDb);
after(disconnectTestDb);

test('a unique legacy phone loads as a Mongo user with its legacy mapping', async () => {
  const { migratable } = detectConflicts(
    transform([legacyRow({ user_id: 1001, phone_number: '919999999999' })]),
  );

  const summary = await loadUsers(migratable, { runId: RUN_ID, now: NOW });
  assert.equal(summary.inserted, 1);

  const user = await User.findOne({ 'legacy.userId': 1001 });
  assert.ok(user._id, 'the Mongo _id is the new application identity');
  assert.notEqual(String(user._id), '1001');
  assert.equal(user.legacy.source, 'gogetfit');
  assert.equal(user.legacy.userId, 1001);
  assert.equal(user.phone.normalized, '919999999999');
  assert.equal(user.migration.runId, RUN_ID);
  assert.equal(user.migration.version, 1);
  assert.ok(user.migration.migratedAt);
});

test('no legacy credential field is present on a loaded user', async () => {
  const { migratable } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999', password: 'hunter2', login_token: 'tok' }),
    ]),
  );
  await loadUsers(migratable, { runId: RUN_ID, now: NOW });

  const raw = await User.collection.findOne({ 'legacy.userId': 1001 });
  const serialized = JSON.stringify(raw);

  for (const forbidden of ['password', 'login_token', 'otp', 'hunter2', 'tok']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('duplicate legacy phones create a pending conflict and load nobody', async () => {
  const { migratable, conflicts } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999' }),
      legacyRow({ user_id: 1002, phone_number: '919999999999' }),
    ]),
  );

  await persistConflicts(RUN_ID, conflicts);
  const summary = await loadUsers(migratable, { runId: RUN_ID, now: NOW });

  assert.equal(summary.inserted, 0);
  assert.equal(await User.countDocuments({}), 0);

  const stored = await MigrationConflict.findOne({ type: CONFLICT_TYPES.DUPLICATE_LEGACY_PHONE });
  assert.equal(stored.status, CONFLICT_STATUS.PENDING);
  assert.equal(stored.resolution, null);
  assert.deepEqual(stored.legacyUserIds, [1001, 1002]);
});

test('persisting the same conflict twice is idempotent', async () => {
  const { conflicts } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999' }),
      legacyRow({ user_id: 1002, phone_number: '919999999999' }),
    ]),
  );

  const first = await persistConflicts(RUN_ID, conflicts);
  const second = await persistConflicts(RUN_ID, conflicts);

  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(await MigrationConflict.countDocuments({}), 1);
});

test('a resolved conflict admits only the chosen legacy account', async () => {
  const rows = transform([
    legacyRow({ user_id: 1001, phone_number: '919999999999' }),
    legacyRow({ user_id: 1002, phone_number: '919999999999' }),
  ]);
  const { conflicts, duplicateGroups } = detectConflicts(rows);
  await persistConflicts(RUN_ID, conflicts);

  const pending = await MigrationConflict.findOne({ type: CONFLICT_TYPES.DUPLICATE_LEGACY_PHONE });
  const resolved = await resolveConflict(pending._id, {
    strategy: RESOLUTION_STRATEGIES.KEEP_ONE,
    keepLegacyUserId: 1002,
    decidedBy: 'integration-test',
  });

  const { admitted } = applyResolution(resolved, duplicateGroups[0].members);
  await loadUsers(admitted, { runId: RUN_ID, now: NOW });

  assert.equal(await User.countDocuments({}), 1);
  assert.ok(await User.findOne({ 'legacy.userId': 1002 }));
  assert.equal(await User.findOne({ 'legacy.userId': 1001 }), null);
});

test('re-running the migration cannot migrate the same legacy user twice', async () => {
  const { migratable } = detectConflicts(
    transform([legacyRow({ user_id: 1001, phone_number: '919999999999' })]),
  );

  const first = await loadUsers(migratable, { runId: RUN_ID, now: NOW });
  const second = await loadUsers(migratable, { runId: 'run-second', now: NOW });

  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(second.skippedAlreadyMigrated, 1);
  assert.equal(await User.countDocuments({}), 1);
});

test('a legacy account cannot claim a phone that already belongs to a new user', async () => {
  await User.create({ phone: { raw: '9999999999', normalized: '919999999999' } });

  const { migratable } = detectConflicts(
    transform([legacyRow({ user_id: 1001, phone_number: '919999999999' })]),
  );
  const summary = await loadUsers(migratable, { runId: RUN_ID, now: NOW });

  assert.equal(summary.inserted, 0);
  assert.equal(summary.skippedDuplicatePhone, 1);
  assert.equal(await User.countDocuments({}), 1);
});

test('a dry run reports what would happen and writes nothing', async () => {
  const { migratable } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999991' }),
      legacyRow({ user_id: 1002, phone_number: '919999999992' }),
    ]),
  );

  const summary = await loadUsers(migratable, { runId: RUN_ID, dryRun: true, now: NOW });

  assert.equal(summary.inserted, 2);
  assert.equal(await User.countDocuments({}), 0, 'a dry run must not write');
});

test('a dry run notices identities that already exist', async () => {
  const { migratable } = detectConflicts(
    transform([legacyRow({ user_id: 1001, phone_number: '919999999999' })]),
  );
  await loadUsers(migratable, { runId: RUN_ID, now: NOW });

  const summary = await loadUsers(migratable, { runId: 'run-dry', dryRun: true, now: NOW });

  assert.equal(summary.inserted, 0);
  assert.equal(summary.skippedAlreadyMigrated, 1);
});

test('a migrated user may have an incomplete profile and still be a valid identity', async () => {
  const { migratable } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999', first_name: null, dob: null, city_name: null }),
    ]),
  );
  await loadUsers(migratable, { runId: RUN_ID, now: NOW });

  const user = await User.findOne({ 'legacy.userId': 1001 });

  assert.equal(user.profileCompleted, false, 'migrated does not imply profile complete');
  assert.equal(user.profile.name, null);
  assert.equal(user.profile.dateOfBirth, null);
  assert.equal(user.legacy.userId, 1001, 'migration itself succeeded');
});

test('child records resolve through legacy userId, never through phone', async () => {
  const { migratable } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999991' }),
      legacyRow({ user_id: 1002, phone_number: '919999999992' }),
    ]),
  );
  await loadUsers(migratable, { runId: RUN_ID, now: NOW });

  const payments = [
    { payment_id: 1, user_id: 1001, amount: 500 },
    { payment_id: 2, user_id: 1002, amount: 900 },
    { payment_id: 3, user_id: 9999, amount: 100 },
  ];

  const { resolved, unresolved } = await mapChildRecords(payments);

  const owner1001 = await User.findOne({ 'legacy.userId': 1001 });
  const mapped = resolved.find((entry) => entry.row.payment_id === 1);

  assert.equal(String(mapped.userId), String(owner1001._id));
  assert.equal(resolved.length, 2);
  assert.equal(unresolved.length, 1, 'an unmigrated owner is quarantined, not guessed');
  assert.equal(unresolved[0].legacyUserId, 9999);
});

test('the legacy id map is keyed by legacy userId and returns Mongo ids', async () => {
  const { migratable } = detectConflicts(
    transform([legacyRow({ user_id: 1234, phone_number: '919999999999' })]),
  );
  await loadUsers(migratable, { runId: RUN_ID, now: NOW });

  const map = await buildLegacyIdMap([1234, 4321]);
  const user = await User.findOne({ 'legacy.userId': 1234 });

  assert.equal(map.size, 1);
  assert.equal(String(map.get(1234)), String(user._id));
  assert.equal(map.get(4321), undefined);
});

test('a child record whose owner is stuck in a conflict stays unresolved', async () => {
  const { migratable, conflicts } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999' }),
      legacyRow({ user_id: 1002, phone_number: '919999999999' }),
    ]),
  );
  await persistConflicts(RUN_ID, conflicts);
  await loadUsers(migratable, { runId: RUN_ID, now: NOW });

  const { resolved, unresolved } = await mapChildRecords([{ payment_id: 1, user_id: 1001 }]);

  assert.equal(resolved.length, 0);
  assert.equal(unresolved[0].reason, 'NO_MIGRATED_USER_FOR_LEGACY_USER_ID');
});

test('an already-migrated legacy account is partitioned out before any write', async () => {
  const candidates = detectConflicts(
    transform([legacyRow({ user_id: 1001, phone_number: '919999999999' })]),
  ).migratable;

  await loadUsers(candidates, { runId: RUN_ID, now: NOW });
  const partition = await partitionAgainstExisting(candidates);

  assert.equal(partition.insertable.length, 0);
  assert.equal(partition.alreadyMigrated.length, 1);
  assert.equal(partition.conflicts.length, 0, 'a re-run is not a conflict');
});

test('a phone owned by a different Mongo user becomes a conflict, not a silent skip', async () => {
  const native = await User.create({ phone: { raw: '9999999999', normalized: '919999999999' } });

  const candidates = detectConflicts(
    transform([legacyRow({ user_id: 1001, phone_number: '919999999999' })]),
  ).migratable;

  const partition = await partitionAgainstExisting(candidates);

  assert.equal(partition.insertable.length, 0);
  assert.equal(partition.phoneCollision.length, 1);
  assert.equal(partition.conflicts.length, 1);

  const conflict = partition.conflicts[0];
  assert.equal(conflict.type, CONFLICT_TYPES.PHONE_COLLISION_WITH_EXISTING_USER);
  assert.deepEqual(conflict.legacyUserIds, [1001]);
  assert.equal(conflict.details.existingUserId, String(native._id));
  assert.equal(conflict.details.existingIsNativeUser, true);

  await persistConflicts(RUN_ID, partition.conflicts);
  const stored = await MigrationConflict.findOne({
    type: CONFLICT_TYPES.PHONE_COLLISION_WITH_EXISTING_USER,
  });

  assert.equal(stored.status, CONFLICT_STATUS.PENDING);

  // Neither user is modified.
  const reloaded = await User.findById(native._id);
  assert.equal(reloaded.legacy, undefined);
  assert.equal(await User.countDocuments({}), 1);
});

test('a clean candidate is partitioned as insertable', async () => {
  const candidates = detectConflicts(
    transform([legacyRow({ user_id: 1001, phone_number: '919999999999' })]),
  ).migratable;

  const partition = await partitionAgainstExisting(candidates);

  assert.equal(partition.insertable.length, 1);
  assert.equal(partition.alreadyMigrated.length, 0);
  assert.equal(partition.phoneCollision.length, 0);
});

test('post-apply validation passes for a correctly migrated user', async () => {
  const candidates = detectConflicts(
    transform([legacyRow({ user_id: 1001, phone_number: '919999999999' })]),
  ).migratable;
  await loadUsers(candidates, { runId: RUN_ID, now: NOW });

  const { ok, summary } = await validateMigration({ runId: RUN_ID, now: NOW });

  assert.equal(ok, true);
  assert.equal(summary.migratedUsers, 1);
  assert.equal(summary.checksFailed, 0);
});

test('post-apply validation catches a stale cached age', async () => {
  const candidates = detectConflicts(
    transform([legacyRow({ user_id: 1001, phone_number: '919999999999' })]),
  ).migratable;
  await loadUsers(candidates, { runId: RUN_ID, now: NOW });

  await User.updateOne({ 'legacy.userId': 1001 }, { $set: { 'profile.age': 3 } });

  const { ok, checks } = await validateMigration({ runId: RUN_ID, now: NOW });
  const ageCheck = checks.find((check) => check.name.includes('profile.age'));

  assert.equal(ok, false);
  assert.equal(ageCheck.passed, false);
});

test('a second migration run does not open a second pending conflict', async () => {
  const { conflicts } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999' }),
      legacyRow({ user_id: 1002, phone_number: '919999999999' }),
    ]),
  );

  await persistConflicts('run-one', conflicts);
  const second = await persistConflicts('run-two', conflicts);

  assert.equal(second.created, 0);
  assert.equal(await MigrationConflict.countDocuments({ status: CONFLICT_STATUS.PENDING }), 1);

  const stored = await MigrationConflict.findOne({});
  assert.equal(stored.runId, 'run-one', 'the first run that saw it is preserved');
  assert.equal(stored.lastSeenRunId, 'run-two');
  assert.deepEqual([...stored.seenInRuns].sort(), ['run-one', 'run-two']);
});

test('a decision recorded under one run is honoured by a later run', async () => {
  const rows = transform([
    legacyRow({ user_id: 1001, phone_number: '919999999999' }),
    legacyRow({ user_id: 1002, phone_number: '919999999999' }),
  ]);
  const { conflicts, duplicateGroups } = detectConflicts(rows);

  await persistConflicts('run-one', conflicts);
  const pending = await MigrationConflict.findOne({});
  await resolveConflict(pending._id, {
    strategy: RESOLUTION_STRATEGIES.KEEP_ONE,
    keepLegacyUserId: 1001,
    decidedBy: 'integration-test',
  });

  // A later run re-observes the same conflict and must not reset the decision.
  await persistConflicts('run-two', conflicts);
  const reloaded = await MigrationConflict.findOne({});

  assert.equal(reloaded.status, CONFLICT_STATUS.RESOLVED);
  assert.equal(reloaded.resolution.keepLegacyUserId, 1001);

  const { admitted } = applyResolution(reloaded, duplicateGroups[0].members);
  assert.deepEqual(admitted.map((member) => member.legacyUserId), [1001]);
});
