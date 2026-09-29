import test, { before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import User from '../../src/models/user.model.js';
import Coach from '../../src/models/coach.model.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  startTestServer,
} from '../helpers/test-server.js';

let server;
let adminToken;
let admin;

const seedUser = (overrides = {}) =>
  User.create({
    phone: { raw: overrides.phone ?? '919000000001', normalized: overrides.phone ?? '919000000001' },
    profile: {
      name: overrides.name ?? 'Asha Rao',
      email: overrides.email ?? 'asha@example.com',
      gender: overrides.gender ?? 'female',
      city: overrides.city ?? 'Bengaluru',
    },
    roles: overrides.roles ?? ['user'],
    status: overrides.status ?? 'active',
  });

const tokenFor = (user) =>
  jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const validProfile = (overrides = {}) => ({
  level: 'LEVEL 2',
  specialization: 'Fat loss',
  description: 'Ten years of strength coaching.',
  languages: ['English', 'Kannada'],
  instagram: 'https://instagram.com/asha',
  transformations: 12,
  availableSlots: 8,
  ...overrides,
});

const createCoach = (userId, profile = validProfile(), token = adminToken) =>
  server.request('POST', '/api/admin/coaches', { token, body: { userId: String(userId), profile } });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  admin = await seedUser({ phone: '918000000000', name: 'Admin', email: 'admin@example.com', roles: ['user', 'admin'] });
  adminToken = tokenFor(admin);
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// --- Phone search ------------------------------------------------------------

test('1-2. an admin can find an existing user by phone, in any input format', async () => {
  const user = await seedUser({ phone: '919876543210' });

  for (const typed of ['9876543210', '+91 98765 43210', '09876543210']) {
    const res = await server.request('GET', `/api/admin/users/search?phone=${encodeURIComponent(typed)}`, {
      token: adminToken,
    });
    assert.equal(res.status, 200, typed);
    assert.equal(res.body.data.user.id, String(user._id));
    assert.equal(res.body.data.user.profile.name, 'Asha Rao');
    assert.equal(res.body.data.coach, null);
    // Never a credential-shaped field.
    assert.equal(res.body.data.user.auth, undefined);
  }
});

test('3. an unknown phone returns USER_NOT_FOUND', async () => {
  const res = await server.request('GET', '/api/admin/users/search?phone=9123456789', { token: adminToken });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'USER_NOT_FOUND');
});

test('an unusable phone is a 400, and a missing phone is a validation error', async () => {
  const bad = await server.request('GET', '/api/admin/users/search?phone=12', { token: adminToken });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_PHONE');

  const missing = await server.request('GET', '/api/admin/users/search', { token: adminToken });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'VALIDATION_ERROR');
});

