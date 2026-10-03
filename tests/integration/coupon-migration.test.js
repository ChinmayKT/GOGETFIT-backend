import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import User from '../../src/models/user.model.js';
import Coupon from '../../src/models/coupon.model.js';
import { CouponCreatorError, loadCoupons, resolveLegacyCouponCreator, verifyCoupons } from '../../migration/loaders/coupon.loader.js';
import { parseLegacyDate, parseLegacyDiscount } from '../../migration/transformers/coupon.transformer.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';
import { setNow } from '../../src/utils/clock.js';

/** Pinned "now": 1 Oct 2024, India time - inside the legacy 2024-25 coupons' windows. */
const NOW = new Date('2024-10-01T04:30:00.000Z');

let server;
let adminToken;
/** The real legacy creator: prajwal@gogetfitonline.com, an existing admin. */
let prajwal;

/** An m_coupon row exactly as mysql2 returns it. */
const row = (overrides = {}) => ({
  coupon_id: 10,
  coupon_name: 'Summer Shredd Offer',
  coupon_code: 'GOGETFIT10',
  description: null,
  discount: '10',
  valid_from: '06/04/2024',
  valid_to: '06/04/2025',
  everyone: '1',
  delete_flg: '0',
  created_by: '123',
  last_update_date: new Date('2024-04-06T10:19:08Z'),
  last_update_by: '123',
  ...overrides,
});

const run = (rows, opts = {}) =>
  loadCoupons(rows, { dryRun: false, runId: 'test-run', source: 'gogetfit', creatorId: prajwal._id, ...opts });

/** Makes a migrated coupon look like it was migrated a while ago (so a later edit is visibly later). */
const ageMigration = async (couponId) => {
  const past = new Date(Date.now() - 60_000);
  await Coupon.collection.updateOne({ 'legacy.couponId': couponId }, { $set: { updatedAt: past, 'migration.migratedAt': past } });
};

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});
afterEach(() => setNow(null));

