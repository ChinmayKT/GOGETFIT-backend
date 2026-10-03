import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import User from '../../src/models/user.model.js';
import { resetStorage } from '../../src/services/storage/index.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  login,
  startTestServer,
} from '../helpers/test-server.js';

const PHONE = '9111111111';
const OTHER_PHONE = '9222222222';

const jpeg = (fill = 0x01) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 0x02),
  ]);

let server;
let token;
let uploadRoot;

/** Raw-body upload, the shape the endpoint accepts. */
const upload = (body, { token: bearer, contentType = 'image/jpeg' } = {}) =>
  fetch(`${server.baseUrl}/api/users/me/profile-picture`, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body,
  }).then(async (response) => ({
    status: response.status,
    body: await response.json().catch(() => null),
  }));

before(async () => {
  // Uploads land in a scratch directory, never in the repository.
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ggf-uploads-'));
  process.env.STORAGE_LOCAL_ROOT = uploadRoot;
  resetStorage();

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
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

test('a new user starts with no profile picture', async () => {
  const response = await server.request('GET', '/api/users/me', { token });

  assert.equal(response.body.data.user.profile.profilePicture, null);
  // The field belongs inside profile, never at the root of the payload.
  assert.equal(
    Object.prototype.hasOwnProperty.call(response.body.data.user, 'profilePicture'),
    false,
  );
});

test('an authenticated user can add a profile picture', async () => {
  const response = await upload(jpeg(), { token });
  const url = response.body.data.user.profile.profilePicture;

  assert.equal(response.status, 200);
  assert.match(url, /^http.*\/uploads\/profile\/[a-f0-9]{32}\.jpg$/);

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.profilePicture, url);

  // The bytes are on disk, not in MongoDB.
  const raw = await User.collection.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(typeof raw.profile.profilePicture, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'profilePicture'), false);
});

test('the stored file is served back over HTTP', async () => {
  const bytes = jpeg(0x07);
  const { body } = await upload(bytes, { token });
  const url = body.data.user.profile.profilePicture;

  const served = await fetch(`${server.baseUrl}${new URL(url).pathname}`);
  const downloaded = Buffer.from(await served.arrayBuffer());

  assert.equal(served.status, 200);
  assert.equal(downloaded.equals(bytes), true);
});

test('a user can replace their picture, and the old file is removed', async () => {
  const first = await upload(jpeg(0x11), { token });
  const firstUrl = first.body.data.user.profile.profilePicture;

  const second = await upload(png(), { token });
  const secondUrl = second.body.data.user.profile.profilePicture;

  assert.notEqual(firstUrl, secondUrl);
  assert.match(secondUrl, /\.png$/);

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.profilePicture, secondUrl);

  // The replacement is readable and the original is gone.
  const newFile = await fetch(`${server.baseUrl}${new URL(secondUrl).pathname}`);
  const oldFile = await fetch(`${server.baseUrl}${new URL(firstUrl).pathname}`);
  assert.equal(newFile.status, 200);
  assert.equal(oldFile.status, 404);
});

test('a user can remove their picture', async () => {
  const added = await upload(jpeg(0x21), { token });
  const url = added.body.data.user.profile.profilePicture;

  const removed = await server.request('DELETE', '/api/users/me/profile-picture', { token });

  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.user.profile.profilePicture, null);

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.profilePicture, null);

  const gone = await fetch(`${server.baseUrl}${new URL(url).pathname}`);
  assert.equal(gone.status, 404);
});

test('removing when there is no picture is harmless', async () => {
  const response = await server.request('DELETE', '/api/users/me/profile-picture', { token });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.user.profile.profilePicture, null);
});

test('one user cannot touch another user"s picture', async () => {
  await upload(jpeg(0x31), { token });
  const mine = await User.findOne({ 'phone.normalized': '919111111111' });

  // A second, separate account.
  const { token: otherToken } = await login(server.request, OTHER_PHONE);
  await upload(png(), { token: otherToken });

  const theirs = await User.findOne({ 'phone.normalized': '919222222222' });
  const reloadedMine = await User.findOne({ 'phone.normalized': '919111111111' });

  assert.notEqual(String(mine._id), String(theirs._id));
  assert.notEqual(theirs.profile.profilePicture, null);
  // The first account is untouched by the second account's upload.
  assert.equal(reloadedMine.profile.profilePicture, mine.profile.profilePicture);

  // Deleting as the second user leaves the first user's picture alone.
  await server.request('DELETE', '/api/users/me/profile-picture', { token: otherToken });
  const afterDelete = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(afterDelete.profile.profilePicture, mine.profile.profilePicture);
});