test('search reports an existing coach profile so the portal can offer View/Edit', async () => {
  const user = await seedUser({ phone: '919876543210' });
  const created = await createCoach(user._id);

  const res = await server.request('GET', '/api/admin/users/search?phone=9876543210', { token: adminToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.coach, { id: created.body.data.coach.id, status: 'active' });
});

// --- Authorization -----------------------------------------------------------

test('4. non-admins cannot search, list, create or edit coaches', async () => {
  const member = await seedUser({ phone: '919111111111', roles: ['user', 'client', 'coach'] });
  const token = tokenFor(member);
  const target = await seedUser({ phone: '919222222222' });
  const coach = await createCoach(target._id);
  const coachId = coach.body.data.coach.id;

  const calls = [
    ['GET', '/api/admin/users/search?phone=9222222222'],
    ['GET', '/api/admin/coaches'],
    ['GET', `/api/admin/coaches/${coachId}`],
    ['POST', '/api/admin/coaches', { userId: String(target._id), profile: validProfile() }],
    ['PATCH', `/api/admin/coaches/${coachId}`, { profile: { level: 'LEVEL 5' } }],
  ];

  for (const [method, path, body] of calls) {
    const forbidden = await server.request(method, path, { token, body });
    assert.equal(forbidden.status, 403, `${method} ${path}`);
    const anonymous = await server.request(method, path, { body });
    assert.equal(anonymous.status, 401, `${method} ${path} anonymous`);
  }

  assert.equal((await Coach.findById(coachId).lean()).profile.level, 'LEVEL 2');
});

// --- Create ------------------------------------------------------------------

test('5-7, 11-12, 17. creating a coach links the user, grants the role and saves the profile', async () => {
  const user = await seedUser({ phone: '919876543210' });
  const res = await createCoach(user._id);

  assert.equal(res.status, 201);
  const { coach } = res.body.data;
  assert.equal(coach.userId, String(user._id));
  assert.equal(coach.user.id, String(user._id));
  assert.equal(coach.user.name, 'Asha Rao');
  assert.equal(coach.user.phone, '919876543210');
  assert.equal(coach.status, 'active');
  assert.deepEqual(coach.profile, {
    // Pictures start empty - the user's own avatar is never copied in.
    profilePicture: null,
    coverPicture: null,
    level: 'LEVEL 2',
    specialization: 'Fat loss',
    description: 'Ten years of strength coaching.',
    languages: ['English', 'Kannada'],
    facebook: null,
    instagram: 'https://instagram.com/asha',
    linkedin: null,
    transformations: 12,
    availableSlots: 8,
  });

  // Verified in MongoDB, not just in the response.
  const stored = await Coach.findById(coach.id).lean();
  assert.equal(String(stored.userId), String(user._id));
  assert.equal(String(stored.createdBy), String(admin._id));
  assert.equal(String(stored.updatedBy), String(admin._id));
  // No user data copied onto the coach.
  assert.equal(stored.profile.name, undefined);
  assert.equal(stored.phone, undefined);
  assert.equal(stored.profile.email, undefined);

  const reloaded = await User.findById(user._id).lean();
  assert.deepEqual(reloaded.roles, ['user', 'coach']);
});

test('8. existing roles are preserved - the role is added, never assigned', async () => {
  const client = await seedUser({ phone: '919333333333', roles: ['user', 'client'] });
  await createCoach(client._id);
  assert.deepEqual((await User.findById(client._id).lean()).roles, ['user', 'client', 'coach']);

  const otherAdmin = await seedUser({ phone: '919444444444', roles: ['user', 'admin'] });
  await createCoach(otherAdmin._id);
  assert.deepEqual((await User.findById(otherAdmin._id).lean()).roles, ['user', 'admin', 'coach']);
});

test('9-10. a second coach profile for the same user is rejected', async () => {
  const user = await seedUser({ phone: '919876543210' });
  assert.equal((await createCoach(user._id)).status, 201);

  const again = await createCoach(user._id, validProfile({ level: 'LEVEL 4' }));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'COACH_ALREADY_EXISTS');

  assert.equal(await Coach.countDocuments({ userId: user._id }), 1);
  assert.deepEqual((await User.findById(user._id).lean()).roles, ['user', 'coach']);
});

test('concurrent creates for the same user produce exactly one coach', async () => {
  const user = await seedUser({ phone: '919876543210' });
  const results = await Promise.all([createCoach(user._id), createCoach(user._id), createCoach(user._id)]);

  assert.equal(results.filter((r) => r.status === 201).length, 1);
  for (const r of results.filter((r) => r.status !== 201)) {
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'COACH_ALREADY_EXISTS');
  }
  assert.equal(await Coach.countDocuments({ userId: user._id }), 1);
  assert.deepEqual((await User.findById(user._id).lean()).roles, ['user', 'coach']);
});

test('a user holding the coach role without a profile can be given one (repair path)', async () => {
  const user = await seedUser({ phone: '919876543210', roles: ['user', 'coach'] });
  const res = await createCoach(user._id);

  assert.equal(res.status, 201);
  assert.deepEqual((await User.findById(user._id).lean()).roles, ['user', 'coach']);
});

test('15. an invalid or unknown userId is rejected', async () => {
  const malformed = await createCoach('not-an-id');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');

  const unknown = await createCoach(new mongoose.Types.ObjectId());
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'USER_NOT_FOUND');
  assert.equal(await Coach.countDocuments({}), 0);
});

