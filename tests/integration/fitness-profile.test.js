import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import User from '../../src/models/user.model.js';
import { backfillFitnessProfiles } from '../../migration/loaders/fitness-profile.loader.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  login,
  startTestServer,
} from '../helpers/test-server.js';

const migrated = (legacyUserId, phone, extra = {}) => ({
  phone: { raw: phone, normalized: phone },
  legacy: { source: 'gogetfit', userId: legacyUserId },
  profile: {
    name: 'Prajwal',
    gender: 'male',
    city: 'Davangere',
    email: 'prajwal@gogetfitonline.com',
    isEmailVerified: true,
    ...extra,
  },
  migration: { runId: 'run-original', migratedAt: new Date(), version: 1 },
});

let server;
let token;

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(clearTestDb);

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// --- migration -------------------------------------------------------------

test('legacy height, weight and fat land on the canonical paths', async () => {
  await User.create(migrated(187, '919999999991'));

  await backfillFitnessProfiles(
    [{ legacyUserId: 187, height: 174, weight: 65, fat: 16.923 }],
    { dryRun: false },
  );

  const user = await User.findOne({ 'legacy.userId': 187 });
  const fitness = user.profile.fitnessProfile;

  assert.equal(fitness.height, 174);
  assert.equal(fitness.weight, 65);
  assert.equal(fitness.bodyFatPercentage, 16.92, 'stored to two decimals');
});

test('the three unsourced preferences stay null after migration', async () => {
  await User.create(migrated(187, '919999999991'));

  await backfillFitnessProfiles(
    [{ legacyUserId: 187, height: 174, weight: 65, fat: 16.923 }],
    { dryRun: false },
  );

  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 187 })).profile;

  assert.equal(fitnessProfile.activityLevel, null);
  assert.equal(fitnessProfile.foodType, null);
  assert.equal(fitnessProfile.goal, null);
});

test('NULL legacy measurements stay null, never zero', async () => {
  await User.create(migrated(200, '919999999992'));

  await backfillFitnessProfiles(
    [{ legacyUserId: 200, height: null, weight: null, fat: null }],
    { dryRun: false },
  );

  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 200 })).profile;

  assert.equal(fitnessProfile.height, null);
  assert.equal(fitnessProfile.weight, null);
  assert.equal(fitnessProfile.bodyFatPercentage, null);
  assert.notEqual(fitnessProfile.height, 0);
});

test('a legacy zero is stored as null rather than 0', async () => {
  await User.create(migrated(201, '919999999993'));

  const summary = await backfillFitnessProfiles(
    [{ legacyUserId: 201, height: 0, weight: 0, fat: 0 }],
    { dryRun: false },
  );

  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 201 })).profile;

  assert.equal(fitnessProfile.height, null);
  assert.equal(fitnessProfile.weight, null);
  assert.equal(fitnessProfile.bodyFatPercentage, null);
  assert.deepEqual(summary.zeroTreatedAsMissing, {
    height: 1,
    weight: 1,
    fat: 1,
    bmr: 0,
    tdee: 0,
  });
});

test('a legacy user with no Mongo record is reported, never created', async () => {
  const summary = await backfillFitnessProfiles(
    [{ legacyUserId: 4242, height: 170, weight: 70, fat: 20 }],
    { dryRun: false },
  );

  assert.deepEqual(summary.missingMongoUser, [4242]);
  assert.equal(await User.countDocuments({}), 0);
});

test('the backfill is idempotent', async () => {
  await User.create(migrated(187, '919999999991'));
  const rows = [{ legacyUserId: 187, height: 174, weight: 65, fat: 16.923 }];

  const first = await backfillFitnessProfiles(rows, { dryRun: false });
  const second = await backfillFitnessProfiles(rows, { dryRun: false });

  assert.equal(first.updated, 1);
  assert.equal(second.updated, 0);
  assert.equal(second.alreadyInPlace, 1);
});

test('a dry run writes nothing', async () => {
  await User.create(migrated(187, '919999999991'));

  const summary = await backfillFitnessProfiles(
    [{ legacyUserId: 187, height: 174, weight: 65, fat: 16.923 }],
    { dryRun: true },
  );

  const user = await User.findOne({ 'legacy.userId': 187 });

  assert.equal(summary.toWrite, 1);
  assert.equal(user.profile.fitnessProfile.height, null);
});

