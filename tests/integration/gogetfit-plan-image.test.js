import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import jwt from 'jsonwebtoken';

import env from '../../src/config/env.js';
import User from '../../src/models/user.model.js';
import Coach from '../../src/models/coach.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import { resetStorage } from '../../src/services/storage/index.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

const jpeg = (fill = 0x01) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
const png = (fill = 0x02) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, fill)]);

let server;
let uploadRoot;
let adminToken;
let memberToken;
let admin;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles) => {
  seq += 1;
  const phone = `9160000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `U${seq}` }, roles, status: 'active' });
};

const createPlan = async (overrides = {}) =>
  (
    await server.request('POST', '/api/admin/gogetfit-plans', {
      token: adminToken,
      body: {
        name: '12 WEEKS GOGETFIT PLAN',
        planType: 'Enrollment',
        coachLevel: 'LEVEL 1',
        durationWeeks: 12,
        personsAllowed: 1,
        pricing: { basePrice: 4999 },
        content: { description: 'Healthy living.', inclusions: '* a\n* b' },
        ...overrides,
      },
    })
  ).body.data.plan;

const upload = (planId, body, { token = adminToken, contentType = 'image/jpeg' } = {}) =>
  fetch(`${server.baseUrl}/api/admin/gogetfit-plans/${planId}/image`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const removeImage = (planId, token = adminToken) => server.request('DELETE', `/api/admin/gogetfit-plans/${planId}/image`, { token });

const fileExists = async (image) => fs.access(path.join(uploadRoot, image.storageKey)).then(() => true, () => false);

before(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ggf-plan-uploads-'));
  env.storage.localRoot = uploadRoot;
  resetStorage();
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  admin = await seedUser(['user', 'admin']);
  adminToken = tokenFor(admin);
  memberToken = tokenFor(await seedUser(['user']));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

test('1. a plan is created without an image, and the plan write never accepts one', async () => {
  const plan = await createPlan();
  assert.equal(plan.image, null);

  const viaPost = await server.request('POST', '/api/admin/gogetfit-plans', {
    token: adminToken,
    body: { name: 'x', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 1, personsAllowed: 1, pricing: { basePrice: 1 }, image: { url: 'u', storageKey: 'k' } },
  });
  assert.equal(viaPost.status, 400);
  const viaPatch = await server.request('PATCH', `/api/admin/gogetfit-plans/${plan.id}`, { token: adminToken, body: { image: { url: 'u', storageKey: 'k' } } });
  assert.equal(viaPatch.status, 400);
  assert.equal((await GogetfitPlan.findById(plan.id).lean()).image, null);
});

test('2-4. upload stores the file under the plan folder and only the reference in MongoDB', async () => {
  const plan = await createPlan();
  const res = await upload(plan.id, jpeg());
  assert.equal(res.status, 200);

  const { image } = res.body.data.plan;
  assert.match(image.url, new RegExp(`/uploads/gogetfit-plans/${plan.id}/cover/[0-9a-f]{32}\\.jpg$`));
  assert.equal(image.storageKey, `gogetfit-plans/${plan.id}/cover/${image.url.split('/').pop()}`);
  assert.equal(await fileExists(image), true);

  const stored = await GogetfitPlan.findById(plan.id).lean();
  assert.deepEqual(stored.image, image);
  assert.equal(String(stored.updatedBy), String(admin._id));
  // Additive: the business fields are untouched.
  assert.equal(stored.name, '12 WEEKS GOGETFIT PLAN');
  assert.equal(stored.pricing.basePrice, 4999);
  assert.equal(stored.content.inclusions, '* a\n* b');
});

test('5-6. replacing stores the new file first and then removes the old one', async () => {
  const plan = await createPlan();
  const first = (await upload(plan.id, jpeg(0x01))).body.data.plan.image;
  const second = (await upload(plan.id, png(0x02), { contentType: 'image/png' })).body.data.plan.image;

  assert.notEqual(first.url, second.url);
  assert.equal(await fileExists(first), false);
  assert.equal(await fileExists(second), true);
  assert.deepEqual((await GogetfitPlan.findById(plan.id).lean()).image, second);

  // Uploading the identical file again keeps it.
  const again = (await upload(plan.id, png(0x02), { contentType: 'image/png' })).body.data.plan.image;
  assert.equal(again.url, second.url);
  assert.equal(await fileExists(again), true);
});

test('7. removing clears the reference and the file', async () => {
  const plan = await createPlan();
  const image = (await upload(plan.id, jpeg())).body.data.plan.image;

  const res = await removeImage(plan.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.plan.image, null);
  assert.equal((await GogetfitPlan.findById(plan.id).lean()).image, null);
  assert.equal(await fileExists(image), false);
  assert.equal((await removeImage(plan.id)).status, 200); // harmless when empty
});

test('each plan keeps its own image, even for identical bytes', async () => {
  const a = await createPlan({ name: 'A' });
  const b = await createPlan({ name: 'B' });
  const same = jpeg(0x33);
  const imageA = (await upload(a.id, same)).body.data.plan.image;
  const imageB = (await upload(b.id, same)).body.data.plan.image;
  assert.notEqual(imageA.storageKey, imageB.storageKey);

  await removeImage(b.id);
  assert.equal(await fileExists(imageA), true);
  assert.deepEqual((await GogetfitPlan.findById(a.id).lean()).image, imageA);
});

test('8. non-admins and anonymous callers cannot upload or remove', async () => {
  const plan = await createPlan();
  await upload(plan.id, jpeg(0x05));
  for (const token of [memberToken, null]) {
    assert.equal((await upload(plan.id, jpeg(0x06), { token })).status, token ? 403 : 401);
    assert.equal((await removeImage(plan.id, token)).status, token ? 403 : 401);
  }
  assert.notEqual((await GogetfitPlan.findById(plan.id).lean()).image, null);
});

test('9-10. invalid and oversized images are rejected, and nothing is stored', async () => {
  const plan = await createPlan();
  const fake = await upload(plan.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  assert.equal(fake.status, 400);
  assert.equal(fake.body.error.code, 'UNSUPPORTED_IMAGE_TYPE');
  assert.equal((await upload(plan.id, Buffer.from('hi'), { contentType: 'text/plain' })).status, 400);
  assert.equal((await upload(plan.id, Buffer.concat([jpeg(), Buffer.alloc(6 * 1024 * 1024)]))).status, 413);

  assert.equal((await GogetfitPlan.findById(plan.id).lean()).image, null);
  await assert.rejects(fs.access(path.join(uploadRoot, 'gogetfit-plans', plan.id)));
});

test('unknown and malformed plan ids are 404 and store nothing', async () => {
  const res = await upload('64b000000000000000000000', jpeg());
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'GOGETFIT_PLAN_NOT_FOUND');
  assert.equal((await upload('nope', jpeg())).status, 404);
  assert.equal((await removeImage('nope')).status, 404);
  await assert.rejects(fs.access(path.join(uploadRoot, 'gogetfit-plans', '64b000000000000000000000')));
});

test('11-14. archive keeps the image, members never see archived plans, restore brings it back', async () => {
  const user = await seedUser(['user', 'coach']);
  const coach = await Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' }, status: 'active' });
  const plan = await createPlan();
  const other = await createPlan({ name: 'No image plan' });
  const image = (await upload(plan.id, jpeg(0x44))).body.data.plan.image;

  const member = async () => (await server.request('GET', `/api/coaches/${coach._id}/plans`, { token: memberToken })).body.data.plans;

  // 13. The member API returns each plan's own image - and nothing admin-only.
  const listed = await member();
  assert.deepEqual(listed.find((p) => p.id === plan.id).image, image);
  assert.equal(listed.find((p) => p.id === other.id).image, null);
  assert.doesNotMatch(JSON.stringify(listed), /createdBy|updatedBy|legacy|migration|deletedBy|status/);

  // 11. Archiving hides the plan from members but keeps the image file and reference.
  await server.request('DELETE', `/api/admin/gogetfit-plans/${plan.id}`, { token: adminToken });
  assert.deepEqual((await member()).map((p) => p.id), [other.id]);
  assert.deepEqual((await GogetfitPlan.findById(plan.id).lean()).image, image);
  assert.equal(await fileExists(image), true);

  // 12. Restoring brings the plan back with the same image.
  await server.request('PATCH', `/api/admin/gogetfit-plans/${plan.id}`, { token: adminToken, body: { status: 'active' } });
  assert.deepEqual((await member()).find((p) => p.id === plan.id).image, image);
});
