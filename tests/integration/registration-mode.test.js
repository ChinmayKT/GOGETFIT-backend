/**
 * Verifies the migration-only business mode. The switch is read when the config
 * module is first evaluated, so this file sets it before importing anything
 * that depends on it and therefore keeps its own dynamic imports.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ALLOW_NEW_REGISTRATIONS = 'false';

const [{ default: mongoose }, { default: User }, { default: Otp }] = await Promise.all([
  import('mongoose'),
  import('../../src/models/user.model.js'),
  import('../../src/models/otp.model.js'),
]);
const { default: app } = await import('../../src/app.js');
const { default: env } = await import('../../src/config/env.js');

const http = await import('node:http');

let server;
let baseUrl;

const request = async (method, path, body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

before(async () => {
  assert.equal(env.allowNewRegistrations, false, 'this suite requires migration-only mode');

  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'gogetfit_test' });
  await Promise.all([User.syncIndexes(), Otp.syncIndexes()]);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Otp.deleteMany({})]);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.close();
});

test('an unknown phone is refused with USER_NOT_FOUND and gets no OTP', async () => {
  const response = await request('POST', '/api/auth/request-otp', { phone: '9111111111' });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'USER_NOT_FOUND');
  assert.equal(await Otp.countDocuments({}), 0);
  assert.equal(await User.countDocuments({}), 0);
});

test('a migrated user can still log in while registration is closed', async () => {
  const created = await User.create({
    phone: { raw: '919999999999', normalized: '919999999999' },
    legacy: { source: 'gogetfit', userId: 4321 },
  });

  const requested = await request('POST', '/api/auth/request-otp', { phone: '919999999999' });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.data.isNewUser, false);

  const verified = await request('POST', '/api/auth/verify-otp', {
    phone: '919999999999',
    otp: requested.body.data.devOtp,
  });

  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.id, String(created._id));
});
