import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import User from '../../src/models/user.model.js';
import { backfillEmailVerified } from '../../migration/loaders/email-verified.loader.js';
import { clearTestDb, connectTestDb, disconnectTestDb } from '../helpers/test-server.js';

const migrated = (legacyUserId, phone, email) => ({
  phone: { raw: phone, normalized: phone },
  legacy: { source: 'gogetfit', userId: legacyUserId },
  profile: { name: 'Existing', gender: 'male', city: 'Bengaluru', email },
  migration: { runId: 'run-original', migratedAt: new Date(), version: 1 },
});

before(connectTestDb);
beforeEach(clearTestDb);
after(disconnectTestDb);

test('a migrated user with an email is marked verified', async () => {
  await User.create(migrated(1001, '919999999991', 'user@example.com'));

  const summary = await backfillEmailVerified({ dryRun: false });
  const user = await User.findOne({ 'legacy.userId': 1001 });

  assert.equal(user.profile.isEmailVerified, true);
  assert.equal(user.profile.email, 'user@example.com', 'the address itself is untouched');
  assert.equal(summary.updated, 1);
});

test('a malformed legacy email is trusted as-is and never corrected', async () => {
  // The real legacy row for user 441: no @, and a .cim typo.
  await User.create(migrated(441, '919901644608', 'chinnuchinmay756gmail.cim'));

  await backfillEmailVerified({ dryRun: false });
  const user = await User.findOne({ 'legacy.userId': 441 });

  assert.equal(user.profile.email, 'chinnuchinmay756gmail.cim');
  assert.equal(user.profile.isEmailVerified, true);
});

test('a legacy user without an email is left unverified', async () => {
  await User.create(migrated(1002, '919999999992', null));

  const summary = await backfillEmailVerified({ dryRun: false });
  const user = await User.findOne({ 'legacy.userId': 1002 });

  assert.equal(user.profile.isEmailVerified, false);
  assert.equal(user.profile.email, null);
  assert.equal(summary.legacyWithoutEmail, 1);
});

test('an empty-string email is never presented as verified', async () => {
  await User.create(migrated(1003, '919999999993', ''));

  await backfillEmailVerified({ dryRun: false });
  const user = await User.findOne({ 'legacy.userId': 1003 });

  assert.equal(user.profile.isEmailVerified, false);
});

test('a new user with no legacy mapping stays email-less and unverified', async () => {
  await User.create({ phone: { raw: '9000000001', normalized: '919000000001' } });

  const summary = await backfillEmailVerified({ dryRun: false });
  const user = await User.findOne({ 'phone.normalized': '919000000001' });

  assert.equal(user.profile.email, null);
  assert.equal(user.profile.isEmailVerified, false);
  assert.equal(summary.nativeUsers, 1);
  assert.equal(summary.matched, 0);
});

test('a dry run reports the work without writing', async () => {
  await User.create(migrated(1001, '919999999991', 'user@example.com'));

  const summary = await backfillEmailVerified({ dryRun: true });
  const user = await User.findOne({ 'legacy.userId': 1001 });

  assert.equal(summary.toVerify, 1);
  assert.equal(summary.updated, 0);
  assert.equal(user.profile.isEmailVerified, false, 'nothing was written');
});

test('running the backfill twice is idempotent', async () => {
  await User.create(migrated(1001, '919999999991', 'user@example.com'));

  const first = await backfillEmailVerified({ dryRun: false });
  const second = await backfillEmailVerified({ dryRun: false });

  assert.equal(first.updated, 1);
  assert.equal(second.updated, 0);
  assert.equal(second.alreadyVerified, 1);
  assert.equal(second.toVerify, 0);
});

test('the backfill touches only profile.isEmailVerified', async () => {
  const created = await User.create(migrated(1001, '919999999991', 'user@example.com'));
  const before = await User.collection.findOne({ _id: created._id });

  await backfillEmailVerified({ dryRun: false });
  const after = await User.collection.findOne({ _id: created._id });

  assert.equal(String(after._id), String(before._id));
  assert.deepEqual(after.phone, before.phone);
  assert.deepEqual(after.legacy, before.legacy);
  
  assert.deepEqual(after.migration, before.migration);
  assert.equal(after.profile.email, before.profile.email);
  assert.equal(after.createdAt.getTime(), before.createdAt.getTime());
  assert.equal(after.profile.isEmailVerified, true);
});
