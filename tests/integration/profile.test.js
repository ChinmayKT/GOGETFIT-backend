import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import User from '../../src/models/user.model.js';
import { calculateAge } from '../../src/utils/age.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  login,
  startTestServer,
} from '../helpers/test-server.js';

let server;
let token;

const PHONE = '9111111111';
const COMPLETE_PROFILE = {
  name: 'John',
  dateOfBirth: '2001-09-22',
  gender: 'male',
  city: 'Bengaluru',
};

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  ({ token } = await login(server.request, PHONE));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('GET /api/users/me requires a bearer token', async () => {
  const response = await server.request('GET', '/api/users/me');

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
});

test('a rejected token is not accepted', async () => {
  const response = await server.request('GET', '/api/users/me', { token: 'not-a-token' });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'TOKEN_INVALID');
});

test('a new user reads back an incomplete profile', async () => {
  const response = await server.request('GET', '/api/users/me', { token });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.user.profileCompleted, false);
  assert.equal(response.body.data.user.profile.name, null);
});

test('onboarding collects name, date of birth, gender and city', async () => {
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: COMPLETE_PROFILE,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.user.profile, {
    name: 'John',
    dateOfBirth: '2001-09-22',
    age: calculateAge(new Date('2001-09-22T00:00:00Z')),
    gender: 'male',
    city: 'Bengaluru',
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
});

test('profileCompleted becomes true only when every required field is present', async () => {
  const partial = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { name: 'John', gender: 'male' },
  });
  assert.equal(partial.body.data.user.profileCompleted, false);

  const stillPartial = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { city: 'Bengaluru' },
  });
  assert.equal(stillPartial.body.data.user.profileCompleted, false);

  const complete = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { dateOfBirth: '2001-09-22' },
  });
  assert.equal(complete.body.data.user.profileCompleted, true);
});

test('the client cannot set profileCompleted itself', async () => {
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { ...COMPLETE_PROFILE, profileCompleted: true },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /profileCompleted/);
});

test('the client cannot override age', async () => {
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { ...COMPLETE_PROFILE, age: 50 },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /age/);

  await server.request('PATCH', '/api/users/me/profile', { token, body: COMPLETE_PROFILE });
  const me = await server.request('GET', '/api/users/me', { token });

  assert.notEqual(me.body.data.user.profile.age, 50);
  assert.equal(me.body.data.user.profile.age, calculateAge(new Date('2001-09-22T00:00:00Z')));
});

test('a future date of birth is rejected', async () => {
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { dateOfBirth: '2030-01-01' },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /future/);
});

test('a malformed date of birth is rejected', async () => {
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { dateOfBirth: '22-09-2001' },
  });

  assert.equal(response.status, 400);
});

test('an unsupported gender is rejected', async () => {
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { gender: 'other' },
  });

  assert.equal(response.status, 400);
});

test('unknown profile fields are rejected', async () => {
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { name: 'John', email: 'john@example.com' },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /email/);
});

test('GET /me refreshes a stale cached age after a birthday', async () => {
  await server.request('PATCH', '/api/users/me/profile', { token, body: COMPLETE_PROFILE });

  // Simulate a profile written before the user's most recent birthday.
  await User.updateOne({ 'phone.normalized': '919111111111' }, { $set: { 'profile.age': 3 } });

  const response = await server.request('GET', '/api/users/me', { token });
  const expected = calculateAge(new Date('2001-09-22T00:00:00Z'));

  assert.equal(response.body.data.user.profile.age, expected, 'the response shows the current age');

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.age, expected, 'the cached age is written back');
});

test('date of birth survives a round trip without a timezone shift', async () => {
  await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { dateOfBirth: '2001-01-01' },
  });

  const response = await server.request('GET', '/api/users/me', { token });
  assert.equal(response.body.data.user.profile.dateOfBirth, '2001-01-01');

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.dateOfBirth.toISOString(), '2001-01-01T00:00:00.000Z');
});

test('an empty patch is rejected', async () => {
  const response = await server.request('PATCH', '/api/users/me/profile', { token, body: {} });
  assert.equal(response.status, 400);
});

test('an unknown route returns a JSON 404', async () => {
  const response = await server.request('GET', '/api/nope');

  assert.equal(response.status, 404);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error.code, 'NOT_FOUND');
});

