import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import User from '../../src/models/user.model.js';
import Coupon from '../../src/models/coupon.model.js';
import { setNow } from '../../src/utils/clock.js';
import { calendarDay, getCouponStatus } from '../../src/utils/coupon-status.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/** "Now" is pinned: 1 Oct 2026, 10:00 in India (04:30Z). */
const NOW = new Date('2026-10-01T04:30:00.000Z');
const TODAY = '2026-10-01';
const YESTERDAY = '2026-09-30';
const TOMORROW = '2026-10-02';

let server;
let adminA;
let adminB;
let tokenA;
let tokenB;
let memberToken;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9150000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name, email: `${name.toLowerCase()}@example.com` }, roles, status: 'active' });
};

const body = (overrides = {}) => ({
  code: 'WELCOME20',
  description: 'Welcome offer',
  discount: { type: 'percent', value: 20 },
  validFrom: TODAY,
  validTo: '2026-10-31',
  visibility: 'public',
  ...overrides,
});

const create = (overrides = {}, token = tokenA) => server.request('POST', '/api/admin/coupons', { token, body: body(overrides) });
const patch = (id, payload, token = tokenA) => server.request('PATCH', `/api/admin/coupons/${id}`, { token, body: payload });
const list = (qs = '', token = tokenA) => server.request('GET', `/api/admin/coupons${qs}`, { token });
const get = (id) => server.request('GET', `/api/admin/coupons/${id}`, { token: tokenA });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  setNow(NOW);
  await clearTestDb();
  adminA = await seedUser(['user', 'admin'], 'Asha');
  adminB = await seedUser(['user', 'admin'], 'Vikram');
  tokenA = tokenFor(adminA);
  tokenB = tokenFor(adminB);
  memberToken = tokenFor(await seedUser(['user', 'coach'], 'Member'));
});

afterEach(() => setNow(null));

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// --- The status rule ------------------------------------------------------------

test('getCouponStatus: inclusive calendar days, judged in India time', () => {
  const d = (s) => new Date(`${s}T00:00:00.000Z`);
  assert.equal(calendarDay(NOW).toISOString(), '2026-10-01T00:00:00.000Z');
  // 23:30 UTC on 30 Sep is already 1 Oct in India.
  assert.equal(calendarDay(new Date('2026-09-30T23:30:00Z')).toISOString(), '2026-10-01T00:00:00.000Z');

  assert.equal(getCouponStatus(d(TOMORROW), d('2026-10-31'), NOW), 'inactive'); // 1. starts tomorrow
  assert.equal(getCouponStatus(d(TODAY), d('2026-10-31'), NOW), 'active'); // 2. starts today
  assert.equal(getCouponStatus(d('2026-09-01'), d('2026-10-31'), NOW), 'active'); // 3. inside
  assert.equal(getCouponStatus(d('2026-09-01'), d(TODAY), NOW), 'active'); // 4. last day
  assert.equal(getCouponStatus(d('2026-09-01'), d(YESTERDAY), NOW), 'inactive'); // 5. ended
  assert.equal(getCouponStatus(d(TODAY), d(TODAY), NOW), 'active'); // single day
});

// --- Create ------------------------------------------------------------------------

