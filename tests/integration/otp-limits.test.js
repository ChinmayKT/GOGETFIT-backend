import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import env from '../../src/config/env.js';
import Otp from '../../src/models/otp.model.js';
import OtpLimit from '../../src/models/otp-limit.model.js';
import { requestOtp as requestOtpService } from '../../src/services/auth.service.js';
import {
  OtpDeliveryRejectedError,
  setOtpDeliveryProvider,
} from '../../src/services/otp-delivery.service.js';
import { consumeIpRequest, reservePhoneRequest } from '../../src/services/otp-limit.service.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  skipOtpCooldown,
  startTestServer,
} from '../helpers/test-server.js';

// Phase 2: 3 OTP requests per phone per UTC day, 60 s resend cooldown, 5 min
// validity, 5 wrong attempts per code, 20 requests per IP per hour - all in
// MongoDB, atomic, charged only once the provider accepts (or may have).

let server;
let provider;
let saved;

/** A fake WhatsApp provider: records what it was asked to send. */
const fakeProvider = (behaviour = async () => ({ messageId: `fake-${Date.now()}` })) => ({
  name: 'fake',
  sent: [],
  async send(message) {
    this.sent.push(message);
    return behaviour(message);
  },
});

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  saved = { ...env.otp };
  provider = fakeProvider();
  setOtpDeliveryProvider(provider);
});

afterEach(() => {
  Object.assign(env.otp, saved);
  setOtpDeliveryProvider(null);
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

const request = (body) => server.request('POST', '/api/auth/request-otp', { body });
const verify = (body) => server.request('POST', '/api/auth/verify-otp', { body });
const phoneDoc = (normalized) => OtpLimit.findById(`phone:${normalized}`).lean();

test('3 requests per phone per day; the 4th is 429 OTP_DAILY_LIMIT_REACHED with the wait', async () => {
  for (let i = 0; i < 3; i++) {
    const ok = await request({ phone: '+61412345678', countryIso: 'AU' });
    assert.equal(ok.status, 200, `request ${i + 1}`);
    await skipOtpCooldown('61412345678');
  }
  const refused = await request({ phone: '+61412345678', countryIso: 'AU' });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, 'OTP_DAILY_LIMIT_REACHED');
  assert.equal(refused.body.error.details.limit, 3);
  const wait = refused.body.error.details.retryAfterSeconds;
  assert.ok(wait > 0 && wait <= 86400, String(wait));
  assert.equal(refused.headers['retry-after'], String(wait));
  assert.equal(provider.sent.length, 3, 'nothing sent once the limit is reached');
});

test('the limit is per phone identity: other spellings, devices and IPs share it', async () => {
  for (const body of [
    { phone: '9876543210' }, // old app
    { phone: '+919876543210', countryIso: 'IN' }, // new app
    { phone: '0091 98765 43210' },
  ]) {
    assert.equal((await request(body)).status, 200, JSON.stringify(body));
    await skipOtpCooldown('919876543210');
  }
  const refused = await request({ phone: '98765 43210', countryIso: 'IN' });
  assert.equal(refused.body.error.code, 'OTP_DAILY_LIMIT_REACHED');
  // Another number is unaffected.
  assert.equal((await request({ phone: '9876543211' })).status, 200);
});

test('a resend within 60 s is 429 OTP_RESEND_COOLDOWN with the seconds left', async () => {
  assert.equal((await request({ phone: '+6591234567', countryIso: 'SG' })).status, 200);
  const early = await request({ phone: '+6591234567', countryIso: 'SG' });
  assert.equal(early.status, 429);
  assert.equal(early.body.error.code, 'OTP_RESEND_COOLDOWN');
  const left = early.body.error.details.retryAfterSeconds;
  assert.ok(left >= 58 && left <= 60, String(left));
  assert.equal((await phoneDoc('6591234567')).count, 1, 'a refused resend is not charged');
});

test('cooldown and daily reset against the clock', async () => {
  const t0 = new Date('2026-11-20T23:57:00Z');
  const at = (s) => new Date(t0.getTime() + s * 1000);
  await reservePhoneRequest('14155550123', at(0));
  await assert.rejects(reservePhoneRequest('14155550123', at(59)), { code: 'OTP_RESEND_COOLDOWN' });
  await reservePhoneRequest('14155550123', at(60));
  await reservePhoneRequest('14155550123', at(120));
  await assert.rejects(reservePhoneRequest('14155550123', at(150)), (error) => {
    assert.equal(error.code, 'OTP_DAILY_LIMIT_REACHED');
    assert.equal(error.details.retryAfterSeconds, 30); // to 00:00 UTC
    return true;
  });
  // A new UTC day: a fresh allowance (count starts again at 1).
  await reservePhoneRequest('14155550123', at(181));
  const doc = await phoneDoc('14155550123');
  assert.equal(doc.day, '2026-11-21');
  assert.equal(doc.count, 1);
});

test('concurrent requests cannot exceed the daily limit', async () => {
  env.otp.resendCooldownSeconds = 0; // isolate the daily limit
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => request({ phone: '+971501234567', countryIso: 'AE' })),
  );
  const statuses = responses.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, 3, statuses.join(','));
  assert.ok(
    responses.filter((r) => r.status === 429).every((r) => r.body.error.code === 'OTP_DAILY_LIMIT_REACHED'),
  );
  assert.equal((await phoneDoc('971501234567')).count, 3);
  assert.equal(provider.sent.length, 3);
});