test('the endpoints require authentication', async () => {
  const uploaded = await upload(jpeg());
  const removed = await server.request('DELETE', '/api/users/me/profile-picture');

  assert.equal(uploaded.status, 401);
  assert.equal(removed.status, 401);
});

test('a non-image payload is refused', async () => {
  const script = Buffer.from('#!/bin/sh\necho pwned\n', 'utf8');
  const response = await upload(script, { token });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'UNSUPPORTED_IMAGE_TYPE');

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.profilePicture, null);
});

test('a content type the client invents does not get the bytes stored', async () => {
  // Claims to be a JPEG, is actually an ELF binary.
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]);
  const response = await upload(elf, { token, contentType: 'image/jpeg' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'UNSUPPORTED_IMAGE_TYPE');
});

test('changing the picture leaves the email and its lock alone', async () => {
  await User.updateOne(
    { 'phone.normalized': '919111111111' },
    { $set: { 'profile.email': 'migrated@example.com', 'profile.isEmailVerified': true } },
  );

  const response = await upload(jpeg(0x41), { token });
  const profile = response.body.data.user.profile;

  assert.equal(profile.email, 'migrated@example.com');
  assert.equal(profile.isEmailVerified, true);
  assert.notEqual(profile.profilePicture, null);

  // And the email stays locked afterwards.
  const patched = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { email: 'attacker@example.com' },
  });
  assert.equal(patched.status, 409);
  assert.equal(patched.body.error.code, 'EMAIL_ALREADY_VERIFIED');
});

test('a verified email does not block picture changes', async () => {
  await User.updateOne(
    { 'phone.normalized': '919111111111' },
    { $set: { 'profile.email': 'migrated@example.com', 'profile.isEmailVerified': true } },
  );

  const added = await upload(jpeg(0x51), { token });
  const removed = await server.request('DELETE', '/api/users/me/profile-picture', { token });

  assert.equal(added.status, 200);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.user.profile.profilePicture, null);
});

test('the picture is not settable through the profile patch contract', async () => {
  const response = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { profilePicture: 'https://evil.example.com/x.jpg' },
  });

  assert.equal(response.status, 400);

  const stored = await User.findOne({ 'phone.normalized': '919111111111' });
  assert.equal(stored.profile.profilePicture, null);
});

test('uploading does not disturb the rest of the profile', async () => {
  await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { name: 'John', dateOfBirth: '2001-09-22', gender: 'male', city: 'Bengaluru' },
  });
  const before = await User.findOne({ 'phone.normalized': '919111111111' });

  await upload(jpeg(0x61), { token });
  const after = await User.findOne({ 'phone.normalized': '919111111111' });

  assert.equal(after.profile.name, before.profile.name);
  assert.equal(after.profile.gender, before.profile.gender);
  assert.equal(after.profile.city, before.profile.city);
  assert.equal(after.profile.age, before.profile.age);
  assert.equal(after.profileCompleted, before.profileCompleted);
  assert.equal(String(after._id), String(before._id));
  // Compare the values, not the Mongoose subdocuments, which carry parent state.
  assert.equal(after.phone.normalized, before.phone.normalized);
  assert.equal(after.phone.raw, before.phone.raw);
});

test('phone OTP authentication is unaffected', async () => {
  const requested = await server.request('POST', '/api/auth/request-otp', {
    body: { phone: '9444444444' },
  });
  const verified = await server.request('POST', '/api/auth/verify-otp', {
    body: { phone: '9444444444', otp: requested.body.data.devOtp },
  });

  assert.equal(verified.status, 201);
  assert.equal(verified.body.data.user.profile.profilePicture, null);
});

test('the profile picture completes (or un-completes) an otherwise full profile', async () => {
  await User.updateOne(
    { 'phone.normalized': `91${PHONE}` },
    {
      $set: {
        'profile.name': 'John',
        'profile.dateOfBirth': new Date('2001-09-22T00:00:00Z'),
        'profile.age': 25,
        'profile.gender': 'male',
        'profile.city': 'Bengaluru',
        'profile.email': 'john@example.com',
        'profile.isEmailVerified': true,
        'profile.fitnessProfile': {
          height: 176.8,
          weight: 66.3,
          bodyFatPercentage: 15,
          activityLevel: 'sedentary',
          foodType: 'nonVegetarian',
          goal: 'maintainPhysique',
          bmr: 1648,
          tdee: 1977.6,
        },
        profileCompleted: false,
      },
    },
  );
  assert.equal((await upload(jpeg(), { token })).status, 200);
  assert.equal((await User.findOne({ 'phone.normalized': `91${PHONE}` }).lean()).profileCompleted, true);

  await server.request('DELETE', '/api/users/me/profile-picture', { token });
  assert.equal((await User.findOne({ 'phone.normalized': `91${PHONE}` }).lean()).profileCompleted, false);
});