test('create: code normalised, status from the dates, audit from the token', async () => {
  const res = await create({ code: '  welcome20 ' });
  assert.equal(res.status, 201);
  const { coupon } = res.body.data;
  assert.equal(coupon.code, 'WELCOME20');
  assert.equal(coupon.status, 'active');
  assert.equal(coupon.validFrom, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(coupon.createdBy, { id: String(adminA._id), name: 'Asha', email: 'asha@example.com' });
  assert.deepEqual(coupon.updatedBy, coupon.createdBy);
  const stored = await Coupon.findById(coupon.id).lean();
  assert.ok(stored.validFrom instanceof Date);
  assert.equal(stored.legacy, undefined);
  // 1. No status is stored - only the dates.
  assert.equal('status' in stored, false);

  assert.equal((await create({ code: 'LATER', validFrom: TOMORROW })).body.data.coupon.status, 'inactive');
  assert.equal((await create({ code: 'GONE', validFrom: '2026-09-01', validTo: YESTERDAY })).body.data.coupon.status, 'inactive');
  assert.equal((await create({ code: 'LASTDAY', validFrom: '2026-09-01', validTo: TODAY })).body.data.coupon.status, 'active');
});

test('6. status, audit fields and legacy can never be supplied by the client', async () => {
  for (const extra of [{ status: 'active' }, { status: 'inactive' }, { createdBy: String(adminB._id) }, { updatedBy: String(adminB._id) }, { legacy: { couponId: 1 } }]) {
    assert.equal((await server.request('POST', '/api/admin/coupons', { token: tokenA, body: { ...body(), ...extra } })).status, 400, JSON.stringify(extra));
  }
  const { coupon } = (await create()).body.data;
  assert.equal((await patch(coupon.id, { status: 'inactive' })).status, 400);
  assert.equal('status' in (await Coupon.findById(coupon.id).lean()), false);
  assert.equal(await Coupon.countDocuments(), 1);
});

// --- Codes -----------------------------------------------------------------------------

test('9-10. a code is unique across ALL coupons - active or inactive, any case/spacing', async () => {
  assert.equal((await create()).status, 201);
  for (const code of ['welcome20', ' WELCOME20 ', 'Welcome20']) {
    const dup = await create({ code });
    assert.equal(dup.status, 409, code);
    assert.equal(dup.body.error.code, 'COUPON_CODE_EXISTS');
  }
  // An inactive coupon's code is just as taken.
  assert.equal((await create({ code: 'EXPIRED', validFrom: '2026-01-01', validTo: '2026-01-31' })).status, 201);
  assert.equal((await create({ code: 'expired' })).status, 409);
  // And the database refuses it too.
  await assert.rejects(Coupon.create({ code: 'WELCOME20', discount: { type: 'percent', value: 5 }, validFrom: new Date(), validTo: new Date() }), /E11000/);
  // Renaming onto a taken code is also a 409.
  const { coupon } = (await create({ code: 'OTHER' })).body.data;
  assert.equal((await patch(coupon.id, { code: 'welcome20' })).status, 409);
});

// --- Get / update ----------------------------------------------------------------------

test('get one coupon; malformed and unknown ids are 404', async () => {
  const { coupon } = (await create()).body.data;
  assert.equal((await get(coupon.id)).body.data.coupon.code, 'WELCOME20');
  for (const id of ['nope', new mongoose.Types.ObjectId().toString()]) {
    assert.equal((await get(id)).status, 404);
    assert.equal((await patch(id, { description: 'x' })).status, 404);
  }
});

test('7-8. changing the dates changes the status immediately', async () => {
  const { coupon } = (await create()).body.data;
  const ended = await patch(coupon.id, { validFrom: '2026-09-01', validTo: YESTERDAY });
  assert.equal(ended.body.data.coupon.status, 'inactive');
  assert.equal((await get(coupon.id)).body.data.coupon.status, 'inactive');

  const back = await patch(coupon.id, { validTo: '2026-12-31' });
  assert.equal(back.body.data.coupon.status, 'active');

  const future = await patch(coupon.id, { validFrom: TOMORROW });
  assert.equal(future.body.data.coupon.status, 'inactive');
  // Edits never write a status either.
  assert.equal('status' in (await Coupon.findById(coupon.id).lean()), false);

  // Date order is checked against the stored coupon on a partial edit.
  assert.equal((await patch(coupon.id, { validTo: '2026-01-01' })).status, 400);
});

test('18-19. createdBy is immutable; updatedBy follows real edits', async () => {
  const { coupon } = (await create()).body.data;
  const res = await patch(coupon.id, { code: 'welcome25', discount: { type: 'percent', value: 25 }, visibility: 'private' }, tokenB);
  assert.equal(res.status, 200);
  const updated = res.body.data.coupon;
  assert.equal(updated.code, 'WELCOME25');
  assert.equal(updated.createdBy.id, String(adminA._id));
  assert.equal(updated.updatedBy.id, String(adminB._id));

  assert.equal((await patch(coupon.id, { createdBy: String(adminB._id) })).status, 400);
  assert.equal(String((await Coupon.findById(coupon.id).lean()).createdBy), String(adminA._id));
  assert.equal((await patch(coupon.id, {})).status, 400);
});

test('20. time passing changes the API status but never writes to MongoDB', async () => {
  const { coupon } = (await create({ validTo: TODAY })).body.data;
  const before = await Coupon.findById(coupon.id).lean();
  assert.equal((await get(coupon.id)).body.data.coupon.status, 'active');

  setNow(new Date('2026-10-02T04:30:00.000Z')); // the next day
  const res = await get(coupon.id);
  assert.equal(res.body.data.coupon.status, 'inactive');
  const listed = (await list('?status=inactive')).body.data.coupons.map((c) => c.id);
  assert.deepEqual(listed, [coupon.id]);

  const after = await Coupon.findById(coupon.id).lean();
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  assert.equal(String(after.updatedBy), String(adminA._id));
  // The whole stored document is byte-for-byte what it was, with no status in it.
  assert.deepEqual(after, before);
  assert.equal('status' in after, false);
});

test('a stale status left on an old document is ignored - the dates decide', async () => {
  // A coupon written before status was removed still carries status "active",
  // although it ended last month. The API must not trust it.
  const { insertedId } = await Coupon.collection.insertOne({
    code: 'STALE',
    discount: { type: 'percent', value: 10 },
    validFrom: new Date('2026-08-01T00:00:00Z'),
    validTo: new Date('2026-08-31T00:00:00Z'),
    visibility: 'public',
    status: 'active',
    createdBy: adminA._id,
    updatedBy: adminA._id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal((await get(String(insertedId))).body.data.coupon.status, 'inactive');
  assert.deepEqual((await list('?status=active')).body.data.coupons, []);
  assert.deepEqual((await list('?status=inactive')).body.data.coupons.map((c) => c.code), ['STALE']);
});

test('no scheduler, cron or background job exists for coupons', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const name of ['node-cron', 'cron', 'agenda', 'bull', 'bullmq', 'node-schedule', 'bree']) {
    assert.equal(deps.includes(name), false, name);
  }
  const src = new URL('../../src/', import.meta.url);
  const files = (await readdir(src, { recursive: true })).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const text = await readFile(new URL(file, src), 'utf8');
    if (!/coupon/i.test(text)) continue;
    assert.doesNotMatch(text, /setInterval|node-cron|schedule\(/, file);
  }
});

// --- No archive / restore ----------------------------------------------------------------

test('15-16. there is no archive (DELETE) or restore endpoint, and nothing is deleted', async () => {
  const { coupon } = (await create()).body.data;
  const del = await server.request('DELETE', `/api/admin/coupons/${coupon.id}`, { token: tokenA });
  assert.equal(del.status, 404);
  assert.match(del.body.error.message, /Route not found/);
  const restore = await server.request('PATCH', `/api/admin/coupons/${coupon.id}/restore`, { token: tokenA });
  assert.equal(restore.status, 404);
  assert.equal(await Coupon.countDocuments(), 1);
  assert.equal((await list('?status=archived')).status, 400);
});

// --- Validation, auth -----------------------------------------------------------------------

test('validation: discount, dates (yyyy-mm-dd only), order, visibility, code', async () => {
  const cases = [
    [{ discount: { type: 'flat', value: 100 } }, /discount.type/],
    [{ discount: { type: 'percent', value: '20' } }, /must be a number/],
    [{ discount: { type: 'percent', value: 0 } }, /between 1 and 100/],
    [{ discount: { type: 'percent', value: 101 } }, /between 1 and 100/],
    [{ validFrom: '' }, /validFrom is required/],
    [{ validTo: 'not-a-date' }, /yyyy-mm-dd/],
    [{ validTo: '2026-10-31T10:00:00Z' }, /yyyy-mm-dd/],
    [{ validFrom: '2026-02-30' }, /valid date/],
    [{ validFrom: '2026-11-01', validTo: '2026-10-01' }, /on or before validTo/],
    [{ visibility: 'everyone' }, /visibility must be one of/],
    [{ code: '   ' }, /code is required/],
    [{ code: 'HAS SPACE' }, /only letters/],
    [{ extra: 1 }, /Unknown field/],
  ];
  for (const [overrides, message] of cases) {
    const res = await create(overrides);
    assert.equal(res.status, 400, JSON.stringify(overrides));
    assert.match(res.body.error.message, message);
  }
  assert.equal((await create({ code: 'FREE', discount: { type: 'percent', value: 100 } })).status, 201);
});

test('authentication and the admin role are required on every endpoint', async () => {
  const { coupon } = (await create()).body.data;
  for (const [method, path, payload] of [
    ['GET', '/api/admin/coupons'],
    ['POST', '/api/admin/coupons', body({ code: 'X1' })],
    ['GET', `/api/admin/coupons/${coupon.id}`],
    ['PATCH', `/api/admin/coupons/${coupon.id}`, { description: 'x' }],
  ]) {
    assert.equal((await server.request(method, path, { body: payload })).status, 401, `${method} ${path}`);
    assert.equal((await server.request(method, path, { token: memberToken, body: payload })).status, 403, `${method} ${path}`);
  }
  assert.equal((await Coupon.findById(coupon.id).lean()).description, 'Welcome offer');
});

// --- List -------------------------------------------------------------------------------------

test('11-14. list: active first (nearest expiry), then inactive (latest expiry); status filters', async () => {
  const specs = [
    ['ACT_LONG', '2026-09-01', '2026-12-31', 'public'],
    ['ACT_SOON', '2026-09-15', '2026-10-05', 'private'],
    ['ACT_TODAY', TODAY, TODAY, 'public'],
    ['OLD', '2026-01-01', '2026-01-31', 'public'],
    ['RECENT', '2026-09-01', YESTERDAY, 'private'],
    ['FUTURE', '2026-11-01', '2026-11-30', 'public'],
  ];
  for (const [code, validFrom, validTo, visibility] of specs) {
    assert.equal((await create({ code, validFrom, validTo, visibility, description: code === 'ACT_SOON' ? 'Summer sale' : 'x' })).status, 201, code);
  }

  const codes = async (qs) => (await list(qs)).body.data.coupons.map((c) => c.code);
  // All: active (nearest expiry first), then inactive (latest expiry first).
  assert.deepEqual(await codes(''), ['ACT_TODAY', 'ACT_SOON', 'ACT_LONG', 'FUTURE', 'RECENT', 'OLD']);
  assert.deepEqual(await codes('?status=active'), ['ACT_TODAY', 'ACT_SOON', 'ACT_LONG']);
  assert.deepEqual(await codes('?status=inactive'), ['FUTURE', 'RECENT', 'OLD']);
  assert.ok((await list('?status=inactive')).body.data.coupons.every((c) => c.status === 'inactive'));

  const page1 = await list('?page=1&pageSize=2');
  assert.deepEqual(page1.body.data.pagination, { page: 1, pageSize: 2, total: 6, totalPages: 3 });
  assert.deepEqual(await codes('?page=3&pageSize=2'), ['RECENT', 'OLD']);

  assert.deepEqual(await codes('?search=summer'), ['ACT_SOON']);
  assert.deepEqual(await codes('?visibility=private'), ['ACT_SOON', 'RECENT']);
  // An explicit sort still keeps active before inactive.
  assert.deepEqual(await codes('?sortKey=code&sortDir=asc'), ['ACT_LONG', 'ACT_SOON', 'ACT_TODAY', 'FUTURE', 'OLD', 'RECENT']);

  for (const qs of ['?status=archived', '?visibility=everyone', '?sortKey=password', '?page=0']) {
    assert.equal((await list(qs)).status, 400, qs);
  }
});

// --- Validity and visibility are independent ------------------------------------

/**
 * The four combinations the business rule names. Validity comes from the dates;
 * visibility only decides whether a coupon is listed at checkout. "Private" is
 * not a kind of inactive.
 */
const FOUR = [
  { code: 'ACTIVEPUB', validFrom: YESTERDAY, validTo: TOMORROW, visibility: 'public', status: 'active' },
  { code: 'ACTIVEPRIV', validFrom: YESTERDAY, validTo: TOMORROW, visibility: 'private', status: 'active' },
  { code: 'DONEPUB', validFrom: '2026-09-01', validTo: YESTERDAY, visibility: 'public', status: 'inactive' },
  { code: 'DONEPRIV', validFrom: '2026-09-01', validTo: YESTERDAY, visibility: 'private', status: 'inactive' },
];

const seedFour = async () => {
  for (const { code, validFrom, validTo, visibility } of FOUR) {
    const response = await create({ code, validFrom, validTo, visibility });
    assert.equal(response.status, 201, code);
  }
};

test('1-8. every validity/visibility combination keeps both concepts separate', async () => {
  await seedFour();

  const response = await list('?status=&pageSize=50');
  const byCode = Object.fromEntries(response.body.data.coupons.map((c) => [c.code, c]));

  for (const expected of FOUR) {
    const actual = byCode[expected.code];
    assert.equal(actual.status, expected.status, `${expected.code} status`);
    assert.equal(actual.visibility, expected.visibility, `${expected.code} visibility`);
  }
  // The two that matter most: private is still active, public is still inactive.
  assert.equal(byCode.ACTIVEPRIV.status, 'active', 'private does not mean inactive');
  assert.equal(byCode.DONEPUB.visibility, 'public', 'inactive does not mean private');
});

test('9-10. status is computed per request and exists on no stored document', async () => {
  await seedFour();

  // Not in the raw documents, under any name.
  const raw = await Coupon.collection.find({}).toArray();
  for (const doc of raw) {
    assert.equal(Object.prototype.hasOwnProperty.call(doc, 'status'), false, `${doc.code} has a status field`);
    assert.ok(doc.visibility, `${doc.code} has no visibility`);
  }
  assert.equal(await Coupon.collection.countDocuments({ status: { $exists: true } }), 0);

  // And it follows the clock without anything being written.
  const before = await list('?status=&pageSize=50');
  const beforeUpdatedAt = (await Coupon.findOne({ code: 'ACTIVEPUB' }).lean()).updatedAt;
  assert.equal(before.body.data.coupons.find((c) => c.code === 'ACTIVEPUB').status, 'active');

  setNow(new Date('2026-12-01T04:30:00.000Z'));
  const after = await list('?status=&pageSize=50');
  const afterDoc = await Coupon.findOne({ code: 'ACTIVEPUB' }).lean();

  assert.equal(after.body.data.coupons.find((c) => c.code === 'ACTIVEPUB').status, 'inactive');
  assert.equal(afterDoc.updatedAt.getTime(), beforeUpdatedAt.getTime(), 'time passing wrote nothing');
  assert.equal(Object.prototype.hasOwnProperty.call(afterDoc, 'status'), false);
});

test('11. the status filter is a date query, and ignores visibility', async () => {
  await seedFour();

  const active = await list('?status=active&pageSize=50');
  const inactive = await list('?status=inactive&pageSize=50');

  assert.deepEqual(
    active.body.data.coupons.map((c) => c.code).sort(),
    ['ACTIVEPRIV', 'ACTIVEPUB'],
    'both visibilities appear among the active',
  );
  assert.deepEqual(
    inactive.body.data.coupons.map((c) => c.code).sort(),
    ['DONEPRIV', 'DONEPUB'],
  );
});

test('12. the visibility filter uses visibility, and ignores the dates', async () => {
  await seedFour();

  const pub = await list('?status=&visibility=public&pageSize=50');
  const priv = await list('?status=&visibility=private&pageSize=50');

  assert.deepEqual(pub.body.data.coupons.map((c) => c.code).sort(), ['ACTIVEPUB', 'DONEPUB']);
  assert.deepEqual(priv.body.data.coupons.map((c) => c.code).sort(), ['ACTIVEPRIV', 'DONEPRIV']);
});

test('13. the two filters combine without either overriding the other', async () => {
  await seedFour();

  for (const [status, visibility, expected] of [
    ['active', 'public', ['ACTIVEPUB']],
    ['active', 'private', ['ACTIVEPRIV']],
    ['inactive', 'public', ['DONEPUB']],
    ['inactive', 'private', ['DONEPRIV']],
  ]) {
    const response = await list(`?status=${status}&visibility=${visibility}&pageSize=50`);
    assert.deepEqual(
      response.body.data.coupons.map((c) => c.code),
      expected,
      `${status} + ${visibility}`,
    );
  }
});

test('14-15. the pieces a future apply-by-code needs: valid wins, visibility does not', async () => {
  await seedFour();

  // What "apply by code" will do: find the exact normalised code, then judge the
  // dates. Checkout itself is not implemented here - this proves the data and the
  // status rule already answer it correctly.
  const eligible = async (code) => {
    const doc = await Coupon.findOne({ code: code.trim().toUpperCase() }).lean();
    if (!doc) return { found: false, eligible: false };
    const status = getCouponStatus(doc.validFrom, doc.validTo);
    return { found: true, visibility: doc.visibility, status, eligible: status === 'active' };
  };

  // A valid private coupon is usable by someone who knows the code.
  assert.deepEqual(await eligible(' activepriv '), {
    found: true,
    visibility: 'private',
    status: 'active',
    eligible: true,
  });
  // A valid public coupon likewise.
  assert.equal((await eligible('ACTIVEPUB')).eligible, true);
  // Outside its dates, neither is usable - private or not.
  assert.equal((await eligible('DONEPRIV')).eligible, false);
  assert.equal((await eligible('DONEPUB')).eligible, false);
});

test('a general checkout list would be active AND public only', async () => {
  await seedFour();

  // The future general list is exactly these two filters together, which the API
  // already supports; no new query shape is needed.
  const response = await list('?status=active&visibility=public&pageSize=50');

  assert.deepEqual(response.body.data.coupons.map((c) => c.code), ['ACTIVEPUB']);
});

test('visibility defaults to public and can be flipped either way', async () => {
  const created = await server.request('POST', '/api/admin/coupons', {
    token: tokenA,
    // No visibility supplied at all.
    body: { code: 'NOVIS', discount: { type: 'percent', value: 10 }, validFrom: TODAY, validTo: '2026-10-31' },
  });
  assert.equal(created.body.data.coupon.visibility, 'public');

  const hidden = await patch(created.body.data.coupon.id, { visibility: 'private' });
  const shown = await patch(created.body.data.coupon.id, { visibility: 'public' });

  assert.equal(hidden.body.data.coupon.visibility, 'private');
  assert.equal(hidden.body.data.coupon.status, 'active', 'hiding it does not deactivate it');
  assert.equal(shown.body.data.coupon.visibility, 'public');
});
