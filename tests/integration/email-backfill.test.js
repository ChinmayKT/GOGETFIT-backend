import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import User from '../../src/models/user.model.js';
import { backfillUserEmails } from '../../migration/loaders/user-email.loader.js';
import { clearTestDb, connectTestDb, disconnectTestDb } from '../helpers/test-server.js';

const migratedUser = (legacyUserId, phone, extra = {}) => {
  const { email, ...rest } = extra;
  return {
    phone: { raw: phone, normalized: phone },
    legacy: { source: 'gogetfit', userId: legacyUserId },
    profile: {
      name: 'Existing',
      gender: 'male',
      city: 'Bengaluru',
      // Email lives inside the profile.
      ...(email === undefined ? {} : { email }),
    },
    migration: { runId: 'run-original', migratedAt: new Date(), version: 1 },
    ...rest,
  };
};

before(connectTestDb);
beforeEach(clearTestDb);
after(disconnectTestDb);

test('a valid legacy email is written onto the matching Mongo user', async () => {
  await User.create(migratedUser(1001, '919999999991'));

  const summary = await backfillUserEmails(
    [{ legacyUserId: 1001, rawEmail: 'user@example.com' }],
    { dryRun: false },
  );

  const user = await User.findOne({ 'legacy.userId': 1001 });
  assert.equal(user.profile.email, 'user@example.com');
  assert.equal(summary.toAdd, 1);
  assert.equal(summary.matched, 1);
});

test('whitespace around a legacy email is trimmed before writing', async () => {
  await User.create(migratedUser(1001, '919999999991'));

  await backfillUserEmails(
    [{ legacyUserId: 1001, rawEmail: '   spaced@example.com \t' }],
    { dryRun: false },
  );

  const user = await User.findOne({ 'legacy.userId': 1001 });
  assert.equal(user.profile.email, 'spaced@example.com');
});

test('a null legacy email stores an explicit null', async () => {
  await User.create(migratedUser(1001, '919999999991'));

  const summary = await backfillUserEmails(
    [{ legacyUserId: 1001, rawEmail: null }],
    { dryRun: false },
  );

  const raw = await User.collection.findOne({ 'legacy.userId': 1001 });
  assert.equal(raw.profile.email, null);
  assert.equal(Object.prototype.hasOwnProperty.call(raw.profile, 'email'), true);
  assert.equal(summary.withoutEmail, 1);
});

test('duplicate legacy emails keep both users, with no merge', async () => {
  await User.create(migratedUser(1001, '919999999991'));
  await User.create(migratedUser(1002, '919999999992'));

  await backfillUserEmails(
    [
      { legacyUserId: 1001, rawEmail: 'shared@example.com' },
      { legacyUserId: 1002, rawEmail: 'shared@example.com' },
    ],
    { dryRun: false },
  );

  const first = await User.findOne({ 'legacy.userId': 1001 });
  const second = await User.findOne({ 'legacy.userId': 1002 });

  assert.equal(first.profile.email, 'shared@example.com');
  assert.equal(second.profile.email, 'shared@example.com');
  assert.notEqual(String(first._id), String(second._id));
  assert.equal(await User.countDocuments({}), 2, 'no user was merged away');
});

test('an already-matching email is not rewritten', async () => {
  await User.create(migratedUser(1001, '919999999991', { email: 'user@example.com' }));

  const summary = await backfillUserEmails(
    [{ legacyUserId: 1001, rawEmail: 'user@example.com' }],
    { dryRun: false },
  );

  assert.equal(summary.alreadyMatching, 1);
  assert.equal(summary.toAdd, 0);
  assert.equal(summary.updated, 0);
});

test('a differing existing email is reported and never overwritten', async () => {
  await User.create(migratedUser(1001, '919999999991', { email: 'current@example.com' }));

  const summary = await backfillUserEmails(
    [{ legacyUserId: 1001, rawEmail: 'legacy@example.com' }],
    { dryRun: false },
  );

  const user = await User.findOne({ 'legacy.userId': 1001 });
  assert.equal(user.profile.email, 'current@example.com', 'the existing value survives');
  assert.equal(summary.conflicts.length, 1);
  assert.equal(summary.conflicts[0].legacyUserId, 1001);
  assert.equal(summary.toAdd, 0);
});

test('an empty legacy email never erases an email the app already holds', async () => {
  await User.create(migratedUser(1001, '919999999991', { email: 'kept@example.com' }));

  const summary = await backfillUserEmails(
    [{ legacyUserId: 1001, rawEmail: '   ' }],
    { dryRun: false },
  );

  const user = await User.findOne({ 'legacy.userId': 1001 });
  assert.equal(user.profile.email, 'kept@example.com');
  assert.equal(summary.conflicts.length, 1);
});