test('16. missing or invalid coach fields are rejected', async () => {
  const user = await seedUser({ phone: '919876543210' });

  const cases = [
    { profile: { specialization: 'x' }, message: /level is required/ },
    { profile: validProfile({ level: 'LEVEL 9' }), message: /level must be one of/ },
    { profile: validProfile({ availableSlots: -1 }), message: /availableSlots/ },
    { profile: validProfile({ transformations: 1.5 }), message: /transformations/ },
    { profile: validProfile({ instagram: 'javascript:alert(1)' }), message: /instagram/ },
    { profile: validProfile({ description: 'x'.repeat(2001) }), message: /description/ },
    { profile: validProfile({ name: 'Copied' }), message: /Unknown profile field/ },
  ];

  for (const { profile, message } of cases) {
    const res = await server.request('POST', '/api/admin/coaches', {
      token: adminToken,
      body: { userId: String(user._id), profile },
    });
    assert.equal(res.status, 400, JSON.stringify(profile));
    assert.match(res.body.error.message, message);
  }

  const noProfile = await server.request('POST', '/api/admin/coaches', {
    token: adminToken,
    body: { userId: String(user._id) },
  });
  assert.equal(noProfile.status, 400);
  assert.equal(await Coach.countDocuments({}), 0);
  assert.deepEqual((await User.findById(user._id).lean()).roles, ['user']);
});

test('client-supplied audit fields and roles are refused', async () => {
  const user = await seedUser({ phone: '919876543210' });

  for (const extra of [{ createdBy: String(user._id) }, { updatedBy: String(user._id) }, { roles: ['admin'] }]) {
    const res = await server.request('POST', '/api/admin/coaches', {
      token: adminToken,
      body: { userId: String(user._id), profile: validProfile(), ...extra },
    });
    assert.equal(res.status, 400);
  }
  assert.equal(await Coach.countDocuments({}), 0);
});

test('18. a failure after the coach insert rolls back both writes', async () => {
  const user = await seedUser({ phone: '919876543210', roles: ['user', 'client'] });

  const updateOne = mock.method(User, 'updateOne', async () => {
    throw new Error('simulated role-grant failure');
  });
  try {
    const res = await createCoach(user._id);
    assert.equal(res.status, 500);
  } finally {
    updateOne.mock.restore();
  }

  // Neither half survived.
  assert.equal(await Coach.countDocuments({ userId: user._id }), 0);
  assert.deepEqual((await User.findById(user._id).lean()).roles, ['user', 'client']);

  // And the user can still become a coach afterwards.
  assert.equal((await createCoach(user._id)).status, 201);
});

// --- Edit --------------------------------------------------------------------

