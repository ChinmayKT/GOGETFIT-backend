import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import env from '../../src/config/env.js';
import BodyMetrics from '../../src/models/body-metrics.model.js';
import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { resetStorage } from '../../src/services/storage/index.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Body Metrics - one per enrollment, the questionnaire's ownership model, with
 * `submitted` final. Member, coach and admin reads.
 */

let server;
let uploadRoot;
let plan;
let member;
let memberToken;
let other;
let otherToken;
let coachA;
let coachAToken;
let coachB;
let coachBToken;
let adminToken;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let seq = 0;
const seedUser = (roles = ['user', 'client'], name) => {
  seq += 1;
  const phone = `9185000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name: name ?? `User ${seq}` }, roles, status: 'active' });
};
const seedCoach = async (name) => {
  const user = await seedUser(['user', 'coach'], name);
  return { user, coach: await Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' }, status: 'active' }) };
};
const enroll = (user, coach, extra = {}) =>
  EnrolledClient.create({ userId: user._id, planId: plan._id, coachId: coach._id, enrollDate: new Date('2026-09-01'), hasStarted: false, isDeleted: false, ...extra });

const jpeg = (fill = 0x01) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 0x05)]);

const ALL = {
  age: 32, height: 170.7, weight: 66, neck: 38, chest: 95.5, rightArm: 32, leftArm: 31.5,
  waist: 85, hips: 95, rightThigh: 55, leftThigh: 54.5,
};

const base = (enrollmentId) => `/api/users/me/enrollments/${enrollmentId}/body-metrics`;
const save = (enrollmentId, body, token = memberToken) => server.request('POST', base(enrollmentId), { body, token });
const read = (enrollmentId, token = memberToken) => server.request('GET', base(enrollmentId), { token });
const upload = (enrollmentId, slot, bytes, { token = memberToken, contentType = 'image/jpeg' } = {}) =>
  fetch(`${server.baseUrl}${base(enrollmentId)}/media/${slot}`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: bytes,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const photos = async (enrollmentId) => {
  for (const [slot, fill] of [['front', 1], ['side', 2], ['back', 3]]) {
    const res = await upload(enrollmentId, slot, jpeg(fill));
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
};
const stored = (enrollmentId) => BodyMetrics.findOne({ enrollmentId }).lean();

before(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ggf-body-metrics-'));
  env.storage.localRoot = uploadRoot;
  resetStorage();
  await connectTestDb();
  await BodyMetrics.init(); // the one-per-enrollment index must exist before the race tests
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  plan = await GogetfitPlan.create({
    name: '12 WEEKS GOGETFIT PLAN', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1,
    pricing: { basePrice: 4999, reward: 0 },
  });
  const a = await seedCoach('Prajwal');
  coachA = a.coach;
  coachAToken = tokenFor(a.user);
  const b = await seedCoach('Siri');
  coachB = b.coach;
  coachBToken = tokenFor(b.user);
  member = await seedUser(['user', 'client'], 'Asha');
  memberToken = tokenFor(member);
  other = await seedUser(['user', 'client'], 'Ravi');
  otherToken = tokenFor(other);
  adminToken = tokenFor(await seedUser(['user', 'admin']));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

test('create a draft, then save more of it: merged, still draft, coach from the enrollment', async () => {
  const e = await enroll(member, coachA);
  const first = await save(e._id, { measurements: { age: 32, height: 170.7 } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.bodyMetrics.status, 'draft');

  const second = await save(e._id, { measurements: { weight: 66 }, status: 'draft' });
  assert.equal(second.status, 200);
  const doc = await stored(e._id);
  assert.equal(doc.status, 'draft');
  assert.equal(doc.submittedAt, null);
  assert.deepEqual([doc.age, doc.height, doc.weight], [32, 170.7, 66]);
  assert.equal(String(doc.coachId), String(coachA._id));
  assert.equal(String(doc.userId), String(member._id));

  const got = await read(e._id);
  assert.equal(got.body.data.bodyMetrics.measurements.weight, 66);
  assert.equal(got.body.data.bodyMetrics.measurements.neck, null);
});

test('submit: all 11 measurements and the 3 photos persist, submittedAt set; video optional', async () => {
  const e = await enroll(member, coachA);
  await save(e._id, { measurements: ALL });
  await photos(e._id);

  const res = await save(e._id, { status: 'submitted' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const bm = res.body.data.bodyMetrics;
  assert.equal(bm.status, 'submitted');
  assert.ok(bm.submittedAt);
  assert.deepEqual(bm.measurements, ALL);
  for (const slot of ['front', 'side', 'back']) {
    assert.match(bm.media[slot].url, new RegExp(`/uploads/body-metrics/${e._id}/${slot}/[0-9a-f]{32}\\.jpg$`));
    await fs.access(path.join(uploadRoot, bm.media[slot].storageKey));
  }
  assert.equal(bm.media.video, null);

  const doc = await stored(e._id);
  assert.equal(doc.status, 'submitted');
  assert.ok(doc.submittedAt instanceof Date);
});

test("the record carries the member's own gender, read off their profile", async () => {
  const e = await enroll(member, coachA);
  await User.updateOne({ _id: member._id }, { $set: { 'profile.gender': 'female' } });

  const first = await save(e._id, { measurements: { age: 32 } });
  assert.equal(first.body.data.bodyMetrics.gender, 'female');
  assert.equal((await stored(e._id)).gender, 'female');

  // A draft follows the profile...
  await User.updateOne({ _id: member._id }, { $set: { 'profile.gender': 'male' } });
  await save(e._id, { measurements: ALL });
  assert.equal((await stored(e._id)).gender, 'male');

  // ...and the submission freezes it: a later profile change cannot rewrite
  // the record a coach is reading.
  await photos(e._id);
  const submitted = await save(e._id, { status: 'submitted' });
  assert.equal(submitted.body.data.bodyMetrics.gender, 'male');
  await User.updateOne({ _id: member._id }, { $set: { 'profile.gender': 'female' } });
  assert.equal((await read(e._id)).body.data.bodyMetrics.gender, 'male');
});

test('an account with no gender gets null on the record, not a guess', async () => {
  const e = await enroll(member, coachA);

  const res = await save(e._id, { measurements: ALL });

  assert.equal(res.body.data.bodyMetrics.gender, null);
  assert.equal((await stored(e._id)).gender, null);
});

test('an optional video persists when provided', async () => {
  const e = await enroll(member, coachA);
  await save(e._id, { measurements: ALL });
  await photos(e._id);
  const v = await upload(e._id, 'video', mp4(), { contentType: 'video/mp4' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const bm = (await save(e._id, { status: 'submitted' })).body.data.bodyMetrics;
  assert.match(bm.media.video.url, /\/body-metrics\/.+\/video\/[0-9a-f]{32}\.mp4$/);
});

test('submission is refused without a required photo or a measurement', async () => {
  const e = await enroll(member, coachA);
  await save(e._id, { measurements: ALL });
  await upload(e._id, 'front', jpeg(1));
  await upload(e._id, 'side', jpeg(2));
  let res = await save(e._id, { status: 'submitted' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'BODY_METRICS_INCOMPLETE');
  assert.deepEqual(res.body.error.details.missing, ['back']);

  await upload(e._id, 'back', jpeg(3));
  await save(e._id, { measurements: { hips: null } });
  res = await save(e._id, { status: 'submitted' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error.details.missing, ['hips']);
  assert.equal((await stored(e._id)).status, 'draft');
});

test('invalid measurements and forbidden fields are refused', async () => {
  const e = await enroll(member, coachA);
  for (const body of [
    { measurements: { age: 12 } }, // below the app's range
    { measurements: { age: 30.5 } }, // not whole
    { measurements: { waist: 161 } },
    { measurements: { neck: '38' } },
    { measurements: { biceps: 30 } },
    { measurements: ALL, userId: String(other._id) },
    { measurements: ALL, coachId: String(coachB._id) },
    { measurements: ALL, enrollmentId: String(e._id) },
    { measurements: ALL, gender: 'male' }, // copied from the profile, never sent
    { front: { url: 'http://x/y.jpg', storageKey: 'y.jpg' } },
    { status: 'done' },
  ]) {
    const res = await save(e._id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(await BodyMetrics.countDocuments(), 0);
});

test('bad media is refused: wrong slot, not an image, not an MP4', async () => {
  const e = await enroll(member, coachA);
  assert.equal((await upload(e._id, 'top', jpeg())).status, 400);
  assert.equal((await upload(e._id, 'front', Buffer.from('<svg/>'))).status, 400);
  assert.equal((await upload(e._id, 'video', jpeg(), { contentType: 'video/mp4' })).status, 400);
});

test('submitted is final: no autosave, no media change can downgrade or alter it', async () => {
  const e = await enroll(member, coachA);
  await save(e._id, { measurements: ALL });
  await photos(e._id);
  await save(e._id, { status: 'submitted' });
  const before = await stored(e._id);

  for (const res of [
    await save(e._id, { measurements: { weight: 70 }, status: 'draft' }),
    await save(e._id, { status: 'submitted' }),
    await upload(e._id, 'front', jpeg(9)),
    await server.request('DELETE', `${base(e._id)}/media/front`, { token: memberToken }),
  ]) {
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'BODY_METRICS_ALREADY_SUBMITTED');
  }
  assert.deepEqual(await stored(e._id), before);
});

test('one Body Metrics record per enrollment; enrollments stay isolated', async () => {
  const e1 = await enroll(member, coachA, { enrollDate: new Date('2025-01-01') });
  const e2 = await enroll(member, coachA, { enrollDate: new Date('2026-01-01') });
  await Promise.all([save(e1._id, { measurements: { age: 30 } }), save(e1._id, { measurements: { weight: 70 } })]);
  await save(e2._id, { measurements: { age: 31 } });
  assert.equal(await BodyMetrics.countDocuments({ enrollmentId: e1._id }), 1);
  assert.equal(await BodyMetrics.countDocuments(), 2);
  assert.equal((await stored(e1._id)).age, 30);
  assert.equal((await stored(e2._id)).age, 31);
  await assert.rejects(BodyMetrics.create({ userId: member._id, enrollmentId: e1._id }), /duplicate key/);
});

test("a member cannot reach another member's enrollment, a deleted one, or an unknown one", async () => {
  const theirs = await enroll(other, coachA);
  await save(theirs._id, { measurements: { age: 40 } }, otherToken);
  const deleted = await enroll(member, coachA, { isDeleted: true });

  for (const id of [theirs._id, deleted._id, new mongoose.Types.ObjectId(), 'nope']) {
    assert.equal((await read(id)).status, 404, String(id));
    assert.equal((await save(id, { measurements: { age: 30 } })).status, 404, String(id));
    assert.equal((await upload(id, 'front', jpeg())).status, 404, String(id));
  }
  assert.equal((await stored(theirs._id)).age, 40);
  assert.equal(await BodyMetrics.countDocuments(), 1);
});

test('member history: submitted only, newest first, with plan and coach', async () => {
  const e1 = await enroll(member, coachA, { enrollDate: new Date('2025-01-01') });
  const e2 = await enroll(member, coachA, { enrollDate: new Date('2026-01-01') });
  const e3 = await enroll(member, coachA, { enrollDate: new Date('2026-06-01') }); // draft only
  for (const e of [e1, e2]) {
    await save(e._id, { measurements: ALL });
    await photos(e._id);
    await save(e._id, { status: 'submitted' });
  }
  await save(e3._id, { measurements: { age: 30 } });

  const res = await server.request('GET', '/api/users/me/body-metrics?status=submitted', { token: memberToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.bodyMetrics.map((b) => b.enrollmentId), [String(e2._id), String(e1._id)]);
  assert.equal(res.body.data.bodyMetrics[0].plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.deepEqual(res.body.data.bodyMetrics[0].coach, { id: String(coachA._id), name: 'Prajwal', level: 'LEVEL 1' });
  // Another member's list is theirs alone.
  const theirs = await server.request('GET', '/api/users/me/body-metrics', { token: otherToken });
  assert.equal(theirs.body.data.total, 0);
});

test("coach: reads their own client's submitted Body Metrics; never a draft; never another coach's", async () => {
  const mine = await enroll(member, coachA);
  const theirs = await enroll(other, coachB);
  const coachRead = (id, token = coachAToken) => server.request('GET', `/api/coach/enrollments/${id}/body-metrics`, { token });

  // Nothing yet, then a draft: both null.
  assert.deepEqual((await coachRead(mine._id)).body.data, { bodyMetrics: null });
  await save(mine._id, { measurements: ALL });
  await photos(mine._id);
  assert.equal((await coachRead(mine._id)).body.data.bodyMetrics, null);

  await save(mine._id, { status: 'submitted' });
  const bm = (await coachRead(mine._id)).body.data.bodyMetrics;
  assert.equal(bm.status, 'submitted');
  assert.deepEqual(bm.measurements, ALL);
  assert.ok(bm.media.front.url && bm.media.side.url && bm.media.back.url);

  await save(theirs._id, { measurements: ALL }, otherToken);
  const forbidden = await coachRead(theirs._id);
  assert.equal(forbidden.status, 404);
  assert.equal((await server.request('GET', `/api/coach/enrollments/${theirs._id}/body-metrics?coachId=${coachB._id}`, { token: coachAToken })).status, 404);
  assert.equal((await coachRead(theirs._id, coachBToken)).body.data.bodyMetrics, null); // B's client: still a draft
  assert.equal((await coachRead(mine._id, memberToken)).status, 403);
});

test('coach client list flags bodyMetricsSubmitted per enrollment', async () => {
  const done = await enroll(member, coachA, { enrollDate: new Date('2026-01-01') });
  const draft = await enroll(member, coachA, { enrollDate: new Date('2025-01-01') });
  await save(done._id, { measurements: ALL });
  await photos(done._id);
  await save(done._id, { status: 'submitted' });
  await save(draft._id, { measurements: ALL });

  const rows = (await server.request('GET', '/api/coach/clients', { token: coachAToken })).body.data.clients;
  const byId = Object.fromEntries(rows.map((r) => [r.enrollmentId, r.bodyMetricsSubmitted]));
  assert.deepEqual(byId, { [String(done._id)]: true, [String(draft._id)]: false });
});

test('admin: submitted Body Metrics per enrollment, newest first; drafts hidden; admins only', async () => {
  const e1 = await enroll(member, coachA, { enrollDate: new Date('2025-01-01') });
  const e2 = await enroll(member, coachB, { enrollDate: new Date('2026-01-01') });
  for (const e of [e1, e2]) {
    await save(e._id, { measurements: { ...ALL, weight: e === e1 ? 80 : 66 } });
    await photos(e._id);
  }
  await save(e1._id, { status: 'submitted' });
  await new Promise((r) => setTimeout(r, 5));
  await save(e2._id, { status: 'submitted' });
  await save((await enroll(member, coachA))._id, { measurements: { age: 30 } }); // a draft

  const res = await server.request('GET', `/api/admin/users/${member._id}/body-metrics`, { token: adminToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body.data.bodyMetrics;
  assert.equal(res.body.data.total, 2);
  assert.deepEqual(rows.map((r) => [r.enrollmentId, r.measurements.weight, r.coach.name]), [
    [String(e2._id), 66, 'Siri'],
    [String(e1._id), 80, 'Prajwal'],
  ]);
  assert.equal(rows[0].enrollment.enrollDate, '2026-01-01T00:00:00.000Z');

  assert.equal((await server.request('GET', `/api/admin/users/${member._id}/body-metrics`, { token: memberToken })).status, 403);
  assert.equal((await server.request('GET', `/api/admin/users/${new mongoose.Types.ObjectId()}/body-metrics`, { token: adminToken })).status, 404);
});