test('concurrent requests inside the cooldown: exactly one goes out', async () => {
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => request({ phone: '+447400123456', countryIso: 'GB' })),
  );
  assert.equal(responses.filter((r) => r.status === 200).length, 1);
  assert.equal(responses.filter((r) => r.body.error?.code === 'OTP_RESEND_COOLDOWN').length, 7);
  assert.equal(provider.sent.length, 1);
});

test('20 requests per IP per hour; the 21st is 429 TOO_MANY_REQUESTS', async () => {
  for (let i = 0; i < 20; i++) {
    const r = await request({ phone: `98765432${String(i).padStart(2, '0')}` });
    assert.equal(r.status, 200, `request ${i + 1}`);
  }
  const refused = await request({ phone: '9876543299' });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, 'TOO_MANY_REQUESTS');
  assert.ok(refused.body.error.details.retryAfterSeconds <= 3600);
  assert.equal(provider.sent.length, 20);
});

test('the IP window is the UTC clock hour', async () => {
  const t = new Date('2026-11-20T10:59:00Z');
  for (let i = 0; i < 20; i++) await consumeIpRequest('203.0.113.7', t);
  await assert.rejects(consumeIpRequest('203.0.113.7', t), (error) => {
    assert.equal(error.code, 'TOO_MANY_REQUESTS');
    assert.equal(error.details.retryAfterSeconds, 60);
    return true;
  });
  await consumeIpRequest('203.0.113.8', t); // another address is unaffected
  await consumeIpRequest('203.0.113.7', new Date('2026-11-20T11:00:01Z')); // next hour
});

test('provider accepted: the code is stored as accepted, sent to the E.164 number, valid 5 minutes', async () => {
  const before = Date.now();
  const r = await request({ phone: '412 345 678', countryIso: 'AU' });
  assert.equal(r.status, 200);
  assert.equal(provider.sent[0].e164, '+61412345678');
  assert.equal(provider.sent[0].code, r.body.data.devOtp);
  const otp = await Otp.findOne({}).lean();
  assert.equal(otp.deliveryStatus, 'accepted');
  assert.equal(otp.channel, 'fake');
  assert.match(otp.providerMessageId, /^fake-/);
  const ttl = (new Date(r.body.data.expiresAt).getTime() - before) / 1000;
  assert.ok(ttl > 295 && ttl <= 301, String(ttl));
});

test('provider rejected: 502, no code kept, nothing charged, no cooldown', async () => {
  await request({ phone: '+6591234567', countryIso: 'SG' });
  await skipOtpCooldown('6591234567');
  const countBefore = (await phoneDoc('6591234567')).count;

  provider = fakeProvider(async () => {
    throw new OtpDeliveryRejectedError('invalid recipient');
  });
  setOtpDeliveryProvider(provider);
  const failed = await request({ phone: '+6591234567', countryIso: 'SG' });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, 'OTP_DELIVERY_FAILED');
  assert.equal(await Otp.countDocuments({ deliveryStatus: 'pending' }), 0);
  assert.equal((await phoneDoc('6591234567')).count, countBefore, 'not charged');

  // No cooldown was started by the failure either.
  setOtpDeliveryProvider(fakeProvider());
  const retry = await request({ phone: '+6591234567', countryIso: 'SG' });
  assert.equal(retry.status, 200);
  const ok = await verify({ phone: '+6591234567', otp: retry.body.data.devOtp, countryIso: 'SG' });
  assert.equal(ok.status, 201);
});

