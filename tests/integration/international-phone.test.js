import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import User from '../../src/models/user.model.js';
import { createOrFindUser } from '../../src/services/user.service.js';
import { parsePhone } from '../../src/utils/phone.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  skipOtpCooldown,
  startTestServer,
} from '../helpers/test-server.js';

// International WhatsApp login, Phase 1: { phone, countryIso } on request and
// verify, the parsed phone details stored and returned, old Indian clients
// unchanged, legacy accounts resolving to the same _id, and safe first login.

let server;

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(clearTestDb);

after(async () => {
  await server.close();
  await disconnectTestDb();
});

const requestOtp = (body) => server.request('POST', '/api/auth/request-otp', { body });
const verify = (body) => server.request('POST', '/api/auth/verify-otp', { body });

/** The new app: request with { phone, countryIso }, verify with the e164. */
const loginIntl = async (phone, countryIso) => {
  const requested = await requestOtp({ phone, countryIso });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const verified = await verify({
    phone: requested.body.data.e164,
    otp: requested.body.data.devOtp,
    countryIso,
  });
  return { requested, verified };
};

/** A migrated account as the migration stores it: raw + normalized only. */
const seedLegacyUser = (normalized, raw = normalized, legacyUserId = 1001) =>
  User.create({
    phone: { raw, normalized },
    legacy: { source: 'gogetfit', userId: legacyUserId },
    profile: { name: 'Legacy Member' },
    roles: ['user', 'client'],
    status: 'active',
  });

test('Australia: request returns e164 + formatted; a new account stores every phone field', async () => {
  const { requested, verified } = await loginIntl('+61412345678', 'AU');

  assert.equal(requested.body.data.phone, '61412345678'); // existing field, existing format
  assert.equal(requested.body.data.e164, '+61412345678');
  assert.equal(requested.body.data.formatted, '+61 412 345 678');
  assert.equal(requested.body.data.isNewUser, true);
  assert.ok(requested.body.data.expiresAt);

  assert.equal(verified.status, 201);
  const user = await User.findOne({}).lean();
  assert.deepEqual(user.phone, {
    raw: '+61412345678',
    normalized: '61412345678',
    e164: '+61412345678',
    countryIso: 'AU',
    countryName: 'Australia',
    countryCode: '61',
    formatted: '+61 412 345 678',
  });
  assert.equal(verified.body.data.user.phone, '61412345678');
  assert.deepEqual(verified.body.data.user.phoneDetails, {
    e164: '+61412345678',
    countryIso: 'AU',
    countryName: 'Australia',
    countryCode: '61',
    formatted: '+61 412 345 678',
  });
});

test('Singapore with countryIso is never read as Indian', async () => {
  const { requested, verified } = await loginIntl('91234567', 'SG');
  assert.equal(requested.body.data.phone, '6591234567');
  assert.equal(verified.status, 201);
  const user = await User.findOne({}).lean();
  assert.equal(user.phone.normalized, '6591234567');
  assert.equal(user.phone.countryIso, 'SG');
  assert.equal(await User.countDocuments({ 'phone.normalized': '916591234567' }), 0);
});

test('US, UAE and UK numbers each get their own country', async () => {
  for (const [phone, iso, normalized, name] of [
    ['+14155550123', 'US', '14155550123', 'United States'],
    ['+971501234567', 'AE', '971501234567', 'United Arab Emirates'],
    ['00447400123456', 'GB', '447400123456', 'United Kingdom'],
  ]) {
    const { verified } = await loginIntl(phone, iso);
    assert.equal(verified.status, 201, phone);
    const user = await User.findOne({ 'phone.normalized': normalized }).lean();
    assert.equal(user.phone.countryIso, iso, phone);
    assert.equal(user.phone.countryName, name, phone);
  }
});

