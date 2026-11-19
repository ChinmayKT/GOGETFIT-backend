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
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * Coach certifications: admin-only writes (image or PDF file + details), kept
 * beside the profile so a profile edit never touches them, files stored by the
 * storage service (never in the document), and only the public details on the
 * member coach reads - each coach's own.
 */
const jpeg = (fill = 0x01) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
const pdf = (fill = 'a') => Buffer.from(`%PDF-1.4\n${fill.repeat(64)}\n%%EOF`);

let server;
let uploadRoot;
let adminToken;
let memberToken;
let coachUser;
let coachId;
let otherCoachId;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const seedUser = (phone, roles) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `User ${phone}` }, roles, status: 'active' });

const raw = (method, url, body, { token = adminToken, contentType = 'image/jpeg' } = {}) =>
  fetch(`${server.baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));

const add = (details, body = jpeg(), opts = {}) =>
  raw('POST', `/api/admin/coaches/${opts.id ?? coachId}/certifications?${new URLSearchParams(details)}`, body, opts);
const replace = (certId, body, opts = {}) => raw('PUT', `/api/admin/coaches/${coachId}/certifications/${certId}/file`, body, opts);
const edit = (certId, body, token = adminToken) =>
  server.request('PATCH', `/api/admin/coaches/${coachId}/certifications/${certId}`, { token, body });
const remove = (certId, token = adminToken) =>
  server.request('DELETE', `/api/admin/coaches/${coachId}/certifications/${certId}`, { token });

const exists = async (storageKey) => fs.access(path.join(uploadRoot, storageKey)).then(() => true, () => false);
const stored = () => Coach.findById(coachId).lean();

before(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ggf-coach-certs-'));
  env.storage.localRoot = uploadRoot;
  resetStorage();
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  adminToken = tokenFor(await seedUser('918000000000', ['user', 'admin']));
  memberToken = tokenFor(await seedUser('918000000009', ['user', 'client']));
  coachUser = await seedUser('919876543210', ['user']);
  const other = await seedUser('919876543211', ['user']);
  const create = (u) =>
    server.request('POST', '/api/admin/coaches', { token: adminToken, body: { userId: String(u._id), profile: { level: 'LEVEL 1', monthlySlots: 10 } } });
  coachId = (await create(coachUser)).body.data.coach.id;
  otherCoachId = (await create(other)).body.data.coach.id;
});

after(async () => {
  await server.close();
  await disconnectTestDb();
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

test('a coach starts with no certifications - admin and member reads say so', async () => {
  const admin = await server.request('GET', `/api/admin/coaches/${coachId}`, { token: adminToken });
  assert.deepEqual(admin.body.data.coach.certifications, []);
  const member = await server.request('GET', `/api/coaches/${coachId}`, { token: memberToken });
  assert.deepEqual(member.body.data.coach.certifications, []);
});

test('several certifications, image and PDF: stored as files, referenced in the document', async () => {
  const a = await add({ name: 'ISSA Certified Trainer', issuer: 'ISSA', issueDate: '2023-04-01', expiryDate: '2026-04-01' }, jpeg());
  assert.equal(a.status, 201);
  const b = await add({ name: 'Nutrition Coach' }, pdf(), { contentType: 'application/pdf' });
  assert.equal(b.status, 201);

  const certs = b.body.data.coach.certifications;
  assert.equal(certs.length, 2);
  assert.deepEqual(
    certs.map(({ name, issuer, issueDate, expiryDate, file }) => ({ name, issuer, issueDate, expiryDate, type: file.type, mime: file.mimeType })),
    [
      { name: 'ISSA Certified Trainer', issuer: 'ISSA', issueDate: '2023-04-01', expiryDate: '2026-04-01', type: 'image', mime: 'image/jpeg' },
      { name: 'Nutrition Coach', issuer: null, issueDate: null, expiryDate: null, type: 'pdf', mime: 'application/pdf' },
    ],
  );
  assert.ok(certs.every((c) => c.id && c.uploadedAt));
  assert.match(certs[1].file.url, /coaches\/.+\/certifications\/[0-9a-f]+\.pdf$/);
  for (const c of certs) assert.ok(await exists(c.file.storageKey), 'file stored');
  // Only references in MongoDB, never bytes.
  const doc = await stored();
  assert.ok(doc.certifications.every((c) => typeof c.file.url === 'string' && !Buffer.isBuffer(c.file)));
});

test('editing the coach profile keeps the certifications untouched', async () => {
  await add({ name: 'ISSA' });
  const before = (await stored()).certifications;
  const res = await server.request('PATCH', `/api/admin/coaches/${coachId}`, {
    token: adminToken,
    body: { profile: { specialization: 'Strength', description: 'New bio' }, status: 'active' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await stored()).certifications, before);
  assert.equal(res.body.data.coach.certifications.length, 1);
});

test('details are edited in place; the file stays', async () => {
  const cert = (await add({ name: 'ISSA', issuer: 'ISSA', issueDate: '2023-01-01' })).body.data.coach.certifications[0];
  const res = await edit(cert.id, { name: 'ISSA Elite', issuer: '', expiryDate: '2027-01-01' });
  assert.equal(res.status, 200);
  const after = res.body.data.coach.certifications[0];
  assert.deepEqual(
    { name: after.name, issuer: after.issuer, issueDate: after.issueDate, expiryDate: after.expiryDate, url: after.file.url },
    { name: 'ISSA Elite', issuer: null, issueDate: '2023-01-01', expiryDate: '2027-01-01', url: cert.file.url },
  );
  // An expiry before the stored issue date is refused.
  assert.equal((await edit(cert.id, { expiryDate: '2022-01-01' })).status, 400);
  assert.equal((await edit(cert.id, {})).status, 400, 'nothing to change');
});

test('replacing a file: new file kept, old one removed, details unchanged', async () => {
  const cert = (await add({ name: 'ISSA' }, jpeg(0x01))).body.data.coach.certifications[0];
  const res = await replace(cert.id, pdf(), { contentType: 'application/pdf' });
  assert.equal(res.status, 200);
  const after = res.body.data.coach.certifications[0];
  assert.equal(after.id, cert.id);
  assert.equal(after.name, 'ISSA');
  assert.equal(after.file.type, 'pdf');
  assert.ok(await exists(after.file.storageKey));
  assert.equal(await exists(cert.file.storageKey), false, 'the replaced file is not orphaned');
});

test('deleting one certification keeps the others; a file still used by another stays', async () => {
  const same = jpeg(0x07);
  await add({ name: 'One' }, same);
  await add({ name: 'Two' }, same); // the same file: one stored file, two uses
  const three = await add({ name: 'Three' }, pdf(), { contentType: 'application/pdf' });
  const [one, two, third] = three.body.data.coach.certifications;
  assert.equal(one.file.url, two.file.url);

  const res = await remove(one.id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.coach.certifications.map((c) => c.name), ['Two', 'Three']);
  assert.ok(await exists(two.file.storageKey), 'still used by Two');

  await remove(two.id);
  assert.equal(await exists(two.file.storageKey), false, 'gone once unused');
  assert.ok(await exists(third.file.storageKey));
  assert.equal((await remove(two.id)).status, 404, 'already deleted');
});

test('invalid input is refused and stores nothing', async () => {
  const count = async () => (await fs.readdir(uploadRoot, { recursive: true })).filter((f) => /\.(jpg|png|webp|pdf)$/.test(f)).length;
  const files = await count();

  assert.equal((await add({ issuer: 'ISSA' })).status, 400, 'name required');
  assert.equal((await add({ name: 'X', issueDate: '2024-02-30' })).status, 400, 'a real date');
  assert.equal((await add({ name: 'X', issueDate: '2024-02-01', expiryDate: '2024-01-01' })).status, 400, 'expiry before issue');
  assert.equal((await add({ name: 'X' }, Buffer.alloc(0))).status, 400, 'no file');
  // Bytes decide, not the declared type: text labelled as a PDF, an exe labelled as an image.
  const fake = await add({ name: 'X' }, Buffer.from('just some text, not a pdf at all'), { contentType: 'application/pdf' });
  assert.equal(fake.status, 400);
  assert.equal(fake.body.error?.code ?? fake.body.code, 'UNSUPPORTED_FILE_TYPE');
  assert.equal((await add({ name: 'X' }, Buffer.from('MZ\x90\x00 binary'), { contentType: 'image/jpeg' })).status, 400);
  // A content type outside the accepted list never reaches the service.
  assert.notEqual((await add({ name: 'X' }, jpeg(), { contentType: 'text/plain' })).status, 201);
  // Oversized.
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(env.storage.maxUploadBytes + 10, 0x20)]);
  assert.equal((await add({ name: 'X' }, big, { contentType: 'application/pdf' })).status, 413);

  assert.equal(await count(), files);
  assert.deepEqual((await stored()).certifications, []);
});

test('only an admin can write; ids are checked', async () => {
  const cert = (await add({ name: 'ISSA' })).body.data.coach.certifications[0];
  const coachToken = tokenFor(coachUser);
  assert.equal((await add({ name: 'X' }, jpeg(), { token: coachToken })).status, 403, 'not even the coach');
  assert.equal((await add({ name: 'X' }, jpeg(), { token: memberToken })).status, 403);
  assert.equal((await add({ name: 'X' }, jpeg(), { token: null })).status, 401);
  assert.equal((await edit(cert.id, { name: 'Y' }, memberToken)).status, 403);
  assert.equal((await remove(cert.id, coachToken)).status, 403);
  assert.equal((await replace(cert.id, jpeg(), { token: memberToken })).status, 403);

  assert.equal((await add({ name: 'X' }, jpeg(), { id: '64b000000000000000000000' })).status, 404, 'no such coach');
  assert.equal((await edit('64b000000000000000000000', { name: 'Y' })).status, 404, 'no such certification');
  assert.equal((await edit('not-an-id', { name: 'Y' })).status, 404);
  // Another coach's certification id does not reach this coach's.
  const theirs = (await add({ name: 'Theirs' }, jpeg(0x09), { id: otherCoachId })).body.data.coach.certifications[0];
  assert.equal((await remove(theirs.id)).status, 404);
  assert.equal((await Coach.findById(otherCoachId).lean()).certifications.length, 1);
});

test('the member coach reads show each coach its own certifications - details, URL and type only', async () => {
  await add({ name: 'ISSA', issuer: 'ISSA', issueDate: '2023-04-01' });
  await add({ name: 'Other coach cert' }, jpeg(0x05), { id: otherCoachId });

  const one = (await server.request('GET', `/api/coaches/${coachId}`, { token: memberToken })).body.data.coach;
  assert.equal(one.certifications.length, 1);
  const [c] = one.certifications;
  assert.deepEqual(Object.keys(c).sort(), ['expiryDate', 'fileType', 'fileUrl', 'id', 'issueDate', 'issuer', 'name']);
  assert.deepEqual({ name: c.name, issuer: c.issuer, issueDate: c.issueDate, fileType: c.fileType }, { name: 'ISSA', issuer: 'ISSA', issueDate: '2023-04-01', fileType: 'image' });

  const list = (await server.request('GET', '/api/coaches', { token: memberToken })).body.data.coaches;
  const byId = Object.fromEntries(list.map((x) => [x.id, x.certifications.map((k) => k.name)]));
  assert.deepEqual(byId[coachId], ['ISSA']);
  assert.deepEqual(byId[otherCoachId], ['Other coach cert']);
});

test('a coach stored before certifications existed reads as none and can get one', async () => {
  await Coach.collection.updateOne({ _id: Coach.castObject({ _id: coachId })._id }, { $unset: { certifications: '' } });
  const admin = await server.request('GET', `/api/admin/coaches/${coachId}`, { token: adminToken });
  assert.deepEqual(admin.body.data.coach.certifications, []);
  const res = await add({ name: 'ISSA' });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.coach.certifications.length, 1);
});
