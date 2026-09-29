import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import jwt from 'jsonwebtoken';

import env from '../../src/config/env.js';
import User from '../../src/models/user.model.js';
import Coach from '../../src/models/coach.model.js';
import { resetStorage } from '../../src/services/storage/index.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  startTestServer,
} from '../helpers/test-server.js';

const jpeg = (fill = 0x01) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
const png = (fill = 0x02) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, fill)]);
const webp = () =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(64, 0x03)]);

const USER_AVATAR = 'http://example.test/uploads/profile/user.jpg';

let server;
let uploadRoot;
let adminToken;
let coachUser;
let coachUserToken;
let coachId;

const tokenFor = (user) =>
  jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const seedUser = (phone, roles, extra = {}) =>
  User.create({
    phone: { raw: phone, normalized: phone },
    profile: { name: `User ${phone}`, ...extra },
    roles,
    status: 'active',
  });

/** Raw-body upload, the shape every image endpoint in this project accepts. */
const upload = (slot, body, { token = adminToken, contentType = 'image/jpeg', id = coachId } = {}) =>
  fetch(`${server.baseUrl}/api/admin/coaches/${id}/${slot}`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));

const remove = (slot, { token = adminToken } = {}) =>
  server.request('DELETE', `/api/admin/coaches/${coachId}/${slot}`, { token });

const fileExists = async (image) => {
  try {
    await fs.access(path.join(uploadRoot, image.storageKey));
    return true;
  } catch {
    return false;
  }
};

const storedCoach = () => Coach.findById(coachId).lean();
const storedUser = () => User.findById(coachUser._id).lean();

before(async () => {
  // Uploads land in a scratch directory, never in the repository.
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ggf-coach-uploads-'));
  // env is read once at import, so the root is overridden on the loaded config.
  env.storage.localRoot = uploadRoot;
  resetStorage();

  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  const admin = await seedUser('918000000000', ['user', 'admin']);
  adminToken = tokenFor(admin);

  // The user already has their OWN avatar before becoming a coach.
  coachUser = await seedUser('919876543210', ['user'], { profilePicture: USER_AVATAR });
  coachUserToken = tokenFor(coachUser);

  const created = await server.request('POST', '/api/admin/coaches', {
    token: adminToken,
    body: { userId: String(coachUser._id), profile: { level: 'LEVEL 2' } },
  });
  coachId = created.body.data.coach.id;
});

