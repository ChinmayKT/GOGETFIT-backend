import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import User from '../../src/models/user.model.js';
import Coach from '../../src/models/coach.model.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  startTestServer,
} from '../helpers/test-server.js';

let server;
let memberToken;
let adminToken;

const tokenFor = (user) =>
  jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let phoneSeq = 0;
const seedUser = (overrides = {}) => {
  phoneSeq += 1;
  const phone = `9190000${String(phoneSeq).padStart(5, '0')}`;
  return User.create({
    phone: { raw: phone, normalized: phone },
    profile: {
      name: overrides.name ?? `User ${phoneSeq}`,
      email: overrides.email ?? `u${phoneSeq}@example.com`,
      gender: 'female',
      city: overrides.city ?? 'Kochi',
      profilePicture: overrides.profilePicture ?? null,
    },
    roles: overrides.roles ?? ['user'],
    status: overrides.status ?? 'active',
  });
};

const USER_AVATAR = 'http://example.test/uploads/profile/user-profile.jpg';
const COACH_PICTURE = { url: 'http://example.test/uploads/coaches/x/profile/coach-profile.jpg', storageKey: 'coaches/x/profile/coach-profile.jpg' };
const COACH_COVER = { url: 'http://example.test/uploads/coaches/x/cover/coach-cover.jpg', storageKey: 'coaches/x/cover/coach-cover.jpg' };

/** A coach written the way the admin API writes one. */
const seedCoach = async ({ name, status = 'active', userStatus = 'active', createdAt, pictures = {} } = {}) => {
  const user = await seedUser({ name, roles: ['user', 'coach'], status: userStatus, profilePicture: USER_AVATAR });
  const coach = await Coach.create({
    userId: user._id,
    profile: { level: 'LEVEL 2', specialization: 'Fat loss', description: 'Strength coach.', languages: ['English'], instagram: 'https://instagram.com/c', transformations: 12, availableSlots: 4, ...pictures },
    status,
    ...(createdAt ? { createdAt } : {}),
  });
  return { user, coach };
};

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  memberToken = tokenFor(await seedUser({ roles: ['user'] }));
  adminToken = tokenFor(await seedUser({ roles: ['user', 'admin'] }));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('an authenticated member can list active coaches in the member shape', async () => {
  const { coach } = await seedCoach({ name: 'Asha', pictures: { profilePicture: COACH_PICTURE, coverPicture: COACH_COVER } });

  const res = await server.request('GET', '/api/coaches', { token: memberToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.pagination.total, 1);

  const [row] = res.body.data.coaches;
  assert.equal(row.id, String(coach._id));
  const stored = await User.findById(coach.userId).lean();
  assert.deepEqual(row.user, {
    id: String(coach.userId),
    name: 'Asha',
    gender: 'female',
    city: 'Kochi',
    phone: stored.phone.normalized,
    email: stored.profile.email,
  });
  assert.deepEqual(row.profile.profilePicture, COACH_PICTURE);
  assert.deepEqual(row.profile.coverPicture, COACH_COVER);
  assert.equal(row.profile.level, 'LEVEL 2');
  assert.equal(row.profile.transformations, 12);
  assert.equal(row.profile.availableSlots, 4);
});

test('the member shape carries the coach contact channels but never the user avatar or admin fields', async () => {
  const { coach } = await seedCoach({ pictures: { profilePicture: COACH_PICTURE } });

  const list = await server.request('GET', '/api/coaches', { token: memberToken });
  const detail = await server.request('GET', `/api/coaches/${coach._id}`, { token: memberToken });

  for (const body of [list.body, detail.body]) {
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /user-profile\.jpg/);
    assert.doesNotMatch(text, /"roles"|"createdBy"|"updatedBy"|"status"|"storageKey":null|"auth"|"legacy"/);
  }
});

test('inactive coaches and coaches with inactive accounts are never listed or served', async () => {
  const visible = await seedCoach({ name: 'Visible' });
  const inactive = await seedCoach({ name: 'Inactive coach', status: 'inactive' });
  const blocked = await seedCoach({ name: 'Blocked account', userStatus: 'blocked' });

  const res = await server.request('GET', '/api/coaches', { token: memberToken });
  assert.deepEqual(res.body.data.coaches.map((c) => c.user.name), ['Visible']);
  assert.equal(res.body.data.pagination.total, 1);

  assert.equal((await server.request('GET', `/api/coaches/${visible.coach._id}`, { token: memberToken })).status, 200);
  for (const hidden of [inactive, blocked]) {
    const r = await server.request('GET', `/api/coaches/${hidden.coach._id}`, { token: memberToken });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'COACH_NOT_FOUND');
  }
});

test('the list is paginated server-side, newest first', async () => {
  const base = Date.now();
  for (let i = 0; i < 5; i += 1) {
    await seedCoach({ name: `Coach ${i}`, createdAt: new Date(base + i * 1000) });
  }

  const page1 = await server.request('GET', '/api/coaches?page=1&pageSize=2', { token: memberToken });
  const page3 = await server.request('GET', '/api/coaches?page=3&pageSize=2', { token: memberToken });

  assert.deepEqual(page1.body.data.coaches.map((c) => c.user.name), ['Coach 4', 'Coach 3']);
  assert.deepEqual(page1.body.data.pagination, { page: 1, pageSize: 2, total: 5, totalPages: 3 });
  assert.deepEqual(page3.body.data.coaches.map((c) => c.user.name), ['Coach 0']);

  const bad = await server.request('GET', '/api/coaches?page=0', { token: memberToken });
  assert.equal(bad.status, 400);
});