test('a value the member already set is never overwritten', async () => {
  await User.create(
    migrated(187, '919999999991', {
      fitnessProfile: { height: 180, weight: 70, activityLevel: 'moderate' },
    }),
  );

  const summary = await backfillFitnessProfiles(
    [{ legacyUserId: 187, height: 174, weight: 65, fat: 16.923 }],
    { dryRun: false },
  );

  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 187 })).profile;

  assert.equal(summary.conflicts.length, 1);
  assert.deepEqual(summary.conflicts[0].fields.sort(), ['height', 'weight']);
  assert.equal(fitnessProfile.height, 180, 'the member value survives');
  assert.equal(fitnessProfile.activityLevel, 'moderate');
});

test('migration leaves email, picture and identity untouched', async () => {
  const created = await User.create(
    migrated(187, '919999999991', { profilePicture: 'https://x/y.jpg' }),
  );
  const before = await User.collection.findOne({ _id: created._id });

  await backfillFitnessProfiles(
    [{ legacyUserId: 187, height: 174, weight: 65, fat: 16.923 }],
    { dryRun: false },
  );
  const after = await User.collection.findOne({ _id: created._id });

  assert.equal(String(after._id), String(before._id));
  assert.deepEqual(after.legacy, before.legacy);
  assert.deepEqual(after.phone, before.phone);
  assert.equal(after.profile.email, before.profile.email);
  assert.equal(after.profile.isEmailVerified, before.profile.isEmailVerified);
  assert.equal(after.profile.profilePicture, before.profile.profilePicture);
  assert.equal(after.profile.name, before.profile.name);
});

test('no body or preferences object is ever created', async () => {
  await User.create(migrated(187, '919999999991'));
  await backfillFitnessProfiles(
    [{ legacyUserId: 187, height: 174, weight: 65, fat: 16.923 }],
    { dryRun: false },
  );

  const raw = await User.collection.findOne({ 'legacy.userId': 187 });

  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'preferences'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'height'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(raw.profile, 'height'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(raw.profile, 'weight'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(raw.profile, 'bodyFatPercentage'), false);
});

// --- API -------------------------------------------------------------------

test('GET /me returns fitnessProfile inside profile', async () => {
  ({ token } = await login(server.request, '9111111111'));

  const response = await server.request('GET', '/api/users/me', { token });
  const profile = response.body.data.user.profile;

  assert.deepEqual(profile.fitnessProfile, {
    height: null,
    weight: null,
    bodyFatPercentage: null,
    activityLevel: null,
    foodType: null,
    goal: null,
    bmr: null,
    tdee: null,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'height'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'bmr'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'tdee'), false);
});

test('all six fields can be saved from Edit Profile', async () => {
  ({ token } = await login(server.request, '9111111111'));

  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: {
      fitnessProfile: {
        height: 171,
        weight: 60.1,
        bodyFatPercentage: 15.9,
        activityLevel: 'moderately_active',
        foodType: 'vegetarian_egg',
        goal: 'fat_loss',
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.user.profile.fitnessProfile, {
    height: 171,
    weight: 60.1,
    bodyFatPercentage: 15.9,
    activityLevel: 'moderately_active',
    foodType: 'vegetarian_egg',
    goal: 'fat_loss',
    // Not editable from Edit Profile; only the migration sets these.
    bmr: null,
    tdee: null,
  });
});

test('a partial update keeps the values already stored', async () => {
  ({ token } = await login(server.request, '9111111111'));

  await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { height: 171, weight: 60.1, bodyFatPercentage: 15.9 } },
  });

  // Exactly the scenario from the brief: a migrated member fills in only the
  // three preferences afterwards.
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: {
      fitnessProfile: {
        activityLevel: 'moderately_active',
        foodType: 'vegetarian_egg',
        goal: 'fat_loss',
      },
    },
  });

  assert.deepEqual(response.body.data.user.profile.fitnessProfile, {
    height: 171,
    weight: 60.1,
    bodyFatPercentage: 15.9,
    activityLevel: 'moderately_active',
    foodType: 'vegetarian_egg',
    goal: 'fat_loss',
    bmr: null,
    tdee: null,
  });
});