test('a rejected resend leaves the previous code usable', async () => {
  const first = await request({ phone: '9876543210' });
  await skipOtpCooldown('919876543210');
  setOtpDeliveryProvider(
    fakeProvider(async () => {
      throw new OtpDeliveryRejectedError('provider down');
    }),
  );
  assert.equal((await request({ phone: '9876543210' })).status, 502);
  const ok = await verify({ phone: '9876543210', otp: first.body.data.devOtp });
  assert.equal(ok.status, 201);
});

test('provider timeout (uncertain): 200, the code stays valid and the request is charged', async () => {
  env.otp.deliveryTimeoutMs = 50;
  setOtpDeliveryProvider(fakeProvider(() => new Promise(() => {}))); // never answers
  const r = await request({ phone: '+14155550123', countryIso: 'US' });
  assert.equal(r.status, 200);
  const otp = await Otp.findOne({}).lean();
  assert.equal(otp.deliveryStatus, 'uncertain');
  assert.equal((await phoneDoc('14155550123')).count, 1);
  // No free immediate retry (it may already be on the phone).
  assert.equal((await request({ phone: '+14155550123', countryIso: 'US' })).body.error.code, 'OTP_RESEND_COOLDOWN');
  const ok = await verify({ phone: '+14155550123', otp: r.body.data.devOtp, countryIso: 'US' });
  assert.equal(ok.status, 201);
});

test('an unexpected provider error is treated as uncertain (charged, code kept)', async () => {
  setOtpDeliveryProvider(
    fakeProvider(async () => {
      throw new Error('socket hang up');
    }),
  );
  const r = await request({ phone: '+971501234567', countryIso: 'AE' });
  assert.equal(r.status, 200);
  assert.equal((await Otp.findOne({}).lean()).deliveryStatus, 'uncertain');
  assert.equal((await phoneDoc('971501234567')).count, 1);
});

test('a code still being delivered (pending) cannot be verified', async () => {
  let finish;
  setOtpDeliveryProvider(fakeProvider(() => new Promise((resolve) => (finish = resolve))));
  const pending = request({ phone: '9876543210' });
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 5));
  const otp = await Otp.findOne({}).lean();
  assert.equal(otp.deliveryStatus, 'pending');
  const early = await verify({ phone: '9876543210', otp: '0000' });
  assert.equal(early.body.error.code, 'OTP_NOT_FOUND');
  finish({ messageId: 'late' });
  assert.equal((await pending).status, 200);
});

test('5 wrong codes burn the challenge; the right code then fails too', async () => {
  const r = await request({ phone: '9876543210' });
  const wrong = r.body.data.devOtp === '1111' ? '2222' : '1111';
  for (let i = 0; i < 5; i++) {
    assert.equal((await verify({ phone: '9876543210', otp: wrong })).body.error.code, 'OTP_INVALID');
  }
  const locked = await verify({ phone: '9876543210', otp: r.body.data.devOtp });
  assert.equal(locked.body.error.code, 'OTP_ATTEMPTS_EXCEEDED');
});

test('refusals before sending (invalid number, unknown account when closed) cost no phone quota', async () => {
  assert.equal((await request({ phone: '+6512345678', countryIso: 'SG' })).status, 400);
  assert.equal(await phoneDoc('6512345678'), null);

  const open = env.allowNewRegistrations;
  env.allowNewRegistrations = false;
  try {
    assert.equal((await request({ phone: '9876543210' })).status, 404);
  } finally {
    env.allowNewRegistrations = open;
  }
  assert.equal(await phoneDoc('919876543210'), null);
  assert.equal(provider.sent.length, 0);
});

test('the service enforces the limits without HTTP (shared by every process)', async () => {
  env.otp.resendCooldownSeconds = 0;
  for (let i = 0; i < 3; i++) await requestOtpService('+61412345678', 'AU', { ip: '10.0.0.1' });
  await assert.rejects(requestOtpService('+61412345678', 'AU', { ip: '10.0.0.2' }), {
    code: 'OTP_DAILY_LIMIT_REACHED',
  });
});
