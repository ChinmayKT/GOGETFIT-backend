import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import jwt from 'jsonwebtoken';

import env from '../../src/config/env.js';
import Coach from '../../src/models/coach.model.js';
import CoachTransformation from '../../src/models/coach-transformation.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { resetStorage } from '../../src/services/storage/index.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Coach transformation submissions: a coach posts an image + title for one of
 * their clients; admins list them. Members, other coaches' clients and
 * non-admins are refused.
 */

let server;
let uploadRoot;
let plan;
let coachA;
let coachAToken;
let coachBToken;
let member;
let memberToken;
let adminToken;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let seq = 0;
const seedUser = (roles = ['user', 'client'], profile = {}) => {
  seq += 1;
  const phone = `9187000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `User ${seq}`, ...profile }, roles, status: 'active' });
};
const seedCoach = async (name) => {
  const user = await seedUser(['user', 'coach'], { name });
  return { user, coach: await Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' }, status: 'active' }) };
};
const enroll = (user, coach, extra = {}) =>
  EnrolledClient.create({ userId: user._id, planId: plan._id, coachId: coach._id, enrollDate: new Date('2026-09-01'), hasStarted: false, isDeleted: false, ...extra });

const png = (fill = 0x02) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, fill)]);

const submit = (body, { token = coachAToken, client = member._id, title = '12 weeks, 8 kg down', contentType = 'image/png' } = {}) => {
  const qs = title === null ? '' : `?title=${encodeURIComponent(title)}`;
  return fetch(`${server.baseUrl}/api/coach/clients/${client}/transformations${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
};
const list = (token = adminToken, qs = '') => server.request('GET', `/api/admin/transformations${qs}`, { token });

before(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ggf-transformations-'));
  env.storage.localRoot = uploadRoot;
  resetStorage();
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  plan = await GogetfitPlan.create({
    name: '12 WEEKS GOGETFIT PLAN', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1,
    pricing: { basePrice: 4999, reward: 0 },
  });
  const a = await seedCoach('Coach Asha');
  coachA = a.coach;

  coachAToken = tokenFor(a.user);
  coachBToken = tokenFor((await seedCoach('Coach Ben')).user);
  member = await seedUser();
  memberToken = tokenFor(member);
  adminToken = tokenFor(await seedUser(['user', 'admin']));
  await enroll(member, coachA);
});

after(async () => {
  await server.close();
  await disconnectTestDb();
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

test('a coach submits an image + title for their client: stored, persisted, returned; the admin lists it', async () => {
  const res = await submit(png());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const t = res.body.data.transformation;
  assert.equal(t.title, '12 weeks, 8 kg down');
  assert.equal(t.coach.id, String(coachA._id));
  assert.equal(t.clientId, String(member._id));
  assert.match(t.imageUrl, /\/uploads\/coach-transformations\/.+\.png$/);
  assert.ok(!Number.isNaN(Date.parse(t.submittedAt)));

  const doc = await CoachTransformation.findById(t.id).lean();
  assert.equal(String(doc.coachId), String(coachA._id));
  await fs.access(path.join(uploadRoot, doc.image.storageKey));

  const listed = await list();
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.pagination.total, 1);
  const [item] = listed.body.data.items;
  assert.equal(item.id, t.id);
  assert.equal(item.title, '12 weeks, 8 kg down');
  assert.equal(item.imageUrl, t.imageUrl);
  assert.equal(item.coach.name, 'Coach Asha');
  assert.equal('storageKey' in item, false);
});

test('newest first, paged', async () => {
  for (const title of ['first', 'second', 'third']) {
    assert.equal((await submit(png(title.length), { title })).status, 201);
  }
  const page1 = await list(adminToken, '?pageSize=2');
  assert.deepEqual(page1.body.data.items.map((i) => i.title), ['third', 'second']);
  assert.equal(page1.body.data.pagination.hasMore, true);
  const page2 = await list(adminToken, '?pageSize=2&page=2');
  assert.deepEqual(page2.body.data.items.map((i) => i.title), ['first']);
});

test('title is required (trimmed, at most 100) and the image must be a real image under the limit - nothing stored', async () => {
  const files = async () => (await fs.readdir(uploadRoot, { recursive: true })).length;
  const stored = await files();
  assert.equal((await submit(png(), { title: null })).status, 400);
  assert.equal((await submit(png(), { title: '   ' })).status, 400);
  assert.equal((await submit(png(), { title: 'x'.repeat(101) })).status, 400);
  const fake = await submit(Buffer.from('not an image at all, just text'), { contentType: 'image/png' });
  assert.equal(fake.status, 400);
  assert.equal(fake.body.error.code, 'UNSUPPORTED_IMAGE_TYPE');
  const big = await submit(Buffer.concat([png(), Buffer.alloc(env.storage.maxUploadBytes)]));
  assert.equal(big.status, 413);
  assert.equal(await CoachTransformation.countDocuments(), 0);
  assert.equal(await files(), stored, 'no file left behind');
});

test('a member cannot submit; a coach cannot submit for someone else\'s client; no token is refused', async () => {
  assert.equal((await submit(png(), { token: memberToken })).status, 403);
  assert.equal((await submit(png(), { token: null })).status, 401);
  const notTheirs = await submit(png(), { token: coachBToken });
  assert.equal(notTheirs.status, 404);
  assert.equal(notTheirs.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
  assert.equal((await submit(png(), { client: 'not-an-id' })).status, 404);
  // A removed enrollment no longer counts.
  await EnrolledClient.updateMany({ userId: member._id }, { $set: { isDeleted: true } });
  assert.equal((await submit(png())).status, 404);
  assert.equal(await CoachTransformation.countDocuments(), 0);
});

test('the admin list is admins only', async () => {
  assert.equal((await list(null)).status, 401);
  assert.equal((await list(memberToken)).status, 403);
  assert.equal((await list(coachAToken)).status, 403);
  assert.equal((await list(adminToken, '?page=0')).status, 400);
});
