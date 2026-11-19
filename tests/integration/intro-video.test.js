import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import jwt from 'jsonwebtoken';

import env from '../../src/config/env.js';
import IntroVideo from '../../src/models/intro-video.model.js';
import User from '../../src/models/user.model.js';
import Workout from '../../src/models/workout.model.js';
import { resetStorage } from '../../src/services/storage/index.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Introductory Videos: their own `intro_videos` collection, managed by admins
 * like workouts (CRUD, archive / restore, video + thumbnail as raw bodies
 * through the storage service) and listed to signed-in members - active
 * lessons with a video, in lesson order. Workouts are never touched.
 */
let server;
let uploadRoot;
let admin;
let adminToken;
let memberToken;

const jpeg = (fill = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
const mp4 = (fill = 5) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, fill)]);

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const seedUser = (phone, roles) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `User ${phone}` }, roles, status: 'active' });

const api = (method, url, body, token = adminToken) => server.request(method, url, { token, body });
const raw = (method, url, buffer, contentType, token = adminToken) =>
  fetch(`${server.baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: buffer,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const exists = (key) => fs.access(path.join(uploadRoot, key)).then(() => true, () => false);

const lesson = (overrides = {}) => ({
  title: 'Understanding Basics',
  subtitle: 'Start here',
  description: 'A quick tour of the app.',
  whatYoullLearn: ['Where things are', '  ', 'What My Journey tracks'],
  notes: 'Re-watch any time.',
  ...overrides,
});
const create = async (overrides) => (await api('POST', '/api/admin/intro-videos', lesson(overrides))).body.data.introVideo;
const upload = (id, slot, buffer, type) => raw('PUT', `/api/admin/intro-videos/${id}/${slot}`, buffer, type);
const memberList = async () => (await api('GET', '/api/intro-videos', undefined, memberToken)).body.data.introVideos;

before(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ggf-intro-'));
  env.storage.localRoot = uploadRoot;
  resetStorage();
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  admin = await seedUser('918000000000', ['user', 'admin']);
  adminToken = tokenFor(admin);
  memberToken = tokenFor(await seedUser('918000000001', ['user', 'client']));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

test('an admin creates a lesson: saved in intro_videos (not workouts), positioned after the last', async () => {
  const workoutsBefore = await Workout.countDocuments();
  const res = await api('POST', '/api/admin/intro-videos', lesson());
  assert.equal(res.status, 201);
  const v = res.body.data.introVideo;
  assert.deepEqual(
    { title: v.title, subtitle: v.subtitle, learn: v.whatYoullLearn, position: v.position, status: v.status, hasVideo: v.hasVideo },
    { title: 'Understanding Basics', subtitle: 'Start here', learn: ['Where things are', 'What My Journey tracks'], position: 1, status: 'active', hasVideo: false },
  );
  assert.equal(v.createdBy.id, String(admin._id));
  assert.equal((await create({ title: 'Second' })).position, 2, 'appended');
  assert.equal(await IntroVideo.countDocuments(), 2);
  assert.equal(await Workout.countDocuments(), workoutsBefore, 'never in the workouts collection');
  assert.equal(IntroVideo.collection.collectionName, 'intro_videos');
});

test('validation: required title and description, limits, no client-set media or audit fields', async () => {
  for (const body of [
    lesson({ title: '  ' }),
    lesson({ description: undefined }),
    lesson({ title: 'x'.repeat(151) }),
    lesson({ whatYoullLearn: Array(13).fill('item') }),
    lesson({ position: 0 }),
    lesson({ durationSeconds: -1 }),
    lesson({ video: { url: 'x' } }),
    lesson({ createdBy: String(admin._id) }),
    lesson({ category: 'x' }),
  ]) {
    assert.equal((await api('POST', '/api/admin/intro-videos', body)).status, 400, JSON.stringify(Object.keys(body)));
  }
  assert.equal(await IntroVideo.countDocuments(), 0);
});

test('edit changes only what is sent; media and audit stay', async () => {
  const v = await create();
  await upload(v.id, 'video', mp4(), 'video/mp4');
  const res = await api('PATCH', `/api/admin/intro-videos/${v.id}`, { title: 'Basics (updated)', position: 4, durationSeconds: 215 });
  assert.equal(res.status, 200);
  const after = res.body.data.introVideo;
  assert.deepEqual([after.title, after.position, after.durationSeconds, after.subtitle], ['Basics (updated)', 4, 215, 'Start here']);
  assert.ok(after.video?.url, 'the video survives a text edit');
  assert.equal(after.createdBy.id, String(admin._id));
  assert.equal((await api('PATCH', `/api/admin/intro-videos/${v.id}`, {})).status, 400);
  assert.equal((await api('PATCH', '/api/admin/intro-videos/64b000000000000000000000', { title: 'x' })).status, 404);
  assert.equal((await api('GET', '/api/admin/intro-videos/not-an-id')).status, 404);
});

test('video and thumbnail upload through the storage service; replacing removes the old file', async () => {
  const v = await create();
  let res = await upload(v.id, 'video', mp4(1), 'video/mp4');
  assert.equal(res.status, 200);
  const first = res.body.data.introVideo.video;
  assert.match(first.url, /intro-videos\/.+\/video\//);
  assert.ok(await exists(first.storageKey));

  res = await upload(v.id, 'video', mp4(2), 'video/mp4');
  const second = res.body.data.introVideo.video;
  assert.notEqual(second.url, first.url);
  assert.equal(await exists(first.storageKey), false, 'the replaced video is removed');

  res = await upload(v.id, 'thumbnail', jpeg(), 'image/jpeg');
  assert.equal(res.status, 200);
  const thumb = res.body.data.introVideo.thumbnail;
  assert.match(thumb.url, /intro-videos\/.+\/thumbnail\//);

  // Bytes decide: an image as the video, text as the thumbnail - refused.
  assert.equal((await upload(v.id, 'video', jpeg(), 'video/mp4')).status, 400);
  assert.equal((await upload(v.id, 'thumbnail', Buffer.from('not an image'), 'image/jpeg')).status, 400);

  res = await raw('DELETE', `/api/admin/intro-videos/${v.id}/thumbnail`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.introVideo.thumbnail, null);
  assert.equal(await exists(thumb.storageKey), false);
  // Only references in MongoDB.
  const doc = await IntroVideo.findById(v.id).lean();
  assert.deepEqual(Object.keys(doc.video).sort(), ['storageKey', 'url']);
});

test('delete archives (out of the app, kept); restore brings it back', async () => {
  const v = await create();
  await upload(v.id, 'video', mp4(), 'video/mp4');
  assert.equal((await memberList()).length, 1);

  const del = await api('DELETE', `/api/admin/intro-videos/${v.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.data.introVideo.status, 'archived');
  assert.ok(del.body.data.introVideo.archivedAt);
  assert.equal(await IntroVideo.countDocuments(), 1, 'not removed');
  assert.deepEqual(await memberList(), []);
  const activeList = await api('GET', '/api/admin/intro-videos');
  assert.equal(activeList.body.data.introVideos.length, 0);
  const archivedList = await api('GET', '/api/admin/intro-videos?status=archived');
  assert.equal(archivedList.body.data.introVideos.length, 1);

  const restored = await api('POST', `/api/admin/intro-videos/${v.id}/restore`);
  assert.equal(restored.body.data.introVideo.status, 'active');
  assert.equal((await memberList()).length, 1);
});