after(async () => {
  await server.close();
  await disconnectTestDb();
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

test('16. a new coach has no pictures and does not inherit the user avatar', async () => {
  const res = await server.request('GET', `/api/admin/coaches/${coachId}`, { token: adminToken });
  assert.equal(res.body.data.coach.profile.profilePicture, null);
  assert.equal(res.body.data.coach.profile.coverPicture, null);
  assert.equal(res.body.data.coach.user.profilePicture, USER_AVATAR);
});

test('16. a coach document stored before the picture fields existed stays valid', async () => {
  const legacyShape = await Coach.collection.insertOne({
    userId: (await seedUser('919111111111', ['user', 'coach']))._id,
    profile: { level: 'LEVEL 1', languages: [] },
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const res = await server.request('GET', `/api/admin/coaches/${legacyShape.insertedId}`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.coach.profile.profilePicture, null);
  assert.equal(res.body.data.coach.profile.coverPicture, null);

  // And it can still be edited and given pictures.
  const edited = await server.request('PATCH', `/api/admin/coaches/${legacyShape.insertedId}`, {
    token: adminToken,
    body: { profile: { specialization: 'Mobility' } },
  });
  assert.equal(edited.status, 200);
  const uploaded = await upload('cover-picture', jpeg(), { id: String(legacyShape.insertedId) });
  assert.equal(uploaded.status, 200);
});

test('1, 4, 13, 14. uploading the coach profile picture leaves the user avatar alone', async () => {
  const res = await upload('profile-picture', jpeg());
  assert.equal(res.status, 200);

  const { profilePicture, coverPicture } = res.body.data.coach.profile;
  assert.match(profilePicture.url, new RegExp(`/uploads/coaches/${coachId}/profile/[0-9a-f]{32}\\.jpg$`));
  assert.equal(profilePicture.storageKey, `coaches/${coachId}/profile/${profilePicture.url.split('/').pop()}`);
  assert.equal(coverPicture, null);
  assert.equal(await fileExists(profilePicture), true);

  // The response keeps the two clearly apart.
  assert.equal(res.body.data.coach.user.profilePicture, USER_AVATAR);

  // And so does MongoDB: a reference only, no bytes.
  const coach = await storedCoach();
  assert.deepEqual(coach.profile.profilePicture, profilePicture);
  assert.equal((await storedUser()).profile.profilePicture, USER_AVATAR);
});

test('2, 3, 5. the cover is a separate picture that coexists with the profile picture', async () => {
  const profile = (await upload('profile-picture', jpeg(0x11))).body.data.coach.profile.profilePicture;
  const res = await upload('cover-picture', png(), { contentType: 'image/png' });
  assert.equal(res.status, 200);

  const { profilePicture, coverPicture } = res.body.data.coach.profile;
  assert.deepEqual(profilePicture, profile);
  assert.match(coverPicture.url, new RegExp(`/uploads/coaches/${coachId}/cover/[0-9a-f]{32}\\.png$`));
  assert.notEqual(coverPicture.url, profilePicture.url);

  const coach = await storedCoach();
  assert.deepEqual(coach.profile.profilePicture, profile);
  assert.deepEqual(coach.profile.coverPicture, coverPicture);
  assert.equal((await storedUser()).profile.profilePicture, USER_AVATAR);
});

test('the identical image used for both slots is still two independent files', async () => {
  const bytes = jpeg(0x42);
  await upload('profile-picture', bytes);
  const both = (await upload('cover-picture', bytes)).body.data.coach.profile;
  assert.notEqual(both.profilePicture.storageKey, both.coverPicture.storageKey);

  // Removing one leaves the other's file in place.
  await remove('cover-picture');
  assert.equal(await fileExists(both.profilePicture), true);
  assert.equal(await fileExists(both.coverPicture), false);
});

test('6. replacing the profile picture deletes the old file and keeps the cover', async () => {
  const cover = (await upload('cover-picture', webp(), { contentType: 'image/webp' })).body.data.coach.profile
    .coverPicture;
  const first = (await upload('profile-picture', jpeg(0x01))).body.data.coach.profile.profilePicture;
  const second = (await upload('profile-picture', jpeg(0x02))).body.data.coach.profile.profilePicture;

  assert.notEqual(first.url, second.url);
  assert.equal(await fileExists(first), false);
  assert.equal(await fileExists(second), true);

  const coach = await storedCoach();
  assert.deepEqual(coach.profile.profilePicture, second);
  assert.deepEqual(coach.profile.coverPicture, cover);
  assert.equal(await fileExists(cover), true);
});

test('7. replacing the cover deletes the old cover and keeps the profile picture', async () => {
  const profile = (await upload('profile-picture', jpeg())).body.data.coach.profile.profilePicture;
  const first = (await upload('cover-picture', png(0x01), { contentType: 'image/png' })).body.data.coach.profile
    .coverPicture;
  const second = (await upload('cover-picture', png(0x02), { contentType: 'image/png' })).body.data.coach.profile
    .coverPicture;

  assert.equal(await fileExists(first), false);
  assert.equal(await fileExists(second), true);
  assert.deepEqual((await storedCoach()).profile.profilePicture, profile);
});

test('re-uploading the same image keeps the file', async () => {
  const first = (await upload('profile-picture', jpeg(0x07))).body.data.coach.profile.profilePicture;
  const again = (await upload('profile-picture', jpeg(0x07))).body.data.coach.profile.profilePicture;
  assert.equal(again.url, first.url);
  assert.equal(await fileExists(again), true);
});

test('8. removing the profile picture clears only that slot', async () => {
  const profile = (await upload('profile-picture', jpeg())).body.data.coach.profile.profilePicture;
  const cover = (await upload('cover-picture', png(), { contentType: 'image/png' })).body.data.coach.profile
    .coverPicture;

  const res = await remove('profile-picture');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.coach.profile.profilePicture, null);
  assert.deepEqual(res.body.data.coach.profile.coverPicture, cover);

  const coach = await storedCoach();
  assert.equal(coach.profile.profilePicture, null);
  assert.deepEqual(coach.profile.coverPicture, cover);
  assert.equal(await fileExists(profile), false);
  assert.equal((await storedUser()).profile.profilePicture, USER_AVATAR);
});

test('9. removing the cover clears only that slot', async () => {
  const profile = (await upload('profile-picture', jpeg())).body.data.coach.profile.profilePicture;
  const cover = (await upload('cover-picture', png(), { contentType: 'image/png' })).body.data.coach.profile
    .coverPicture;

  const res = await remove('cover-picture');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.coach.profile.coverPicture, null);
  assert.deepEqual(res.body.data.coach.profile.profilePicture, profile);
  assert.equal(await fileExists(cover), false);
  assert.equal((await storedUser()).profile.profilePicture, USER_AVATAR);
});

test('removing a picture that is not set is harmless', async () => {
  const res = await remove('cover-picture');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.coach.profile.coverPicture, null);
});

test('15. the user changing their own avatar never changes the coach pictures', async () => {
  const coachPicture = (await upload('profile-picture', jpeg(0x31))).body.data.coach.profile.profilePicture;

  const own = await fetch(`${server.baseUrl}/api/users/me/profile-picture`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${coachUserToken}` },
    body: jpeg(0x32),
  });
  assert.equal(own.status, 200);

  const user = await storedUser();
  assert.notEqual(user.profile.profilePicture, USER_AVATAR);
  assert.notEqual(user.profile.profilePicture, coachPicture.url);
  assert.deepEqual((await storedCoach()).profile.profilePicture, coachPicture);

  await server.request('DELETE', '/api/users/me/profile-picture', { token: coachUserToken });
  assert.equal((await storedUser()).profile.profilePicture, null);
  assert.deepEqual((await storedCoach()).profile.profilePicture, coachPicture);
  assert.equal(await fileExists(coachPicture), true);
});

test('10. invalid images are rejected and nothing is stored', async () => {
  // Claims to be a JPEG, is not one: the bytes decide, not the header.
  const fake = await upload('profile-picture', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  assert.equal(fake.status, 400);
  assert.equal(fake.body.error.code, 'UNSUPPORTED_IMAGE_TYPE');

  const wrongType = await upload('cover-picture', Buffer.from('hello'), { contentType: 'text/plain' });
  assert.equal(wrongType.status, 400);

  const empty = await upload('cover-picture', Buffer.alloc(0));
  assert.equal(empty.status, 400);

  const tooBig = await upload('cover-picture', Buffer.concat([jpeg(), Buffer.alloc(6 * 1024 * 1024)]));
  assert.equal(tooBig.status, 413);

  const coach = await storedCoach();
  assert.equal(coach.profile.profilePicture, null);
  assert.equal(coach.profile.coverPicture, null);
  await assert.rejects(fs.access(path.join(uploadRoot, 'coaches', coachId)));
});

test('11-12. non-admins cannot upload or delete coach pictures', async () => {
  await upload('profile-picture', jpeg());

  // Even the coach's own account is not an admin.
  for (const token of [coachUserToken, null]) {
    for (const slot of ['profile-picture', 'cover-picture']) {
      const put = await upload(slot, jpeg(0x55), { token });
      assert.equal(put.status, token ? 403 : 401);
      const del = await remove(slot, { token });
      assert.equal(del.status, token ? 403 : 401);
    }
  }

  const coach = await storedCoach();
  assert.notEqual(coach.profile.profilePicture, null);
  assert.equal(coach.profile.coverPicture, null);
});

test('an unknown or malformed coach id is a 404 and stores nothing', async () => {
  const unknown = await upload('profile-picture', jpeg(), { id: '64b000000000000000000000' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'COACH_NOT_FOUND');

  const malformed = await upload('profile-picture', jpeg(), { id: 'nope' });
  assert.equal(malformed.status, 404);

  await assert.rejects(fs.access(path.join(uploadRoot, 'coaches', '64b000000000000000000000')));
});

test('pictures cannot be set through the profile edit', async () => {
  const res = await server.request('PATCH', `/api/admin/coaches/${coachId}`, {
    token: adminToken,
    body: { profile: { profilePicture: { url: USER_AVATAR, storageKey: 'profile/user.jpg' } } },
  });
  assert.equal(res.status, 400);
  assert.equal((await storedCoach()).profile.profilePicture, null);
});

test('the coach list returns the coach pictures, not the user avatar', async () => {
  const profile = (await upload('profile-picture', jpeg())).body.data.coach.profile.profilePicture;
  const list = await server.request('GET', '/api/admin/coaches', { token: adminToken });
  const [row] = list.body.data.coaches;
  assert.deepEqual(row.profile.profilePicture, profile);
  assert.equal(row.user.profilePicture, USER_AVATAR);
});
