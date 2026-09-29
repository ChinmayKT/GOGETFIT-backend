import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import User from '../../src/models/user.model.js';
import {
  inspectEmailPlacement,
  moveEmailIntoProfile,
} from '../../migration/loaders/profile-email.loader.js';
import { clearTestDb, connectTestDb, disconnectTestDb } from '../helpers/test-server.js';

/**
 * Inserts a document in the OLD shape, with the email fields at the root.
 * Written through the raw collection because the schema no longer declares
 * them - which is exactly the situation the migration exists for.
 */
const insertOldShape = async ({
  legacyUserId = 1001,
  phone = '919999999991',
  email = 'user@example.com',
  isVerified = true,
  profile = {},
} = {}) => {
  const result = await User.collection.insertOne({
    phone: { raw: phone, normalized: phone },
    legacy: { source: 'gogetfit', userId: legacyUserId },
    email,
    isVerified,
    profile: {
      name: 'Prajwal',
      dateOfBirth: null,
      age: null,
      gender: 'male',
      city: 'Davangere',
      ...profile,
    },
    profileCompleted: false,
    roles: ['user'],
    status: 'active',
    migration: { runId: 'run-original', migratedAt: new Date(), version: 1 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return result.insertedId;
};

before(connectTestDb);
beforeEach(clearTestDb);
after(disconnectTestDb);

test('email and verification move into the profile', async () => {
  const id = await insertOldShape();

  const summary = await moveEmailIntoProfile({ dryRun: false });
  const doc = await User.collection.findOne({ _id: id });

  assert.equal(doc.profile.email, 'user@example.com');
  assert.equal(doc.profile.isEmailVerified, true);
  assert.equal(summary.moved, 1);
});

test('the root fields no longer exist afterwards', async () => {
  const id = await insertOldShape();

  await moveEmailIntoProfile({ dryRun: false });
  const doc = await User.collection.findOne({ _id: id });

  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'email'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'isVerified'), false);
});

test('nothing outside the two email fields is touched', async () => {
  const id = await insertOldShape();
  const before = await User.collection.findOne({ _id: id });

  await moveEmailIntoProfile({ dryRun: false });
  const after = await User.collection.findOne({ _id: id });

  assert.equal(String(after._id), String(before._id));
  assert.deepEqual(after.phone, before.phone);
  assert.deepEqual(after.legacy, before.legacy);
  assert.deepEqual(after.roles, before.roles);
  assert.equal(after.status, before.status);
  assert.deepEqual(after.migration, before.migration);
  assert.equal(after.profile.name, before.profile.name);
  assert.equal(after.profile.dateOfBirth, before.profile.dateOfBirth);
  assert.equal(after.profile.age, before.profile.age);
  assert.equal(after.profile.gender, before.profile.gender);
  assert.equal(after.profile.city, before.profile.city);
  assert.equal(after.createdAt.getTime(), before.createdAt.getTime());
});

test('a malformed legacy address is carried across untouched', async () => {
  const id = await insertOldShape({
    legacyUserId: 441,
    phone: '919901644608',
    email: 'chinnuchinmay756gmail.cim',
  });

  await moveEmailIntoProfile({ dryRun: false });
  const doc = await User.collection.findOne({ _id: id });

  assert.equal(doc.profile.email, 'chinnuchinmay756gmail.cim');
  assert.equal(doc.profile.isEmailVerified, true);
});

test('a null email moves across as null and unverified', async () => {
  const id = await insertOldShape({ email: null, isVerified: false });

  await moveEmailIntoProfile({ dryRun: false });
  const doc = await User.collection.findOne({ _id: id });

  assert.equal(doc.profile.email, null);
  assert.equal(doc.profile.isEmailVerified, false);
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'email'), false);
});

test('the migration is idempotent', async () => {
  await insertOldShape();

  const first = await moveEmailIntoProfile({ dryRun: false });
  const second = await moveEmailIntoProfile({ dryRun: false });

  assert.equal(first.moved, 1);
  assert.equal(second.checked, 0, 'nothing is left carrying root fields');
  assert.equal(second.moved, 0);
});

test('a dry run reports the work and writes nothing', async () => {
  const id = await insertOldShape();

  const summary = await moveEmailIntoProfile({ dryRun: true });
  const doc = await User.collection.findOne({ _id: id });

  assert.equal(summary.moved, 1);
  assert.equal(doc.email, 'user@example.com', 'the root field survives a dry run');
  assert.equal(doc.profile.email, undefined);
});

test('a differing profile email is reported as a conflict, not overwritten', async () => {
  const id = await insertOldShape({
    email: 'root@example.com',
    profile: { email: 'already@example.com' },
  });

  const summary = await moveEmailIntoProfile({ dryRun: false });
  const doc = await User.collection.findOne({ _id: id });

  assert.equal(summary.conflicts.length, 1);
  assert.equal(summary.conflicts[0].rootEmail, 'root@example.com');
  assert.equal(summary.conflicts[0].profileEmail, 'already@example.com');
  assert.equal(doc.profile.email, 'already@example.com', 'the profile value wins untouched');
  assert.equal(doc.email, 'root@example.com', 'the document is left alone entirely');
});

test('a document already in the new shape is left alone', async () => {
  await User.create({
    phone: { raw: '919999999992', normalized: '919999999992' },
    legacy: { source: 'gogetfit', userId: 1002 },
    profile: { name: 'Done', email: 'done@example.com', isEmailVerified: true },
  });

  const summary = await moveEmailIntoProfile({ dryRun: false });

  assert.equal(summary.checked, 0);
  assert.equal(summary.moved, 0);
});

test('the placement report counts the new locations', async () => {
  await insertOldShape({ legacyUserId: 1001, phone: '919999999991' });
  await moveEmailIntoProfile({ dryRun: false });

  const state = await inspectEmailPlacement();

  assert.equal(state.rootEmail, 0);
  assert.equal(state.rootVerified, 0);
  assert.equal(state.profileEmail, 1);
  assert.equal(state.profileVerified, 1);
  assert.equal(state.migratedWithEmail, 1);
  assert.equal(state.migratedUnverified, 0);
  assert.equal(state.verifiedWithoutEmail, 0);
});