test('13, 17. editing changes only the supplied fields and records the editor', async () => {
  const user = await seedUser({ phone: '919876543210' });
  const created = (await createCoach(user._id)).body.data.coach;

  const otherAdmin = await seedUser({ phone: '919555555555', roles: ['user', 'admin'] });
  const res = await server.request('PATCH', `/api/admin/coaches/${created.id}`, {
    token: tokenFor(otherAdmin),
    body: { profile: { level: 'LEVEL 4', languages: ['Hindi'] } },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.coach.profile.level, 'LEVEL 4');
  assert.deepEqual(res.body.data.coach.profile.languages, ['Hindi']);
  // Untouched fields survive.
  assert.equal(res.body.data.coach.profile.specialization, 'Fat loss');

  const stored = await Coach.findById(created.id).lean();
  assert.equal(stored.profile.level, 'LEVEL 4');
  assert.equal(String(stored.createdBy), String(admin._id));
  assert.equal(String(stored.updatedBy), String(otherAdmin._id));
});

test('14. userId cannot be changed through edit', async () => {
  const user = await seedUser({ phone: '919876543210' });
  const other = await seedUser({ phone: '919666666666' });
  const created = (await createCoach(user._id)).body.data.coach;

  const res = await server.request('PATCH', `/api/admin/coaches/${created.id}`, {
    token: adminToken,
    body: { userId: String(other._id), profile: { level: 'LEVEL 1' } },
  });
  assert.equal(res.status, 400);

  const stored = await Coach.findById(created.id).lean();
  assert.equal(String(stored.userId), String(user._id));
  assert.equal(stored.profile.level, 'LEVEL 2');
});

test('deactivating a coach keeps the role and leaves User.status alone', async () => {
  const user = await seedUser({ phone: '919876543210' });
  const created = (await createCoach(user._id)).body.data.coach;

  const res = await server.request('PATCH', `/api/admin/coaches/${created.id}`, {
    token: adminToken,
    body: { status: 'inactive' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.coach.status, 'inactive');

  const reloaded = await User.findById(user._id).lean();
  assert.deepEqual(reloaded.roles, ['user', 'coach']);
  assert.equal(reloaded.status, 'active');
});

test('an empty edit, a malformed id and an unknown coach are handled', async () => {
  const user = await seedUser({ phone: '919876543210' });
  const created = (await createCoach(user._id)).body.data.coach;

  const empty = await server.request('PATCH', `/api/admin/coaches/${created.id}`, { token: adminToken, body: {} });
  assert.equal(empty.status, 400);

  const malformed = await server.request('GET', '/api/admin/coaches/nope', { token: adminToken });
  assert.equal(malformed.status, 404);
  assert.equal(malformed.body.error.code, 'COACH_NOT_FOUND');

  const unknown = await server.request('PATCH', `/api/admin/coaches/${new mongoose.Types.ObjectId()}`, {
    token: adminToken,
    body: { status: 'inactive' },
  });
  assert.equal(unknown.status, 404);
});

// --- List / detail -------------------------------------------------------------

test('the list joins user data and searches by name, email, phone and specialization', async () => {
  const asha = await seedUser({ phone: '919876543210', name: 'Asha Rao', email: 'asha@example.com' });
  const vikram = await seedUser({ phone: '919812345678', name: 'Vikram Shah', email: 'vikram@example.com' });
  await createCoach(asha._id, validProfile({ specialization: 'Fat loss' }));
  const second = (await createCoach(vikram._id, validProfile({ specialization: 'Powerlifting' }))).body.data.coach;
  await server.request('PATCH', `/api/admin/coaches/${second.id}`, { token: adminToken, body: { status: 'inactive' } });

  const all = await server.request('GET', '/api/admin/coaches', { token: adminToken });
  assert.equal(all.status, 200);
  assert.equal(all.body.data.pagination.total, 2);
  assert.ok(all.body.data.coaches.every((c) => c.user && c.user.name));

  const names = async (qs) =>
    (await server.request('GET', `/api/admin/coaches?${qs}`, { token: adminToken })).body.data.coaches.map(
      (c) => c.user.name,
    );

  assert.deepEqual(await names('search=vikram'), ['Vikram Shah']);
  assert.deepEqual(await names('search=asha%40example'), ['Asha Rao']);
  assert.deepEqual(await names('search=%2B91%2098765'), ['Asha Rao']);
  assert.deepEqual(await names('search=powerlift'), ['Vikram Shah']);
  assert.deepEqual(await names('status=inactive'), ['Vikram Shah']);
  assert.deepEqual(await names('pageSize=1&page=2&sortKey=createdAt&sortDir=asc'), ['Vikram Shah']);

  const bad = await server.request('GET', '/api/admin/coaches?status=deleted', { token: adminToken });
  assert.equal(bad.status, 400);
});

test('the detail returns the coach with a safe user summary', async () => {
  const user = await seedUser({ phone: '919876543210' });
  await User.updateOne({ _id: user._id }, { $set: { auth: { passwordHash: 'secret-hash' } } });
  const created = (await createCoach(user._id)).body.data.coach;

  const res = await server.request('GET', `/api/admin/coaches/${created.id}`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.coach.user.email, 'asha@example.com');
  assert.doesNotMatch(JSON.stringify(res.body), /secret-hash|passwordHash|auth/);
});