test('search matches name, city, specialization and language - and never an inactive coach', async () => {
  const asha = await seedCoach({ name: 'Asha Rao' });
  await Coach.updateOne({ _id: asha.coach._id }, { $set: { 'profile.specialization': 'Powerlifting', 'profile.languages': ['Kannada'] } });
  await seedCoach({ name: 'Vikram Shah' });
  await seedCoach({ name: 'Asha Hidden', status: 'inactive' });

  const names = async (q) =>
    (await server.request('GET', `/api/coaches?search=${encodeURIComponent(q)}`, { token: memberToken })).body.data.coaches.map((c) => c.user.name);

  assert.deepEqual(await names('asha'), ['Asha Rao']);
  assert.deepEqual(await names('powerlift'), ['Asha Rao']);
  assert.deepEqual(await names('kannada'), ['Asha Rao']);
  assert.deepEqual((await names('kochi')).sort(), ['Asha Rao', 'Vikram Shah']);
  assert.deepEqual(await names('nobody'), []);
});

test('a coach without pictures reads back with null pictures', async () => {
  const { coach } = await seedCoach();
  const res = await server.request('GET', `/api/coaches/${coach._id}`, { token: memberToken });
  assert.equal(res.body.data.coach.profile.profilePicture, null);
  assert.equal(res.body.data.coach.profile.coverPicture, null);
});

test('coach discovery requires authentication', async () => {
  const { coach } = await seedCoach();
  assert.equal((await server.request('GET', '/api/coaches')).status, 401);
  assert.equal((await server.request('GET', `/api/coaches/${coach._id}`)).status, 401);
});

test('a malformed id is a 404, not a 500', async () => {
  const res = await server.request('GET', '/api/coaches/not-an-id', { token: memberToken });
  assert.equal(res.status, 404);
});

test('members have no write access to coaches - here or on the admin API', async () => {
  const { coach } = await seedCoach();

  for (const [method, path] of [
    ['POST', '/api/coaches'],
    ['PATCH', `/api/coaches/${coach._id}`],
    ['PUT', `/api/coaches/${coach._id}/profile-picture`],
    ['DELETE', `/api/coaches/${coach._id}`],
  ]) {
    const r = await server.request(method, path, { token: memberToken, body: {} });
    assert.equal(r.status, 404, `${method} ${path}`);
  }

  for (const [method, path, body] of [
    ['PATCH', `/api/admin/coaches/${coach._id}`, { status: 'inactive', profile: { level: 'LEVEL 5' } }],
    ['DELETE', `/api/admin/coaches/${coach._id}/profile-picture`],
    ['GET', '/api/admin/coaches'],
  ]) {
    const r = await server.request(method, path, { token: memberToken, body });
    assert.equal(r.status, 403, `${method} ${path}`);
  }

  const stored = await Coach.findById(coach._id).lean();
  assert.equal(stored.status, 'active');
  assert.equal(stored.profile.level, 'LEVEL 2');

  // The admin still can.
  const admin = await server.request('PATCH', `/api/admin/coaches/${coach._id}`, { token: adminToken, body: { status: 'inactive' } });
  assert.equal(admin.status, 200);
});

// ---- GET /api/coaches/me ---------------------------------------------------

test('a coach reads their own record, with their own professional photo', async () => {
  const { user, coach } = await seedCoach({ name: 'Prajwal', pictures: { profilePicture: COACH_PICTURE } });

  const response = await server.request('GET', '/api/coaches/me', { token: tokenFor(user) });

  assert.equal(response.status, 200);
  const body = response.body.data.coach;
  assert.equal(body.id, String(coach._id));
  assert.equal(body.profile.profilePicture.url, COACH_PICTURE.url);
  // The Coach document's photo, never the account avatar - two different
  // pictures of two different things.
  assert.notEqual(body.profile.profilePicture.url, USER_AVATAR);
});

test('the record comes from the token, so no one can ask for another coach', async () => {
  const mine = await seedCoach({ name: 'Mine', pictures: { profilePicture: COACH_PICTURE } });
  await seedCoach({ name: 'Theirs' });

  const response = await server.request('GET', '/api/coaches/me', { token: tokenFor(mine.user) });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.coach.id, String(mine.coach._id));
});

test('an account with no coach profile gets a 404, not someone else\'s', async () => {
  const member = await seedUser({ name: 'Just a member' });

  const response = await server.request('GET', '/api/coaches/me', { token: tokenFor(member) });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'COACH_NOT_FOUND');
});

test('"me" is not read as a coach id', async () => {
  // Declared before '/:id', so the literal never reaches the id handler.
  const response = await server.request('GET', '/api/coaches/me', { token: memberToken });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.message, 'You do not have a coach profile');
});

test('GET /api/coaches/me needs a token', async () => {
  const response = await server.request('GET', '/api/coaches/me');

  assert.equal(response.status, 401);
});