test('a legacy user with no Mongo record is reported, never created', async () => {
  const summary = await backfillUserEmails(
    [{ legacyUserId: 4242, rawEmail: 'ghost@example.com' }],
    { dryRun: false },
  );

  assert.deepEqual(summary.missingMongoUser, [4242]);
  assert.equal(summary.matched, 0);
  assert.equal(await User.countDocuments({}), 0, 'the backfill creates no users');
});

test('a dry run writes nothing but reports what would change', async () => {
  await User.create(migratedUser(1001, '919999999991'));

  const summary = await backfillUserEmails(
    [{ legacyUserId: 1001, rawEmail: 'user@example.com' }],
    { dryRun: true },
  );

  const raw = await User.collection.findOne({ 'legacy.userId': 1001 });
  // Newly created documents carry the schema default; the dry run leaves it be.
  assert.equal(raw.profile.email, null);
  assert.equal(summary.toAdd, 1);
  assert.equal(summary.updated, 0);
});

test('running the backfill twice is idempotent', async () => {
  await User.create(migratedUser(1001, '919999999991'));
  const entries = [{ legacyUserId: 1001, rawEmail: 'user@example.com' }];

  const first = await backfillUserEmails(entries, { dryRun: false });
  const second = await backfillUserEmails(entries, { dryRun: false });

  assert.equal(first.updated, 1);
  assert.equal(second.updated, 0);
  assert.equal(second.alreadyMatching, 1);
  assert.equal(await User.countDocuments({}), 1);
});

test('the backfill touches only the email field', async () => {
  const created = await User.create(migratedUser(1001, '919999999991'));
  const before = await User.collection.findOne({ 'legacy.userId': 1001 });

  await backfillUserEmails(
    [{ legacyUserId: 1001, rawEmail: 'user@example.com' }],
    { dryRun: false },
  );

  const after = await User.collection.findOne({ 'legacy.userId': 1001 });

  assert.equal(String(after._id), String(created._id), 'the Mongo _id is unchanged');
  assert.deepEqual(after.phone, before.phone);
  assert.deepEqual(after.legacy, before.legacy);
  assert.equal(after.profile.name, before.profile.name);
  assert.equal(after.profile.gender, before.profile.gender);
  assert.equal(after.profile.city, before.profile.city);
  assert.equal(after.profileCompleted, before.profileCompleted);
  assert.deepEqual(after.roles, before.roles);
  assert.equal(after.status, before.status);
  assert.deepEqual(after.migration, before.migration);
  assert.equal(after.createdAt.getTime(), before.createdAt.getTime());
});

test('no authentication field is introduced by the backfill', async () => {
  await User.create(migratedUser(1001, '919999999991'));
  await backfillUserEmails(
    [{ legacyUserId: 1001, rawEmail: 'user@example.com' }],
    { dryRun: false },
  );

  const raw = await User.collection.findOne({ 'legacy.userId': 1001 });
  const serialized = JSON.stringify(raw);

  for (const forbidden of ['password', 'login_token', 'otp', 'otp_expiry']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('email is not unique - two users may share one address', async () => {
  await User.create(migratedUser(1001, '919999999991', { email: 'shared@example.com' }));
  await User.create(migratedUser(1002, '919999999992', { email: 'shared@example.com' }));

  assert.equal(await User.countDocuments({ 'profile.email': 'shared@example.com' }), 2);

  const indexes = await User.collection.indexes();
  const emailIndexes = indexes.filter(
    (index) => 'email' in (index.key || {}) || 'profile.email' in (index.key || {}),
  );
  assert.equal(emailIndexes.length, 0, 'no index is created on email');
});

test('a document predating the email field gets an explicit null', async () => {
  const created = await User.create(migratedUser(1001, '919999999991'));
  // Reproduce the 434 already-migrated users, written before `email` existed.
  await User.collection.updateOne({ _id: created._id }, { $unset: { 'profile.email': '' } });

  const before = await User.collection.findOne({ _id: created._id });
  assert.equal(Object.prototype.hasOwnProperty.call(before.profile, 'email'), false);

  const summary = await backfillUserEmails(
    [{ legacyUserId: 1001, rawEmail: null }],
    { dryRun: false },
  );

  const after = await User.collection.findOne({ _id: created._id });
  assert.equal(Object.prototype.hasOwnProperty.call(after.profile, 'email'), true);
  assert.equal(after.profile.email, null);
  assert.equal(summary.nullsWritten, 1);
});