test('a single field can be changed on its own', async () => {
  ({ token } = await login(server.request, '9111111111'));

  await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { height: 171, weight: 60.1 } },
  });
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { weight: 62.4 } },
  });

  const fitness = response.body.data.user.profile.fitnessProfile;
  assert.equal(fitness.weight, 62.4);
  assert.equal(fitness.height, 171, 'the untouched field survives');
});

test('an explicit null clears a stored value', async () => {
  ({ token } = await login(server.request, '9111111111'));

  await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { goal: 'fat_loss' } },
  });
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { goal: null } },
  });

  assert.equal(response.body.data.user.profile.fitnessProfile.goal, null);
});

test('a zero or absurd measurement is rejected', async () => {
  ({ token } = await login(server.request, '9111111111'));

  for (const fitnessProfile of [{ height: 0 }, { weight: 0 }, { height: 4000 }, { weight: -5 }]) {
    const response = await server.request('PATCH', '/api/users/me/profile', {
      token,
      body: { fitnessProfile },
    });
    assert.equal(response.status, 400, JSON.stringify(fitnessProfile));
  }

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.fitnessProfile.height, null);
});

test('an unknown fitness field is rejected', async () => {
  ({ token } = await login(server.request, '9111111111'));

  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { bmi: 22 } },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /bmi/);
});

test('fitness values never make profileCompleted depend on them', async () => {
  ({ token } = await login(server.request, '9111111111'));

  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: {
      name: 'John',
      dateOfBirth: '2001-09-22',
      gender: 'male',
      city: 'Bengaluru',
    },
  });

  // Every fitness value is still null, and the profile is complete regardless.
  assert.equal(response.body.data.user.profileCompleted, true);
  assert.equal(response.body.data.user.profile.fitnessProfile.height, null);
});

test('a verified email stays locked while fitness fields are edited', async () => {
  ({ token } = await login(server.request, '9111111111'));
  await User.updateOne(
    { 'phone.normalized': '919111111111' },
    { $set: { 'profile.email': 'migrated@example.com', 'profile.isEmailVerified': true } },
  );

  const saved = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { height: 171 } },
  });
  const blocked = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { email: 'attacker@example.com' },
  });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.user.profile.email, 'migrated@example.com');
  assert.equal(blocked.status, 409);
});

test('phone OTP authentication is unaffected', async () => {
  const requested = await server.request('POST', '/api/auth/request-otp', {
    body: { phone: '9555555555' },
  });
  const verified = await server.request('POST', '/api/auth/verify-otp', {
    body: { phone: '9555555555', otp: requested.body.data.devOtp },
  });

  assert.equal(verified.status, 201);
  assert.equal(verified.body.data.user.profile.fitnessProfile.height, null);
});

test('a body fat percentage is rounded to two decimals when saved', async () => {
  ({ token } = await login(server.request, '9111111111'));

  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { bodyFatPercentage: 17.612980578676176 } },
  });

  assert.equal(response.body.data.user.profile.fitnessProfile.bodyFatPercentage, 17.61);

  // Rounded in the database too, not merely in the response.
  const raw = await User.collection.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(raw.profile.fitnessProfile.bodyFatPercentage, 17.61);
});

test('a value already within two decimals is stored unchanged', async () => {
  ({ token } = await login(server.request, '9111111111'));

  for (const [sent, expected] of [
    [15.9, 15.9],
    [16, 16],
    [15.95, 15.95],
  ]) {
    const response = await server.request('PATCH', '/api/users/me/profile', {
      token,
      body: { fitnessProfile: { bodyFatPercentage: sent } },
    });
    assert.equal(response.body.data.user.profile.fitnessProfile.bodyFatPercentage, expected);
  }
});

test('the migration stores body fat already rounded', async () => {
  await User.create(migrated(300, '919999999994'));

  await backfillFitnessProfiles(
    [{ legacyUserId: 300, height: 174, weight: 65, fat: 17.612980578676176 }],
    { dryRun: false },
  );

  const raw = await User.collection.findOne({ 'legacy.userId': 300 });
  assert.equal(raw.profile.fitnessProfile.bodyFatPercentage, 17.61);
});