test('invalid for the country -> 400 INVALID_PHONE, nothing issued or created', async () => {
  for (const body of [
    { phone: '+6512345678', countryIso: 'SG' },
    { phone: '41234567', countryIso: 'AU' },
    { phone: '+61412345678', countryIso: 'IN' },
    { phone: '9876543210', countryIso: 'XX' },
    { phone: '5555555555' }, // not an Indian range, and no such account
  ]) {
    const response = await requestOtp(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'INVALID_PHONE', JSON.stringify(body));
  }
  const bad = await requestOtp({ phone: '9876543210', countryIso: 'India' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  assert.equal(await User.countDocuments({}), 0);
});

test('old Indian client (10 digits, no countryIso) works exactly as before', async () => {
  const requested = await requestOtp({ phone: '9876543210' });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.data.phone, '919876543210');
  const verified = await verify({ phone: requested.body.data.phone, otp: requested.body.data.devOtp });
  assert.equal(verified.status, 201);
  assert.equal(verified.body.data.user.phone, '919876543210');
  const user = await User.findOne({}).lean();
  assert.equal(user.phone.normalized, '919876543210');
  assert.equal(user.phone.countryIso, 'IN');
  assert.equal(user.phone.countryName, 'India');
});

test('a legacy account is matched (same _id) from old and new clients, and gains its phone details', async () => {
  const legacy = await seedLegacyUser('919876543210', '9876543210');

  // New app.
  const { requested, verified } = await loginIntl('+919876543210', 'IN');
  assert.equal(requested.body.data.isNewUser, false);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.id, String(legacy._id));

  // Old app, 10 digits (a minute later).
  await skipOtpCooldown('919876543210');
  const old = await requestOtp({ phone: '9876543210' });
  const oldVerified = await verify({ phone: '9876543210', otp: old.body.data.devOtp });
  assert.equal(oldVerified.status, 200);
  assert.equal(oldVerified.body.data.user.id, String(legacy._id));

  assert.equal(await User.countDocuments({}), 1);
  const after = await User.findById(legacy._id).lean();
  assert.equal(after.phone.normalized, '919876543210'); // unchanged
  assert.equal(after.phone.raw, '9876543210'); // unchanged
  assert.equal(after.phone.e164, '+919876543210');
  assert.equal(after.phone.countryName, 'India');
  assert.deepEqual(after.roles, ['user', 'client']);
  assert.equal(after.legacy.userId, 1001);
});

test('a legacy foreign account (country code + number, no "+") is matched', async () => {
  const legacy = await seedLegacyUser('61412345678', '61412345678', 1002);
  const { verified } = await loginIntl('+61 412 345 678', 'AU');
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.id, String(legacy._id));
  assert.equal((await User.findById(legacy._id).lean()).phone.countryIso, 'AU');
});

test('a legacy number outside today\'s rules still logs in (old client) and nothing is guessed', async () => {
  const legacy = await seedLegacyUser('915555555555', '5555555555', 1003);
  const requested = await requestOtp({ phone: '5555555555' });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.data.isNewUser, false);
  assert.equal(requested.body.data.formatted, null);
  const verified = await verify({ phone: '5555555555', otp: requested.body.data.devOtp });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.id, String(legacy._id));
  const after = await User.findById(legacy._id).lean();
  assert.equal(after.phone.normalized, '915555555555');
  assert.equal(after.phone.countryIso, undefined);
  assert.equal(after.phone.countryName, undefined);
});

test('details already stored are never overwritten', async () => {
  const legacy = await User.create({
    phone: { raw: '9876543210', normalized: '919876543210', formatted: '+91 98765-43210' },
    profile: {},
    roles: ['user'],
    status: 'active',
  });
  await loginIntl('+919876543210', 'IN');
  const after = await User.findById(legacy._id).lean();
  assert.equal(after.phone.formatted, '+91 98765-43210');
  assert.equal(after.phone.countryIso, 'IN');
});

test('concurrent first logins create exactly one account', async () => {
  const phone = { raw: '+61412345678', ...parsePhone('+61412345678', 'AU') };
  const results = await Promise.all(Array.from({ length: 6 }, () => createOrFindUser(phone)));
  assert.equal(await User.countDocuments({}), 1);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(new Set(results.map((r) => String(r.user._id))).size, 1);
});

test('admin users endpoint shape: phone details via toAdminUser', async () => {
  const { toAdminUser } = await import('../../src/services/admin.service.js');
  await loginIntl('+971501234567', 'AE');
  const user = await User.findOne({}).lean();
  assert.deepEqual(toAdminUser(user).phone, {
    raw: '+971501234567',
    normalized: '971501234567',
    e164: '+971501234567',
    countryIso: 'AE',
    countryName: 'United Arab Emirates',
    countryCode: '971',
    formatted: '+971 50 123 4567',
  });
});