beforeEach(async () => {
  setNow(NOW);
  await clearTestDb();
  const admin = await User.create({ phone: { raw: '918000000000', normalized: '918000000000' }, profile: { name: 'Admin' }, roles: ['user', 'admin'], status: 'active' });
  adminToken = jwt.sign({ sub: String(admin._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  prajwal = await User.create({
    phone: { raw: '918123260930', normalized: '918123260930' },
    profile: { name: 'Prajwal', email: 'prajwal@gogetfitonline.com' },
    roles: ['user', 'admin'],
    status: 'active',
  });
});
after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('date and discount parsing: strict, as the legacy STR_TO_DATE read them', () => {
  assert.equal(parseLegacyDate('06/04/2024').toISOString(), '2024-04-06T00:00:00.000Z');
  assert.equal(parseLegacyDate(' 4/7/2023 ').toISOString(), '2023-07-04T00:00:00.000Z');
  for (const bad of ['31/02/2024', '2024-04-06', '06-04-2024', '', null, '6/4/24', '32/01/2024']) {
    assert.equal(parseLegacyDate(bad), null, String(bad));
  }
  assert.equal(parseLegacyDiscount('10'), 10);
  assert.equal(parseLegacyDiscount(' 100 '), 100);
  for (const bad of ['99%', '0', '101', 'ten', '', null, '12.5']) assert.equal(parseLegacyDiscount(bad), null, String(bad));
});

test('basic migration, legacy id mapping, status/visibility, audit preservation, creator mapping', async () => {
  const rows = [
    row(),
    row({ coupon_id: 11, coupon_code: ' gogetfitambassador ', discount: '20', everyone: '0', description: 'Influencer', last_update_by: '124' }),
    row({ coupon_id: 3, coupon_code: 'GGFLAUNCH10', delete_flg: '1', valid_from: '04/07/2023', valid_to: '05/10/2023' }),
  ];
  const s = await run(rows);
  assert.equal(s.created, 3);
  // Status by today's date; delete_flg is only counted, never a status.
  assert.deepEqual(s.counts, { active: 2, inactive: 1, deleted: 1, public: 2, private: 1 });

  const a = await Coupon.findOne({ 'legacy.couponId': 10 }).lean();
  assert.equal(a.code, 'GOGETFIT10');
  assert.deepEqual(a.discount, { type: 'percent', value: 10 });
  assert.ok(a.validFrom instanceof Date);
  assert.equal(a.validFrom.toISOString(), '2024-04-06T00:00:00.000Z');
  assert.equal(a.validTo.toISOString(), '2025-04-06T00:00:00.000Z');
  assert.equal('status' in a, false); // never stored - computed from the dates
  assert.equal(a.legacy.deleted, false);
  assert.equal(a.visibility, 'public');
  // Owned by the existing admin who created every legacy coupon...
  assert.equal(String(a.createdBy), String(prajwal._id));
  assert.equal(String(a.updatedBy), String(prajwal._id));
  assert.equal(s.createdByMapped, 3);
  assert.equal(s.updatedByMapped, 3);
  assert.deepEqual(
    { ...a.legacy, auditUpdatedAt: a.legacy.auditUpdatedAt.toISOString() },
    { source: 'gogetfit', couponId: 10, auditCreatedBy: '123', auditUpdatedBy: '123', auditUpdatedAt: '2024-04-06T10:19:08.000Z', deleted: false },
  );
  assert.equal(a.migration.runId, 'test-run');

  const b = await Coupon.findOne({ 'legacy.couponId': 11 }).lean();
  assert.equal(b.code, 'GOGETFITAMBASSADOR'); // same normalisation as the model
  assert.equal(b.visibility, 'private');
  assert.equal(b.legacy.auditUpdatedBy, '124');
  const three = await Coupon.findOne({ 'legacy.couponId': 3 }).lean();
  assert.equal('status' in three, false);
  assert.equal(three.legacy.deleted, true);

  // The id map is keyed by legacy coupon_id and points at the real Mongo ids.
  for (const m of s.idMap) {
    assert.equal(String((await Coupon.findOne({ 'legacy.couponId': m.couponId }).lean())._id), m.mongoId);
  }
});

test('idempotent: a rerun creates nothing and reports every coupon as already migrated', async () => {
  const rows = [row(), row({ coupon_id: 4, coupon_code: 'OTHER', delete_flg: '1' })];
  await run(rows);
  const second = await run(rows, { runId: 'rerun' });
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.alreadyMigrated, 2);
  assert.equal(await Coupon.countDocuments(), 2);
  const v = await verifyCoupons(rows, { source: 'gogetfit', creatorId: prajwal._id });
  assert.deepEqual(v, { migratedInMongo: 2, duplicateLegacyIds: [], problems: [], mismatches: [], portalCouponsWithLegacy: 0 });
});

test('malformed dates and discounts are reported, not inserted; the rest still migrate', async () => {
  const s = await run([
    row({ coupon_id: 20, valid_from: '2024-04-06' }),
    row({ coupon_id: 21, valid_to: '31/02/2024' }),
    row({ coupon_id: 22, discount: '99%' }),
    row({ coupon_id: 23, coupon_code: 'OK' }),
  ]);
  assert.equal(s.created, 1);
  assert.equal(s.malformed.length, 3);
  assert.equal(s.malformedDates, 2);
  assert.equal(s.malformedDiscounts, 1);
  assert.deepEqual(s.malformed.map((m) => m.couponId), [20, 21, 22]);
  assert.match(s.malformed[2].reason, /discount "99%"/);
  assert.deepEqual((await Coupon.find().lean()).map((c) => c.legacy.couponId), [23]);
});

test('the legacy GOGETFIT10 case: the live coupon keeps the code, the deleted one is a reported conflict', async () => {
  const rows = [
    row({ coupon_id: 4, coupon_name: 'New Year Offer', delete_flg: '1', valid_from: '29/12/2023', valid_to: '29/01/2024' }),
    row({ coupon_id: 10 }),
  ];
  const s = await run(rows);
  assert.deepEqual(s.duplicateCodes, [{ code: 'GOGETFIT10', coupons: [{ couponId: 4, deleted: true }, { couponId: 10, deleted: false }] }]);
  assert.equal(s.created, 1);
  assert.equal(s.conflicts.length, 1);
  assert.equal(s.conflicts[0].couponId, 4);
  assert.match(s.conflicts[0].reason, /duplicate code: "GOGETFIT10" is already used by legacy 10/);
  const docs = await Coupon.find({ code: 'GOGETFIT10' }).lean();
  assert.deepEqual(docs.map((d) => d.legacy.couponId), [10]); // nothing merged, deleted or renamed

  // Idempotent: a rerun reports the same conflict and writes nothing.
  const again = await run(rows, { runId: 'again' });
  assert.equal(again.created + again.updated, 0);
  assert.equal(again.conflicts.length, 1);
});

test('two live legacy coupons with one code: the lower id migrates, the other is a reported conflict', async () => {
  const s = await run([row({ coupon_id: 40, coupon_code: 'SAME' }), row({ coupon_id: 41, coupon_code: 'same ' })]);
  assert.equal(s.created, 1);
  assert.equal(s.activeDuplicateConflicts.length, 1);
  assert.equal(s.conflicts[0].couponId, 41);
  assert.match(s.conflicts[0].reason, /duplicate code: "SAME" is already used by legacy 40/);
  assert.deepEqual((await Coupon.find({ code: 'SAME' }).lean()).map((d) => d.legacy.couponId), [40]);

  await Coupon.deleteMany({});
  const dry = await loadCoupons([row({ coupon_id: 40, coupon_code: 'SAME' }), row({ coupon_id: 41, coupon_code: 'SAME' })], { dryRun: true, source: 'gogetfit', creatorId: prajwal._id });
  assert.equal(dry.toCreate, 1);
  assert.equal(dry.activeDuplicateConflicts.length, 1);
});

test('a code already active on a portal coupon is a conflict for the legacy row', async () => {
  const res = await server.request('POST', '/api/admin/coupons', {
    token: adminToken,
    body: { code: 'GOGETFIT10', discount: { type: 'percent', value: 15 }, validFrom: '2026-10-01', validTo: '2026-10-31' },
  });
  assert.equal(res.status, 201);
  const s = await run([row()]);
  assert.equal(s.created, 0);
  assert.match(s.conflicts[0].reason, /duplicate code: "GOGETFIT10" is already used by .*created in the portal/);
  // The portal coupon is untouched and has no legacy object.
  const portal = await Coupon.findById(res.body.data.coupon.id).lean();
  assert.equal(portal.legacy, undefined);
  assert.equal(portal.discount.value, 15);
});

test('an admin edit after migration is a reported conflict and is never overwritten', async () => {
  await run([row()]);
  await ageMigration(10);
  const doc = await Coupon.findOne({ 'legacy.couponId': 10 }).lean();
  const edit = await server.request('PATCH', `/api/admin/coupons/${doc._id}`, { token: adminToken, body: { discount: { type: 'percent', value: 50 } } });
  assert.equal(edit.status, 200);

  const s = await run([row()], { runId: 'after-edit' });
  assert.equal(s.conflicts.length, 1);
  assert.equal(s.conflicts[0].mongoId, String(doc._id));
  assert.match(s.conflicts[0].reason, /edited in the admin portal.*discountValue/);
  assert.equal((await Coupon.findById(doc._id).lean()).discount.value, 50);
  // Portal edits keep the legacy link; createdBy stays the legacy creator,
  // updatedBy is the editing admin - and a rerun does not flip it back.
  const stored = await Coupon.findById(doc._id).lean();
  assert.equal(stored.legacy.couponId, 10);
  assert.equal(String(stored.createdBy), String(prajwal._id));
  assert.notEqual(String(stored.updatedBy), String(prajwal._id));
});

test('an untouched migrated coupon follows a legacy change on rerun', async () => {
  await run([row()]);
  const s = await run([row({ discount: '15' })], { runId: 'r2' });
  assert.equal(s.updated, 1);
  assert.equal((await Coupon.findOne({ 'legacy.couponId': 10 }).lean()).discount.value, 15);
});

test('an admin-created coupon has no legacy object', async () => {
  const res = await server.request('POST', '/api/admin/coupons', {
    token: adminToken,
    body: { code: 'NEWONE', discount: { type: 'percent', value: 5 }, validFrom: '2026-10-01', validTo: '2026-10-02' },
  });
  const stored = await Coupon.findById(res.body.data.coupon.id).lean();
  assert.equal(stored.legacy, undefined);
  assert.equal(stored.migration, undefined);
});

// --- Legacy creator mapping ----------------------------------------------------

test('the creator lookup finds the existing admin by email (case-insensitive) and never creates one', async () => {
  const before = await User.countDocuments();
  const creator = await resolveLegacyCouponCreator('Prajwal@GoGetFitOnline.com');
  assert.equal(String(creator.id), String(prajwal._id));
  assert.ok(creator.roles.includes('admin'));
  assert.equal(await User.countDocuments(), before);
});

test('the migration stops when the creator is missing, duplicated or not an admin', async () => {
  await User.deleteOne({ _id: prajwal._id });
  await assert.rejects(resolveLegacyCouponCreator(), CouponCreatorError);
  await assert.rejects(resolveLegacyCouponCreator(), /No user has the email/);

  const base = { roles: ['user', 'admin'], status: 'active' };
  await User.create({ ...base, phone: { raw: '919000000071', normalized: '919000000071' }, profile: { email: 'prajwal@gogetfitonline.com' } });
  await User.create({ ...base, phone: { raw: '919000000072', normalized: '919000000072' }, profile: { email: 'PRAJWAL@gogetfitonline.com' } });
  await assert.rejects(resolveLegacyCouponCreator(), /2 users have the email/);

  await User.deleteMany({ 'profile.email': /prajwal/i });
  await User.create({ phone: { raw: '919000000073', normalized: '919000000073' }, profile: { email: 'prajwal@gogetfitonline.com' }, roles: ['user'], status: 'active' });
  await assert.rejects(resolveLegacyCouponCreator(), /is not an admin/);

  // No creator -> the loader refuses to write anything.
  await assert.rejects(loadCoupons([row()], { dryRun: false, source: 'gogetfit' }), /creatorId is required/);
  assert.equal(await Coupon.countDocuments(), 0);
});

test('coupons migrated earlier with null owners get the creator filled in, audit values untouched', async () => {
  // As the first run left them: createdBy/updatedBy null.
  await run([row(), row({ coupon_id: 4, coupon_code: 'OTHER4', delete_flg: '1', created_by: '777', last_update_by: '888' })]);
  await Coupon.collection.updateMany({}, { $set: { createdBy: null, updatedBy: null } });
  await Coupon.collection.updateOne({ 'legacy.couponId': 4 }, { $set: { updatedBy: prajwal._id } }); // one already half-mapped

  const s = await run([row(), row({ coupon_id: 4, coupon_code: 'OTHER4', delete_flg: '1', created_by: '777', last_update_by: '888' })], { runId: 'backfill' });
  assert.equal(s.created, 0);
  assert.equal(s.createdByMapped, 2);
  assert.equal(s.updatedByMapped, 1);
  assert.equal(s.alreadyMigrated, 2);
  assert.deepEqual(s.conflicts, []);

  for (const c of await Coupon.find().lean()) {
    assert.equal(String(c.createdBy), String(prajwal._id));
    assert.equal(String(c.updatedBy), String(prajwal._id));
  }
  const four = await Coupon.findOne({ 'legacy.couponId': 4 }).lean();
  assert.equal(four.legacy.auditCreatedBy, '777');
  assert.equal(four.legacy.auditUpdatedBy, '888');

  // Idempotent: a further run maps nothing and changes nothing.
  const again = await run([row(), row({ coupon_id: 4, coupon_code: 'OTHER4', delete_flg: '1', created_by: '777', last_update_by: '888' })], { runId: 'again' });
  assert.equal(again.createdByMapped + again.updatedByMapped + again.created + again.updated, 0);
  assert.equal(await Coupon.countDocuments(), 2);
});

test('a different non-null creator is reported as a conflict, never replaced', async () => {
  await run([row()]);
  const other = await User.create({ phone: { raw: '919000000081', normalized: '919000000081' }, profile: { name: 'Other' }, roles: ['user', 'admin'], status: 'active' });
  await Coupon.collection.updateOne({ 'legacy.couponId': 10 }, { $set: { createdBy: other._id } });

  const s = await run([row()], { runId: 'conflict' });
  assert.equal(s.conflicts.length, 1);
  assert.match(s.conflicts[0].reason, new RegExp(`createdBy is ${other._id}.*not replaced`));
  assert.equal(String((await Coupon.findOne({ 'legacy.couponId': 10 }).lean()).createdBy), String(other._id));
});

test('portal-created coupons still use the authenticated admin, not the legacy creator', async () => {
  const res = await server.request('POST', '/api/admin/coupons', {
    token: adminToken,
    body: { code: 'PORTAL1', discount: { type: 'percent', value: 5 }, validFrom: '2026-10-01', validTo: '2026-10-02' },
  });
  const stored = await Coupon.findById(res.body.data.coupon.id).lean();
  assert.notEqual(String(stored.createdBy), String(prajwal._id));
  assert.equal(String(stored.createdBy), jwt.decode(adminToken).sub);
  assert.equal(stored.legacy, undefined);
});


// --- everyone -> visibility, and nothing -> status ------------------------------

test('3-4. legacy everyone decides visibility, and only visibility', async () => {
  const summary = await run([
    row({ coupon_id: 101, coupon_code: 'EVERYONEYES', everyone: '1', delete_flg: '0' }),
    row({ coupon_id: 102, coupon_code: 'EVERYONENO', everyone: '0', delete_flg: '0' }),
    // A blank or unexpected flag is not "everyone", so it is private.
    row({ coupon_id: 103, coupon_code: 'EVERYONEBLANK', everyone: '', delete_flg: '0' }),
  ]);

  const yes = await Coupon.findOne({ 'legacy.couponId': 101 }).lean();
  const no = await Coupon.findOne({ 'legacy.couponId': 102 }).lean();
  const blank = await Coupon.findOne({ 'legacy.couponId': 103 }).lean();

  assert.equal(summary.errors.length, 0);
  assert.equal(yes.visibility, 'public');
  assert.equal(no.visibility, 'private');
  assert.equal(blank.visibility, 'private');

  // No status is written for any of them - the dates decide at read time.
  for (const doc of [yes, no, blank]) {
    assert.equal(Object.prototype.hasOwnProperty.call(doc, 'status'), false, doc.code);
  }
});

test('delete_flg is history only - it never becomes visibility or a status', async () => {
  await run([
    row({ coupon_id: 104, coupon_code: 'DELETEDPUBLIC', everyone: '1', delete_flg: '1' }),
    row({ coupon_id: 105, coupon_code: 'LIVEPRIVATE', everyone: '0', delete_flg: '0' }),
  ]);

  const deleted = await Coupon.findOne({ 'legacy.couponId': 104 }).lean();
  const live = await Coupon.findOne({ 'legacy.couponId': 105 }).lean();

  // A legacy-deleted coupon that was visible to everyone stays public: the flag
  // is recorded as history, not folded into visibility or an invented status.
  assert.equal(deleted.legacy.deleted, true);
  assert.equal(deleted.visibility, 'public');
  assert.equal(Object.prototype.hasOwnProperty.call(deleted, 'status'), false);
  assert.equal(live.legacy.deleted, false);
  assert.equal(live.visibility, 'private');
});