test('rounding leaves height and weight precision alone', async () => {
  ({ token } = await login(server.request, '9111111111'));

  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { height: 174.5, weight: 65.375 } },
  });

  const fitness = response.body.data.user.profile.fitnessProfile;
  assert.equal(fitness.height, 174.5);
  assert.equal(fitness.weight, 65.375);
});

// --- energy figures (legacy bmr / tdee -> bmr / tdee) -----------------------

const energyRow = (legacyUserId, bmr, tdee) => ({
  legacyUserId,
  height: 174,
  weight: 65,
  fat: 16.923,
  bmr,
  tdee,
});

test('legacy bmr and tdee land on fitnessProfile.bmr and fitnessProfile.tdee', async () => {
  await User.create(migrated(187, '919999999991'));

  await backfillFitnessProfiles([energyRow(187, 1520, 2356)], { dryRun: false });

  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 187 })).profile;

  assert.equal(fitnessProfile.bmr, 1520);
  assert.equal(fitnessProfile.tdee, 2356, 'legacy tdee keeps its name');
});

test('no root-level bmr or tdee field is ever created, and never rdee', async () => {
  await User.create(migrated(187, '919999999991'));

  await backfillFitnessProfiles([energyRow(187, 1520, 2356)], { dryRun: false });

  const raw = await User.collection.findOne({ 'legacy.userId': 187 });

  for (const field of ['bmr', 'tdee', 'rdee']) {
    assert.equal(Object.prototype.hasOwnProperty.call(raw, field), false, `root ${field}`);
    assert.equal(Object.prototype.hasOwnProperty.call(raw.profile, field), false, `profile ${field}`);
  }
  assert.equal(raw.profile.fitnessProfile.bmr, 1520);
  assert.equal(raw.profile.fitnessProfile.tdee, 2356);
  // The field this system used to call rdee is gone for good.
  assert.equal(
    Object.prototype.hasOwnProperty.call(raw.profile.fitnessProfile, 'rdee'),
    false,
  );
});

test('NULL legacy energy values stay null', async () => {
  await User.create(migrated(200, '919999999992'));

  await backfillFitnessProfiles([energyRow(200, null, null)], { dryRun: false });

  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 200 })).profile;

  assert.equal(fitnessProfile.bmr, null);
  assert.equal(fitnessProfile.tdee, null);
});

test('a legacy energy zero is stored as null and counted as a sentinel', async () => {
  await User.create(migrated(201, '919999999993'));

  const summary = await backfillFitnessProfiles([energyRow(201, 0, 0)], { dryRun: false });

  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 201 })).profile;

  assert.equal(fitnessProfile.bmr, null);
  assert.equal(fitnessProfile.tdee, null);
  assert.equal(summary.zeroTreatedAsMissing.bmr, 1);
  assert.equal(summary.zeroTreatedAsMissing.tdee, 1);
});

test('a negative legacy energy value is stored as null and counted', async () => {
  await User.create(migrated(487, '919999999995'));

  const summary = await backfillFitnessProfiles([energyRow(487, -238, -286)], { dryRun: false });

  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 487 })).profile;

  assert.equal(fitnessProfile.bmr, null);
  assert.equal(fitnessProfile.tdee, null);
  assert.deepEqual(summary.negativeTreatedAsMissing, { bmr: 1, tdee: 1 });
});

test('energy figures are counted in the summary', async () => {
  await User.create(migrated(187, '919999999991'));

  const summary = await backfillFitnessProfiles(
    [energyRow(187, 1520, 2356), energyRow(4243, 0, 0)],
    { dryRun: true },
  );

  assert.equal(summary.withBmr, 1);
  assert.equal(summary.withTdee, 1);
});

test('the energy backfill is idempotent', async () => {
  await User.create(migrated(187, '919999999991'));
  const rows = [energyRow(187, 1520, 2356)];

  const first = await backfillFitnessProfiles(rows, { dryRun: false });
  const second = await backfillFitnessProfiles(rows, { dryRun: false });

  assert.equal(first.updated, 1);
  assert.equal(second.updated, 0);
  assert.equal(second.alreadyInPlace, 1);

  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 187 })).profile;
  assert.equal(fitnessProfile.bmr, 1520);
  assert.equal(fitnessProfile.tdee, 2356);
});