test('admin list: lesson order by default, search, paging', async () => {
  for (const [title, position] of [['Diet plan', 3], ['Basics', 1], ['Workout plan', 2]]) await create({ title, position });
  const list = await api('GET', '/api/admin/intro-videos');
  assert.deepEqual(list.body.data.introVideos.map((v) => v.title), ['Basics', 'Workout plan', 'Diet plan']);
  const search = await api('GET', '/api/admin/intro-videos?search=PLAN');
  assert.deepEqual(search.body.data.introVideos.map((v) => v.title), ['Workout plan', 'Diet plan']);
  const page2 = await api('GET', '/api/admin/intro-videos?page=2&pageSize=2');
  assert.deepEqual(page2.body.data.introVideos.map((v) => v.title), ['Diet plan']);
  assert.deepEqual(page2.body.data.pagination, { page: 2, pageSize: 2, total: 3, totalPages: 2 });
  assert.equal((await api('GET', '/api/admin/intro-videos?sortKey=nope')).status, 400);
});

test('the member list: active lessons with a video, in order, member-safe fields; changes show at once', async () => {
  const a = await create({ title: 'Second', position: 2 });
  const b = await create({ title: 'First', position: 1 });
  await create({ title: 'No video yet', position: 3 });
  await upload(a.id, 'video', mp4(1), 'video/mp4');
  await upload(b.id, 'video', mp4(2), 'video/mp4');
  await upload(b.id, 'thumbnail', jpeg(), 'image/jpeg');

  let list = await memberList();
  assert.deepEqual(list.map((v) => v.title), ['First', 'Second'], 'no video, not listed');
  assert.deepEqual(Object.keys(list[0]).sort(), ['description', 'durationSeconds', 'id', 'notes', 'position', 'subtitle', 'thumbnail', 'tips', 'title', 'video', 'whatYoullLearn']);
  assert.deepEqual(Object.keys(list[0].video), ['url'], 'no storage keys');
  assert.equal(list[1].thumbnail, null);

  await api('PATCH', `/api/admin/intro-videos/${a.id}`, { title: 'Now first', position: 0.5 }); // invalid position
  await api('PATCH', `/api/admin/intro-videos/${a.id}`, { title: 'Now first' });
  list = await memberList();
  assert.equal(list[1].title, 'Now first', 'an edit shows in the app');
});

test('only admins manage; members only read; the member read needs sign-in', async () => {
  const v = await create();
  for (const [method, url] of [
    ['GET', '/api/admin/intro-videos'],
    ['POST', '/api/admin/intro-videos'],
    ['PATCH', `/api/admin/intro-videos/${v.id}`],
    ['DELETE', `/api/admin/intro-videos/${v.id}`],
    ['POST', `/api/admin/intro-videos/${v.id}/restore`],
  ]) {
    const body = method === 'GET' ? undefined : lesson();
    assert.equal((await api(method, url, body, memberToken)).status, 403, `${method} ${url}`);
    assert.equal((await api(method, url, body, null)).status, 401, `${method} ${url} anonymous`);
  }
  assert.equal((await raw('PUT', `/api/admin/intro-videos/${v.id}/video`, mp4(), 'video/mp4', memberToken)).status, 403);
  assert.equal((await api('GET', '/api/intro-videos', undefined, null)).status, 401);
  assert.equal((await IntroVideo.findById(v.id).lean()).status, 'active');
});
