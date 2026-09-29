import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

import Otp from '../../src/models/otp.model.js';
import User from '../../src/models/user.model.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  login,
  startTestServer,
} from '../helpers/test-server.js';

let server;

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(clearTestDb);

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('an unknown phone is challenged but no user is created yet', async () => {
  const response = await server.request('POST', '/api/auth/request-otp', {
    body: { phone: '9111111111' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.isNewUser, true);
  assert.equal(await User.countDocuments({}), 0, 'no user may exist before verification');
});

test('a new user is created only after successful verification', async () => {
  const { verified } = await login(server.request, '9111111111');

  assert.equal(verified.status, 201);
  assert.equal(verified.body.data.isNewUser, true);
  assert.equal(await User.countDocuments({}), 1);

  const user = await User.findOne({});
  assert.equal(user.phone.normalized, '919111111111');
  assert.equal(user.legacy, undefined, 'a new user must not get an invented legacy mapping');
  assert.equal(user.profileCompleted, false);
  assert.deepEqual(user.roles, ['user']);
  assert.equal(user.status, 'active');
});

test('a new user starts with an empty profile and lands on onboarding', async () => {
  const { verified } = await login(server.request, '9111111111');

  assert.deepEqual(verified.body.data.user.profile, {
    name: null,
    dateOfBirth: null,
    age: null,
    gender: null,
    city: null,
    email: null,
    isEmailVerified: false,
    profilePicture: null,
    freeDietPlanId: null,
    fitnessProfile: {
      height: null,
      weight: null,
      bodyFatPercentage: null,
      activityLevel: null,
      foodType: null,
      goal: null,
      bmr: null,
      tdee: null,
    },
  });
  assert.equal(verified.body.data.user.profileCompleted, false);
});

test('a migrated user logs in by phone and keeps their legacy mapping', async () => {
  const created = await User.create({
    phone: { raw: '919999999999', normalized: '919999999999' },
    legacy: { source: 'gogetfit', userId: 1234 },
    profile: {
      name: 'Migrated User',
      dateOfBirth: new Date('1990-05-10T00:00:00Z'),
      age: 36,
      gender: 'male',
      city: 'Bengaluru',
    },
    profileCompleted: true,
    migration: { runId: 'run-test', migratedAt: new Date(), version: 1 },
  });

  const { verified } = await login(server.request, '+91 99999-99999');

  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.isNewUser, false);
  assert.equal(verified.body.data.user.id, String(created._id));
  assert.equal(verified.body.data.user.profileCompleted, true);
  assert.equal(await User.countDocuments({}), 1, 'login must not duplicate the migrated user');

  const reloaded = await User.findById(created._id);
  assert.equal(reloaded.legacy.userId, 1234);
});

test('the JWT subject is the Mongo _id, never the legacy user id', async () => {
  const created = await User.create({
    phone: { raw: '919999999999', normalized: '919999999999' },
    legacy: { source: 'gogetfit', userId: 1234 },
  });

  const { token } = await login(server.request, '919999999999');
  const payload = jwt.decode(token);

  assert.equal(payload.sub, String(created._id));
  assert.equal(payload.type, 'user');
  assert.notEqual(payload.sub, '1234');
});

test('the OTP is never stored in plaintext', async () => {
  const requested = await server.request('POST', '/api/auth/request-otp', {
    body: { phone: '9111111111' },
  });
  const code = requested.body.data.devOtp;

  const record = await Otp.findOne({ phoneNormalized: '919111111111' });

  assert.match(code, /^\d{4}$/);
  assert.equal(record.codeHash.includes(code), false);
  assert.equal(record.codeHash.length, 64);
  assert.equal(JSON.stringify(record.toObject()).includes(`"${code}"`), false);
});

test('an OTP cannot be used twice', async () => {
  const requested = await server.request('POST', '/api/auth/request-otp', {
    body: { phone: '9111111111' },
  });
  const otp = requested.body.data.devOtp;

  const first = await server.request('POST', '/api/auth/verify-otp', {
    body: { phone: '9111111111', otp },
  });
  const second = await server.request('POST', '/api/auth/verify-otp', {
    body: { phone: '9111111111', otp },
  });

  assert.equal(first.status, 201);
  assert.equal(second.status, 400);
  assert.equal(second.body.error.code, 'OTP_NOT_FOUND');
});

test('an expired OTP is refused', async () => {
  const requested = await server.request('POST', '/api/auth/request-otp', {
    body: { phone: '9111111111' },
  });
  const otp = requested.body.data.devOtp;

  await Otp.updateOne(
    { phoneNormalized: '919111111111' },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );

  const response = await server.request('POST', '/api/auth/verify-otp', {
    body: { phone: '9111111111', otp },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'OTP_EXPIRED');
  assert.equal(await User.countDocuments({}), 0);
});

test('a wrong OTP is refused and creates no user', async () => {
  const requested = await server.request('POST', '/api/auth/request-otp', {
    body: { phone: '9111111111' },
  });
  const wrong = String((Number(requested.body.data.devOtp) % 9000) + 1000).padStart(4, '0');

  const response = await server.request('POST', '/api/auth/verify-otp', {
    body: { phone: '9111111111', otp: wrong },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'OTP_INVALID');
  assert.equal(await User.countDocuments({}), 0);
});

test('requesting a new OTP invalidates the previous one', async () => {
  const first = await server.request('POST', '/api/auth/request-otp', {
    body: { phone: '9111111111' },
  });
  await server.request('POST', '/api/auth/request-otp', { body: { phone: '9111111111' } });

  const response = await server.request('POST', '/api/auth/verify-otp', {
    body: { phone: '9111111111', otp: first.body.data.devOtp },
  });

  assert.equal(response.status, 400);
});

test('a duplicate normalized phone is impossible at the database level', async () => {
  await User.create({ phone: { raw: '9999999999', normalized: '919999999999' } });

  await assert.rejects(
    () => User.create({ phone: { raw: '+919999999999', normalized: '919999999999' } }),
    (error) => error.code === 11000,
  );
});

test('the same legacy account cannot be migrated twice', async () => {
  await User.create({
    phone: { raw: '9111111111', normalized: '919111111111' },
    legacy: { source: 'gogetfit', userId: 555 },
  });

  await assert.rejects(
    () =>
      User.create({
        phone: { raw: '9222222222', normalized: '919222222222' },
        legacy: { source: 'gogetfit', userId: 555 },
      }),
    (error) => error.code === 11000,
  );
});

test('users without legacy metadata coexist under the partial unique index', async () => {
  await User.create({ phone: { raw: '9111111111', normalized: '919111111111' } });
  await User.create({ phone: { raw: '9222222222', normalized: '919222222222' } });

  assert.equal(await User.countDocuments({ legacy: { $exists: false } }), 2);
});

test('an invalid phone is rejected before any OTP is issued', async () => {
  const response = await server.request('POST', '/api/auth/request-otp', { body: { phone: '123' } });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_PHONE');
  assert.equal(await Otp.countDocuments({}), 0);
});

test('both unique indexes exist on the users collection', async () => {
  const indexes = await mongoose.connection.collection('users').indexes();
  const byName = Object.fromEntries(indexes.map((index) => [index.name, index]));

  assert.equal(byName.uniq_phone_normalized.unique, true);
  assert.equal(byName.uniq_legacy_source_userid.unique, true);
  assert.deepEqual(byName.uniq_legacy_source_userid.partialFilterExpression, {
    'legacy.userId': { $exists: true, $type: 'number' },
  });
});
