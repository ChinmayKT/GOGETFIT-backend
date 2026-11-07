import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import compression from 'compression';
import jwt from 'jsonwebtoken';

import env from '../../src/config/env.js';
import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import WeeklyUpdate from '../../src/models/weekly-update.model.js';
import { WEEKLY_MEASUREMENTS } from '../../src/constants/weekly-update-definition.js';
import { addCalendarDays, businessDayOf } from '../../src/utils/business-date.js';
import { resetStorage } from '../../src/services/storage/index.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Weekly Updates - photos into today's draft, then one final submit per member,
 * enrollment and report date. Member history and coach reads.
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
let coachBToken;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const today = () => businessDayOf(new Date());

let seq = 0;
const seedUser = (roles = ['user', 'client'], profile = {}) => {
  seq += 1;
  const phone = `9186000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `User ${seq}`, ...profile }, roles, status: 'active' });
};
const seedCoach = async () => {
  const user = await seedUser(['user', 'coach']);
  return { user, coach: await Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' }, status: 'active' }) };
};
const enroll = (user, coach, extra = {}) =>
  EnrolledClient.create({ userId: user._id, planId: plan._id, coachId: coach._id, enrollDate: new Date('2026-09-01'), hasStarted: false, isDeleted: false, ...extra });

const jpeg = (fill = 0x01) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 0x05)]);

const VALID = {
  weightKg: 70.5, neckCm: 38.3, chestCm: 95.6, rightArmFlexedCm: 32.2, leftArmFlexedCm: 32.5,
  waistCm: 85.3, hipsCm: 95.4, rightThighCm: 55.5, leftThighCm: 55.2,
};

const base = '/api/users/me/weekly-updates';
const submit = (body, token = memberToken) => server.request('POST', base, { body, token });
const valid = (extra = {}) => ({ reportDate: today(), measurements: { ...VALID }, ...extra });
const upload = (slot, bytes, { token = memberToken, date = today(), contentType = 'image/jpeg' } = {}) =>
  fetch(`${server.baseUrl}${base}/${date}/media/${slot}`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: bytes,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const photos = async (token = memberToken, slots = ['front', 'side', 'back']) => {
  for (const [i, slot] of slots.entries()) {
    const res = await upload(slot, jpeg(i + 1), { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
};

before(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ggf-weekly-updates-'));
  env.storage.localRoot = uploadRoot;
  resetStorage();
  await connectTestDb();
  await WeeklyUpdate.syncIndexes(); // exactly the schema's indexes, before the race tests
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  plan = await GogetfitPlan.create({
    name: '12 WEEKS GOGETFIT PLAN', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1,
    pricing: { basePrice: 4999, reward: 0 },
  });
  const a = await seedCoach();
  coachA = a.coach;
  coachAToken = tokenFor(a.user);
  coachBToken = tokenFor((await seedCoach()).user);
  member = await seedUser(['user', 'client'], {
    gender: 'male', dateOfBirth: new Date('1994-04-01'), fitnessProfile: { height: 189 },
  });
  memberToken = tokenFor(member);
  other = await seedUser();
  otherToken = tokenFor(other);
});

after(async () => {
  await server.close();
  await disconnectTestDb();
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

test('photos, then the nine measurements: one submitted record, owners and profile from the server', async () => {
  const e = await enroll(member, coachA);
  await photos();
  const res = await submit(valid());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const view = res.body.data.weeklyUpdate;
  assert.equal(view.status, 'submitted');
  assert.equal(view.reportDate, today());
  assert.deepEqual(view.measurements, VALID);
  assert.equal(view.progressMedia.video, null);
  for (const field of ['frontPhoto', 'sidePhoto', 'backPhoto']) {
    assert.match(view.progressMedia[field].url, new RegExp(`/uploads/weekly-updates/${member._id}/${today()}/`));
    assert.ok(view.progressMedia[field].uploadedAt);
    assert.equal('storageKey' in view.progressMedia[field], false, 'storage keys stay server-side');
  }

  const doc = await WeeklyUpdate.findOne({ clientId: member._id }).lean();
  assert.equal(String(doc.enrollmentId), String(e._id));
  assert.equal(String(doc.coachId), String(coachA._id));
  assert.equal(String(doc.planId), String(plan._id));
  assert.equal(doc.profileSnapshot.gender, 'male');
  assert.equal(doc.profileSnapshot.heightCm, 189);
  assert.equal(typeof doc.profileSnapshot.age, 'number');
  assert.equal(typeof doc.measurements.weightKg, 'number');
  assert.equal(doc.weekNumber, null, 'the plan has not started');
  assert.ok(doc.submittedAt instanceof Date);
});

test('the optional video is kept; week number counts from the plan start', async () => {
  await enroll(member, coachA, { hasStarted: true, startDate: new Date(`${addCalendarDays(today(), -15)}T00:00:00Z`) });
  await photos();
  assert.equal((await upload('video', mp4(), { contentType: 'video/mp4' })).status, 200);
  const res = await submit(valid());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.data.weeklyUpdate.progressMedia.video.url);
  assert.equal(res.body.data.weeklyUpdate.weekNumber, 3);
});

test('every measurement is required', async () => {
  await enroll(member, coachA);
  await photos();
  for (const { key } of WEEKLY_MEASUREMENTS) {
    const measurements = { ...VALID };
    delete measurements[key];
    const res = await submit({ reportDate: today(), measurements });
    assert.equal(res.status, 400, key);
    assert.match(res.body.error.message, new RegExp(key));
  }
  assert.equal(await WeeklyUpdate.countDocuments({ status: 'submitted' }), 0);
});

test('no range or decimal limit: any number is taken; non-numbers and blanks are not', async () => {
  await enroll(member, coachA);
  await photos();
  for (const [key, value] of [['chestCm', '95.6'], ['waistCm', ''], ['hipsCm', null], ['neckCm', true]]) {
    const res = await submit({ reportDate: today(), measurements: { ...VALID, [key]: value } });
    assert.equal(res.status, 400, `${key}=${JSON.stringify(value)}`);
  }
  const res = await submit({ reportDate: today(), measurements: { ...VALID, weightKg: 412.75, neckCm: 3, leftThighCm: 120.125 } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.weeklyUpdate.measurements.weightKg, 412.75);
  assert.equal(res.body.data.weeklyUpdate.measurements.leftThighCm, 120.125);
});

test('a missing required photo is named; the draft keeps what is there for the retry', async () => {
  await enroll(member, coachA);
  for (const missing of ['front', 'side', 'back']) {
    await WeeklyUpdate.deleteMany({});
    await photos(memberToken, ['front', 'side', 'back'].filter((s) => s !== missing));
    const res = await submit(valid());
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'WEEKLY_UPDATE_INCOMPLETE');
    assert.deepEqual(res.body.error.details.missing, [missing]);
  }
  // The retry: only the missing photo is uploaded again.
  await upload('back', jpeg(9));
  assert.equal((await submit(valid())).status, 201);
});

test('dates: malformed refused, another day closed for writes', async () => {
  await enroll(member, coachA);
  for (const reportDate of ['2026-13-01', '23-10-2026', 'today', 20261023]) {
    assert.equal((await submit({ ...valid(), reportDate })).status, 400, String(reportDate));
  }
  const yesterday = addCalendarDays(today(), -1);
  const closed = await submit({ ...valid(), reportDate: yesterday });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error.code, 'WEEKLY_UPDATE_DAY_CLOSED');
  assert.equal((await upload('front', jpeg(), { date: yesterday })).status, 409);
});

test('ownership and media fields cannot be sent; media are validated by their bytes', async () => {
  const e = await enroll(member, coachA);
  for (const key of ['clientId', 'userId', 'enrollmentId', 'coachId', 'planId', 'profileSnapshot', 'progressMedia']) {
    const res = await submit({ ...valid(), [key]: String(e._id) });
    assert.equal(res.status, 400, key);
  }
  const notAnImage = await upload('front', Buffer.from('definitely not a jpeg'));
  assert.equal(notAnImage.status, 400);
  assert.equal((await upload('passport', jpeg())).status, 400);
});

test('several updates a day (while testing): after a submit, new photos start the next one; a retry returns the same record', async () => {
  await enroll(member, coachA);
  await photos();
  const first = await submit(valid({ submissionId: 'abc-1' }));
  assert.equal(first.status, 201);
  const retry = await submit(valid({ submissionId: 'abc-1' }));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.weeklyUpdate.weeklyUpdateId, first.body.data.weeklyUpdate.weeklyUpdateId);

  // No new photos yet: nothing to submit.
  const early = await submit(valid({ submissionId: 'abc-2' }));
  assert.equal(early.status, 400);
  assert.equal(early.body.error.code, 'WEEKLY_UPDATE_INCOMPLETE');

  await photos();
  const second = await submit(valid({ submissionId: 'abc-2', measurements: { ...VALID, weightKg: 69.8 } }));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.notEqual(second.body.data.weeklyUpdate.weeklyUpdateId, first.body.data.weeklyUpdate.weeklyUpdateId);
  assert.equal(await WeeklyUpdate.countDocuments({ status: 'submitted' }), 2);
  const firstDoc = await WeeklyUpdate.findById(first.body.data.weeklyUpdate.weeklyUpdateId).lean();
  assert.equal(firstDoc.measurements.weightKg, 70.5, 'a submitted update is never changed');
});

test('concurrent submits of one draft make one record', async () => {
  await enroll(member, coachA);
  await photos();
  const results = await Promise.all([submit(valid({ submissionId: 'x' })), submit(valid({ submissionId: 'y' })), submit(valid())]);
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.status === 400).length, 2, 'the others find no draft left');
  assert.equal(await WeeklyUpdate.countDocuments({}), 1);
});

test('history: the member\'s own submitted updates, newest first, paged; one date; never another member\'s', async () => {
  const e = await enroll(member, coachA);
  await enroll(other, coachA);
  const old = (reportDate, clientId = member._id, enrollmentId = e._id, status = 'submitted') =>
    WeeklyUpdate.create({ clientId, enrollmentId, reportDate, timezone: 'Asia/Kolkata', status, measurements: VALID, submittedAt: new Date() });
  await old('2026-10-01');
  await old('2026-10-08');
  await old('2026-10-09', member._id, e._id, 'draft');
  await old('2026-10-15', other._id);

  const page1 = await server.request('GET', `${base}?limit=1`, { token: memberToken });
  assert.equal(page1.status, 200);
  assert.deepEqual(page1.body.data.items.map((i) => i.reportDate), ['2026-10-08']);
  const page2 = await server.request('GET', `${base}?limit=1&cursor=${page1.body.data.nextCursor}`, { token: memberToken });
  assert.deepEqual(page2.body.data.items.map((i) => i.reportDate), ['2026-10-01']);
  assert.equal(page2.body.data.nextCursor, null);

  const one = await server.request('GET', `${base}/2026-10-08`, { token: memberToken });
  assert.equal(one.status, 200);
  assert.equal(one.body.data.weeklyUpdate.reportDate, '2026-10-08');
  const theirs = await server.request('GET', `${base}/2026-10-15`, { token: memberToken });
  assert.equal(theirs.status, 404, 'another member\'s date looks like no record');
  assert.equal((await server.request('GET', `${base}/2026-02-30`, { token: memberToken })).status, 400);
  assert.equal((await server.request('GET', base, {})).status, 401);
});

test('coach: their own enrollment\'s submitted updates; another coach gets 404', async () => {
  const e = await enroll(member, coachA);
  await photos();
  await submit(valid());
  const list = await server.request('GET', `/api/coach/enrollments/${e._id}/weekly-updates`, { token: coachAToken });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.data.items.length, 1);
  const one = await server.request('GET', `/api/coach/enrollments/${e._id}/weekly-updates/${today()}`, { token: coachAToken });
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.data.weeklyUpdate.measurements, VALID);
  const denied = await server.request('GET', `/api/coach/enrollments/${e._id}/weekly-updates`, { token: coachBToken });
  assert.equal(denied.status, 404);
  const asMember = await server.request('GET', `/api/coach/enrollments/${e._id}/weekly-updates`, { token: otherToken });
  assert.equal(asMember.status, 403);
});

test('no plan: nothing to update', async () => {
  const res = await upload('front', jpeg());
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
});

test('a database failure is a safe 500 and leaves nothing half-done', async () => {
  await enroll(member, coachA);
  await photos();
  const original = WeeklyUpdate.findOneAndUpdate;
  WeeklyUpdate.findOneAndUpdate = () => {
    throw new Error('connection reset by peer - secret internals');
  };
  try {
    const res = await submit(valid());
    assert.equal(res.status, 500);
    assert.equal(res.body.error.message, 'Internal server error');
  } finally {
    WeeklyUpdate.findOneAndUpdate = original;
  }
  const doc = await WeeklyUpdate.findOne({ clientId: member._id }).lean();
  assert.equal(doc.status, 'draft', 'still a draft, photos kept, ready for the retry');
  assert.ok(doc.progressMedia.frontPhoto.url);
  assert.equal((await submit(valid())).status, 201);
});

test('coach client-wide: every cycle with this coach, newest first, paged; same-day updates never skipped', async () => {
  const first = await enroll(member, coachA, { enrollDate: new Date('2026-09-01') });
  const second = await enroll(member, coachA, { enrollDate: new Date('2026-10-01') });
  const b = await seedCoach();
  const elsewhere = await enroll(member, b.coach);
  const make = (reportDate, enrollmentId, status = 'submitted', clientId = member._id) =>
    WeeklyUpdate.create({ clientId, enrollmentId, reportDate, timezone: 'Asia/Kolkata', status, measurements: VALID, submittedAt: new Date() });
  await make('2026-09-08', first._id);
  await make('2026-10-08', second._id);
  await make('2026-10-08', second._id);
  await make('2026-10-15', second._id, 'draft');
  await make('2026-10-20', elsewhere._id);
  const otherEnrollment = await enroll(other, coachA);
  await make('2026-10-21', otherEnrollment._id, 'submitted', other._id);

  const url = `/api/coach/clients/${member._id}/weekly-updates`;
  const all = await server.request('GET', url, { token: coachAToken });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.data.items.map((i) => i.reportDate), ['2026-10-08', '2026-10-08', '2026-09-08']);
  assert.ok(all.body.data.items.every((i) => i.status === 'submitted'), 'no drafts');
  assert.ok(all.body.data.items.every((i) => [String(first._id), String(second._id)].includes(i.enrollmentId)), 'only this coach\'s cycles');
  assert.equal(all.body.data.nextCursor, null);

  const seen = [];
  let cursor;
  do {
    const page = await server.request('GET', `${url}?limit=1${cursor ? `&cursor=${cursor}` : ''}`, { token: coachAToken });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    seen.push(...page.body.data.items.map((i) => i.weeklyUpdateId));
    cursor = page.body.data.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, all.body.data.items.map((i) => i.weeklyUpdateId), 'paging returns each update once');
});

test('coach client-wide: not this coach\'s client, bad ids, wrong role and no token are refused', async () => {
  await enroll(member, coachA);
  const url = (userId) => `/api/coach/clients/${userId}/weekly-updates`;
  assert.equal((await server.request('GET', url(member._id), { token: coachBToken })).status, 404);
  assert.equal((await server.request('GET', url(other._id), { token: coachAToken })).status, 404);
  assert.equal((await server.request('GET', url('not-an-id'), { token: coachAToken })).status, 404);
  assert.equal((await server.request('GET', `${url(member._id)}?cursor=bad`, { token: coachAToken })).status, 400);
  assert.equal((await server.request('GET', url(member._id), { token: memberToken })).status, 403);
  assert.equal((await server.request('GET', url(member._id), {})).status, 401);

  const gone = await EnrolledClient.create({ userId: other._id, planId: plan._id, coachId: coachA._id, enrollDate: new Date(), isDeleted: true });
  await WeeklyUpdate.create({ clientId: other._id, enrollmentId: gone._id, reportDate: '2026-10-01', timezone: 'Asia/Kolkata', status: 'submitted', measurements: VALID });
  assert.equal((await server.request('GET', url(other._id), { token: coachAToken })).status, 404, 'a deleted enrollment grants nothing');
});

test('storage keys stay in the database, never in member or coach responses', async () => {
  const e = await enroll(member, coachA);
  await photos();
  await submit(valid());
  const doc = await WeeklyUpdate.findOne({ clientId: member._id }).lean();
  assert.match(doc.progressMedia.frontPhoto.storageKey, new RegExp(`^weekly-updates/${member._id}/`), 'kept for file management');
  for (const [url, token] of [
    [base, memberToken],
    [`${base}/${today()}`, memberToken],
    [`/api/coach/enrollments/${e._id}/weekly-updates`, coachAToken],
    [`/api/coach/clients/${member._id}/weekly-updates`, coachAToken],
  ]) {
    const res = await server.request('GET', url, { token });
    assert.equal(res.status, 200, url);
    assert.doesNotMatch(JSON.stringify(res.body), /storageKey/, url);
  }
});

test('gzip: JSON is compressed when asked for; photos and video are not', async () => {
  const e = await enroll(member, coachA);
  for (const day of ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22']) {
    await WeeklyUpdate.create({ clientId: member._id, enrollmentId: e._id, reportDate: day, timezone: 'Asia/Kolkata', status: 'submitted', measurements: VALID, submittedAt: new Date() });
  }
  const get = (url, encoding) =>
    fetch(`${server.baseUrl}${url}`, {
      headers: { Authorization: `Bearer ${memberToken}`, ...(encoding ? { 'Accept-Encoding': encoding } : {}) },
    });

  const gz = await get(base, 'gzip');
  assert.equal(gz.status, 200);
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.equal((await gz.json()).data.items.length, 4, 'decodes to the same JSON');
  const plain = await get(base, 'identity');
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal((await plain.json()).data.items.length, 4);

  // Photos and video (served from the uploads folder) are left as stored: the
  // middleware's filter refuses types that do not compress.
  const as = (type) => compression.filter({ headers: {} }, { getHeader: () => type });
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'video/mp4']) assert.equal(as(type), false, type);
  assert.equal(as('application/json; charset=utf-8'), true);
});