test('malformed JSON reaches the centralized error handler as JSON', async () => {
  const response = await fetch(`${server.baseUrl}/api/auth/request-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad',
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(JSON.stringify(body).includes('node_modules'), false, 'no stack trace is exposed');
});

test('GET /me includes profile.email, null for an account that has none', async () => {
  const response = await server.request('GET', '/api/users/me', { token });
  const profile = response.body.data.user.profile;

  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'email'), true);
  assert.equal(profile.email, null);
});

test('GET /me returns the backfilled email of a migrated user', async () => {
  await User.updateOne(
    { 'phone.normalized': '919111111111' },
    { $set: { 'profile.email': 'migrated@example.com' } },
  );

  const response = await server.request('GET', '/api/users/me', { token });
  assert.equal(response.body.data.user.profile.email, 'migrated@example.com');
});

test('the user payload exposes no credential or legacy auth field', async () => {
  await User.updateOne(
    { 'phone.normalized': '919111111111' },
    {
      $set: {
        'profile.email': 'migrated@example.com',
        legacy: { source: 'gogetfit', userId: 999 },
      },
    },
  );

  const response = await server.request('GET', '/api/users/me', { token });
  const serialized = JSON.stringify(response.body);

  for (const forbidden of ['password', 'login_token', 'otp', 'otp_expiry', 'codeHash']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked`);
  }
  // Legacy identity stays server-side.
  assert.equal(serialized.includes('legacy'), false);
  assert.equal(serialized.includes('999'), false);
});

test('a profile patch cannot set email - the backfill owns it', async () => {
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { name: 'John', email: 'attacker@example.com' },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /email/);
});

test('GET /me reports the email fields inside profile, never at the root', async () => {
  const response = await server.request('GET', '/api/users/me', { token });
  const user = response.body.data.user;

  assert.equal(Object.prototype.hasOwnProperty.call(user.profile, 'email'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(user.profile, 'isEmailVerified'), true);
  assert.equal(user.profile.email, null);
  assert.equal(user.profile.isEmailVerified, false);

  // The old root-level fields are gone from the payload.
  assert.equal(Object.prototype.hasOwnProperty.call(user, 'email'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(user, 'isVerified'), false);
});

test('GET /me reports a migrated verified email', async () => {
  await User.updateOne(
    { 'phone.normalized': '919111111111' },
    { $set: { 'profile.email': 'migrated@example.com', 'profile.isEmailVerified': true } },
  );

  const response = await server.request('GET', '/api/users/me', { token });

  assert.equal(response.body.data.user.profile.email, 'migrated@example.com');
  assert.equal(response.body.data.user.profile.isEmailVerified, true);
  // The response wrapper is unchanged.
  assert.equal(response.body.success, true);
  assert.equal(Object.keys(response.body.data).join(','), 'user');
});

test('a verified email cannot be changed through the profile API', async () => {
  await User.updateOne(
    { 'phone.normalized': '919111111111' },
    { $set: { 'profile.email': 'migrated@example.com', 'profile.isEmailVerified': true } },
  );

  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { email: 'attacker@example.com' },
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'EMAIL_ALREADY_VERIFIED');

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.email, 'migrated@example.com', 'the address is untouched');
});

test('a verified email survives an otherwise valid profile patch', async () => {
  await User.updateOne(
    { 'phone.normalized': '919111111111' },
    { $set: { 'profile.email': 'migrated@example.com', 'profile.isEmailVerified': true } },
  );

  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { name: 'Renamed', email: 'attacker@example.com' },
  });

  assert.equal(response.status, 409);

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.email, 'migrated@example.com');
  assert.notEqual(stored.profile.name, 'Renamed', 'nothing was partially applied');
});

test('email is not part of the profile contract even when unverified', async () => {
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { email: 'new@example.com' },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /email/);

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.email, null, 'no email-setting behaviour was added');
});

test('isEmailVerified cannot be set by the client', async () => {
  for (const body of [{ isEmailVerified: true }, { isVerified: true }]) {
    const response = await server.request('PATCH', '/api/users/me/profile', {
      token,
      body,
    });
    assert.equal(response.status, 400);
  }

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.isEmailVerified, false);
});

test('no email verification route was added', async () => {
  for (const path of [
    '/api/auth/request-email-otp',
    '/api/auth/verify-email',
    '/api/users/me/email',
    '/api/users/me/email/verify',
  ]) {
    const response = await server.request('POST', path, { token, body: {} });
    assert.equal(response.status, 404, `${path} should not exist`);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  }
});

test('phone OTP authentication is unchanged by the email work', async () => {
  const requested = await server.request('POST', '/api/auth/request-otp', {
    body: { phone: '9222222222' },
  });
  assert.equal(requested.status, 200);

  const verified = await server.request('POST', '/api/auth/verify-otp', {
    body: { phone: '9222222222', otp: requested.body.data.devOtp },
  });

  assert.equal(verified.status, 201);
  assert.ok(verified.body.data.token);
  // A brand-new account carries no email and is not verified.
  assert.equal(verified.body.data.user.profile.email, null);
  assert.equal(verified.body.data.user.profile.isEmailVerified, false);
});

test('a new account is created with the full profile shape', async () => {
  const requested = await server.request('POST', '/api/auth/request-otp', {
    body: { phone: '9333333333' },
  });
  await server.request('POST', '/api/auth/verify-otp', {
    body: { phone: '9333333333', otp: requested.body.data.devOtp },
  });

  const raw = await User.collection.findOne({ 'phone.normalized': '919333333333' });

  assert.equal(raw.profile.email, null);
  assert.equal(raw.profile.isEmailVerified, false);
  // Nothing is written at the root any more.
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'email'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'isVerified'), false);
});