test('a dry run writes no energy figures', async () => {
  await User.create(migrated(187, '919999999991'));

  const summary = await backfillFitnessProfiles([energyRow(187, 1520, 2356)], { dryRun: true });
  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 187 })).profile;

  assert.equal(summary.toWrite, 1);
  assert.equal(fitnessProfile.bmr, null);
  assert.equal(fitnessProfile.tdee, null);
});

test('an energy figure already in Mongo is never overwritten', async () => {
  await User.create(
    migrated(187, '919999999991', { fitnessProfile: { bmr: 1600, tdee: 2400 } }),
  );

  const summary = await backfillFitnessProfiles([energyRow(187, 1520, 2356)], { dryRun: false });
  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 187 })).profile;

  assert.equal(summary.conflicts.length, 1);
  assert.deepEqual(summary.conflicts[0].fields.sort(), ['bmr', 'tdee']);
  assert.equal(fitnessProfile.bmr, 1600, 'the stored value survives');
  assert.equal(fitnessProfile.tdee, 2400);
});

test('an identical energy figure is not rewritten', async () => {
  await User.create(
    migrated(187, '919999999991', {
      fitnessProfile: { height: 174, weight: 65, bodyFatPercentage: 16.92, bmr: 1520, tdee: 2356 },
    }),
  );

  const summary = await backfillFitnessProfiles([energyRow(187, 1520, 2356)], { dryRun: false });

  assert.equal(summary.conflicts.length, 0);
  assert.equal(summary.alreadyInPlace, 1);
  assert.equal(summary.updated, 0);
});

test('the calculated bmr and tdee are persisted from the save flow', async () => {
  ({ token } = await login(server.request, '9111111111'));

  // computeBmr(male, 65kg, 174cm, age 25) = 1617.5 and
  // computeTdee(that, active x1.725) = 2790.1875 - the app's own functions.
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: {
      fitnessProfile: {
        height: 174,
        weight: 65,
        bodyFatPercentage: 17.61,
        activityLevel: 'active',
        foodType: 'nonVegetarian',
        goal: 'maintainPhysique',
        bmr: 1617.5,
        tdee: 2790.1875,
      },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.user.profile.fitnessProfile.bmr, 1617.5);
  assert.equal(response.body.data.user.profile.fitnessProfile.tdee, 2790.1875);

  // Stored at the canonical path, and nowhere else.
  const raw = await User.collection.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(raw.profile.fitnessProfile.bmr, 1617.5);
  assert.equal(raw.profile.fitnessProfile.tdee, 2790.1875);
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'bmr'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(raw.profile, 'bmr'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(raw.profile, 'tdee'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(raw.profile.fitnessProfile, 'rdee'), false);
});

test('GET /me returns the persisted energy figures', async () => {
  ({ token } = await login(server.request, '9111111111'));

  await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { bmr: 1617.5, tdee: 2790.1875 } },
  });
  const response = await server.request('GET', '/api/users/me', { token });
  const { profile } = response.body.data.user;

  assert.equal(profile.fitnessProfile.bmr, 1617.5);
  assert.equal(profile.fitnessProfile.tdee, 2790.1875);
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'bmr'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'tdee'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(profile.fitnessProfile, 'rdee'), false);
});

test('a recalculated figure replaces the stored one', async () => {
  ({ token } = await login(server.request, '9111111111'));

  await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { weight: 65, bmr: 1617.5, tdee: 2790.1875 } },
  });
  // A heavier weight recalculates both figures on the client and saves them.
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { weight: 70, bmr: 1667.5, tdee: 2876.4375 } },
  });

  const { fitnessProfile } = response.body.data.user.profile;
  assert.equal(fitnessProfile.weight, 70);
  assert.equal(fitnessProfile.bmr, 1667.5);
  assert.equal(fitnessProfile.tdee, 2876.4375);
});

test('an explicit null clears an energy figure', async () => {
  ({ token } = await login(server.request, '9111111111'));

  await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { bmr: 1617.5, tdee: 2790.1875 } },
  });
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { fitnessProfile: { bmr: null, tdee: null } },
  });

  assert.equal(response.body.data.user.profile.fitnessProfile.bmr, null);
  assert.equal(response.body.data.user.profile.fitnessProfile.tdee, null);
});

test('a zero or impossible energy figure is rejected', async () => {
  ({ token } = await login(server.request, '9111111111'));

  for (const fitnessProfile of [
    { bmr: 0 },
    { tdee: 0 },
    { bmr: -238 },
    { tdee: -286 },
    { bmr: 99999 },
    { bmr: '1520' },
  ]) {
    const response = await server.request('PATCH', '/api/users/me/profile', {
      token,
      body: { fitnessProfile },
    });
    assert.equal(response.status, 400, JSON.stringify(fitnessProfile));
  }

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.fitnessProfile.bmr, null);
  assert.equal(stored.profile.fitnessProfile.tdee, null);
});

test('null energy figures leave profileCompleted alone', async () => {
  ({ token } = await login(server.request, '9111111111'));

  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: {
      name: 'John',
      dateOfBirth: '2001-09-22',
      gender: 'male',
      city: 'Bengaluru',
    },
  });

  assert.equal(response.body.data.user.profileCompleted, true);
  assert.equal(response.body.data.user.profile.fitnessProfile.bmr, null);
  assert.equal(response.body.data.user.profile.fitnessProfile.tdee, null);
});

test('a new user starts with null energy figures', async () => {
  const { verified } = await login(server.request, '9222222222');
  const { fitnessProfile } = verified.body.data.user.profile;

  assert.equal(fitnessProfile.bmr, null);
  assert.equal(fitnessProfile.tdee, null);
});

test('a body fat conflict does not block the energy figures', async () => {
  // The exact scenario from the brief: Mongo holds a different bodyFat, and the
  // legacy energy figures are still migrated.
  await User.create(
    migrated(187, '919999999991', { fitnessProfile: { bodyFatPercentage: 17.61 } }),
  );

  const summary = await backfillFitnessProfiles(
    [{ legacyUserId: 187, height: 174, weight: 65, fat: 16.923, bmr: 1613, tdee: 1936 }],
    { dryRun: false },
  );

  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 187 })).profile;

  assert.deepEqual(summary.conflicts[0].fields, ['bodyFatPercentage']);
  assert.equal(fitnessProfile.bodyFatPercentage, 17.61, 'the held value is kept');
  assert.equal(fitnessProfile.bmr, 1613, 'the energy figure is still migrated');
  assert.equal(fitnessProfile.tdee, 1936);
  assert.equal(fitnessProfile.height, 174, 'and so are the other gaps');
});

test('a conflicting energy figure is kept while the other one is filled', async () => {
  await User.create(migrated(187, '919999999991', { fitnessProfile: { bmr: 1600 } }));

  const summary = await backfillFitnessProfiles(
    [{ legacyUserId: 187, height: 174, weight: 65, fat: 16.923, bmr: 1613, tdee: 1936 }],
    { dryRun: false },
  );

  const { fitnessProfile } = (await User.findOne({ 'legacy.userId': 187 })).profile;

  assert.deepEqual(summary.conflicts[0].fields, ['bmr']);
  assert.equal(fitnessProfile.bmr, 1600, 'the held bmr survives');
  assert.equal(fitnessProfile.tdee, 1936, 'tdee is still migrated');
});

test('per-field conflict handling stays idempotent', async () => {
  await User.create(
    migrated(187, '919999999991', { fitnessProfile: { bodyFatPercentage: 17.61 } }),
  );
  const rows = [
    { legacyUserId: 187, height: 174, weight: 65, fat: 16.923, bmr: 1613, tdee: 1936 },
  ];

  const first = await backfillFitnessProfiles(rows, { dryRun: false });
  const second = await backfillFitnessProfiles(rows, { dryRun: false });

  assert.equal(first.updated, 1);
  assert.equal(second.updated, 0);
  assert.equal(second.alreadyInPlace, 1);
  assert.equal(second.conflicts.length, 1, 'the conflict is still reported');
});
