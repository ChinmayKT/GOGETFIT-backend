import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import User from '../../src/models/user.model.js';
import { provisionAdmin } from '../../src/services/admin-provisioning.service.js';
import { resetRateLimits } from '../../src/middleware/rate-limit.middleware.js';
import {
  clearTestDb,
  connectTestDb,
  disconnectTestDb,
  startTestServer,
} from '../helpers/test-server.js';

let server;

/** The real target account from the provisioning brief. */
const ADMIN_PHONE = '918123260930';
const ADMIN_EMAIL = 'prajwal@gogetfitonline.com';
const ADMIN_PASSWORD = 'bootstrap-pass-123';

const seedUser = (overrides = {}) =>
  User.create({
    phone: { raw: overrides.phone ?? '919000000001', normalized: overrides.phone ?? '919000000001' },
    profile: { name: overrides.name ?? 'Test', email: overrides.email ?? null },
    roles: overrides.roles ?? ['user'],
    status: overrides.status ?? 'active',
    ...(overrides.legacy ? { legacy: overrides.legacy } : {}),
  });

/** Seeds the target account and provisions it exactly as the CLI does. */
const seedAdmin = async (extra = {}) => {
  await seedUser({
    phone: ADMIN_PHONE,
    name: 'Prajwal',
    email: ADMIN_EMAIL,
    legacy: { source: 'gogetfit', userId: 187 },
    ...extra,
  });
  return provisionAdmin({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD, apply: true });
};

const loginAdmin = (password = ADMIN_PASSWORD, email = ADMIN_EMAIL) =>
  server.request('POST', '/api/auth/admin/login', { body: { email, password } });

/** Token for a user who is NOT an admin, minted through the normal OTP flow. */
const tokenForRoles = async (roles, phone = '919000000055') => {
  const user = await seedUser({ phone, roles });
  return jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
};

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  // The limiter is process memory shared by every test in this file.
  resetRateLimits();
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

// --- 1. Valid admin authentication -----------------------------------------

test('1. an admin can authenticate with email and password', async () => {
  await seedAdmin();
  const response = await loginAdmin();

  assert.equal(response.status, 200);
  assert.ok(response.body.data.token, 'a token must be issued');
  assert.deepEqual(response.body.data.user.roles, ['user', 'admin']);

  // The JWT subject is the Mongo _id - never a legacy id.
  const payload = jwt.verify(response.body.data.token, process.env.JWT_SECRET);
  const user = await User.findOne({ 'phone.normalized': ADMIN_PHONE });
  assert.equal(payload.sub, String(user._id));
  assert.equal(payload.type, 'user');
});

test('1b. the email match is case-insensitive', async () => {
  await seedAdmin();
  const response = await loginAdmin(ADMIN_PASSWORD, 'PRAJWAL@GoGetFitOnline.COM');
  assert.equal(response.status, 200);
});

test('1c. a wrong password is refused, and reveals nothing an unknown email does not', async () => {
  await seedAdmin();

  const wrongPassword = await loginAdmin('definitely-wrong');
  const unknownEmail = await loginAdmin('definitely-wrong', 'nobody@example.com');

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  // Identical bodies: the endpoint cannot be used to enumerate accounts.
  assert.deepEqual(wrongPassword.body, unknownEmail.body);
  assert.equal(wrongPassword.body.error.code, 'INVALID_CREDENTIALS');
});

test('1d. a user without the admin role cannot use the admin login even with the right password', async () => {
  await seedUser({ phone: ADMIN_PHONE, email: ADMIN_EMAIL });
  // Give them a password but NOT the admin role.
  await provisionAdmin({ phone: ADMIN_PHONE, roles: [], password: ADMIN_PASSWORD, apply: true });

  const response = await loginAdmin();
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
});

test('1e. a member with no password set can never be logged in by an empty password', async () => {
  await seedUser({ phone: ADMIN_PHONE, email: ADMIN_EMAIL, roles: ['user', 'admin'] });

  for (const password of ['', ' ', 'null', 'undefined']) {
    const response = await loginAdmin(password);
    assert.ok(response.status === 400 || response.status === 401, `refused: ${password}`);
    assert.equal(response.body.data, undefined);
  }
});

// --- 2. Admin can call GET /api/admin/me -----------------------------------

test('2. an admin can read GET /api/admin/me', async () => {
  await seedAdmin();
  const { body: login } = await loginAdmin();

  const response = await server.request('GET', '/api/admin/me', { token: login.data.token });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.user.profile.email, ADMIN_EMAIL);
  assert.deepEqual(response.body.data.user.roles, ['user', 'admin']);
  assert.equal(response.body.data.user.phone.normalized, ADMIN_PHONE);
});

// --- 3. Admin can list users ----------------------------------------------

test('3. an admin can list users, paginated', async () => {
  await seedAdmin();
  for (let i = 0; i < 12; i += 1) {
    await seedUser({ phone: `9190000001${String(i).padStart(2, '0')}`, name: `User ${i}` });
  }
  const { body: login } = await loginAdmin();

  const first = await server.request('GET', '/api/admin/users?page=1&pageSize=5', {
    token: login.data.token,
  });

  assert.equal(first.status, 200);
  assert.equal(first.body.data.users.length, 5);
  assert.equal(first.body.data.pagination.total, 13, '12 members + the admin');
  assert.equal(first.body.data.pagination.totalPages, 3);

  const second = await server.request('GET', '/api/admin/users?page=2&pageSize=5', {
    token: login.data.token,
  });
  assert.equal(second.body.data.users.length, 5);
  const firstIds = first.body.data.users.map((u) => u.id);
  assert.ok(
    second.body.data.users.every((u) => !firstIds.includes(u.id)),
    'pages must not overlap',
  );
});

test('3b. pageSize is capped so the browser can never request the whole collection', async () => {
  await seedAdmin();
  const { body: login } = await loginAdmin();

  const response = await server.request('GET', '/api/admin/users?pageSize=100000', {
    token: login.data.token,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.pagination.pageSize, 100, 'clamped to MAX_PAGE_SIZE');
});

test('3c. the list can be filtered by role and by status, and searched', async () => {
  await seedAdmin();
  await seedUser({ phone: '919000000101', name: 'Coach Carl', roles: ['user', 'coach'] });
  await seedUser({ phone: '919000000102', name: 'Client Cleo', roles: ['user', 'client'] });
  await seedUser({ phone: '919000000103', name: 'Blocked Bob', status: 'blocked' });
  const { body: login } = await loginAdmin();
  const token = login.data.token;

  const admins = await server.request('GET', '/api/admin/users?role=admin', { token });
  assert.equal(admins.body.data.pagination.total, 1);

  const coaches = await server.request('GET', '/api/admin/users?role=coach', { token });
  assert.equal(coaches.body.data.pagination.total, 1);
  assert.equal(coaches.body.data.users[0].profile.name, 'Coach Carl');

  const blocked = await server.request('GET', '/api/admin/users?status=blocked', { token });
  assert.equal(blocked.body.data.pagination.total, 1);

  const search = await server.request('GET', '/api/admin/users?search=Cleo', { token });
  assert.equal(search.body.data.pagination.total, 1);
  assert.equal(search.body.data.users[0].profile.name, 'Client Cleo');

  // Search must treat the term as a literal, not as a regular expression.
  const regexAttempt = await server.request('GET', '/api/admin/users?search=.*', { token });
  assert.equal(regexAttempt.body.data.pagination.total, 0, '".*" must match nothing literally');

  const badRole = await server.request('GET', '/api/admin/users?role=superuser', { token });
  assert.equal(badRole.status, 400);
});

// --- 4. Admin can view user details ---------------------------------------

test('4. an admin can read a single user, with the nested profile shape', async () => {
  await seedAdmin();
  const { body: login } = await loginAdmin();
  const admin = await User.findOne({ 'phone.normalized': ADMIN_PHONE });

  const response = await server.request('GET', `/api/admin/users/${admin._id}`, {
    token: login.data.token,
  });

  assert.equal(response.status, 200);
  const user = response.body.data.user;
  assert.equal(user.id, String(admin._id));
  // The canonical structure is nested - there are no root-level height/weight/email.
  assert.ok('fitnessProfile' in user.profile);
  assert.deepEqual(Object.keys(user.profile.fitnessProfile).sort(), [
    'activityLevel',
    'bmr',
    'bodyFatPercentage',
    'foodType',
    'goal',
    'height',
    'tdee',
    'weight',
  ]);
  assert.equal(user.height, undefined, 'no root-level height');
  assert.equal(user.email, undefined, 'no root-level email');
  assert.deepEqual(user.legacy, { source: 'gogetfit', userId: 187 });
});

test('4b. an unknown or malformed id is a 404, not a 500', async () => {
  await seedAdmin();
  const { body: login } = await loginAdmin();
  const token = login.data.token;

  const malformed = await server.request('GET', '/api/admin/users/not-an-objectid', { token });
  assert.equal(malformed.status, 404);

  const missing = await server.request('GET', '/api/admin/users/000000000000000000000000', { token });
  assert.equal(missing.status, 404);
});

// --- 5/6/7. Role gating ---------------------------------------------------

test('5. a normal user receives 403 from the admin endpoints', async () => {
  const token = await tokenForRoles(['user']);

  for (const path of ['/api/admin/users', '/api/admin/me', '/api/admin/users/000000000000000000000000']) {
    const response = await server.request('GET', path, { token });
    assert.equal(response.status, 403, path);
    assert.equal(response.body.error.code, 'FORBIDDEN');
    // The message must not disclose which role is required.
    assert.ok(!/admin/i.test(response.body.error.message), 'must not name the missing role');
  }
});

test('6. a client-only user receives 403', async () => {
  const token = await tokenForRoles(['user', 'client']);
  const response = await server.request('GET', '/api/admin/users', { token });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
});

test('7. a coach-only user receives 403', async () => {
  const token = await tokenForRoles(['user', 'coach']);
  const response = await server.request('GET', '/api/admin/users', { token });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
});

test('7b. a user holding client AND coach but not admin still receives 403', async () => {
  const token = await tokenForRoles(['user', 'client', 'coach']);
  const response = await server.request('GET', '/api/admin/users', { token });
  assert.equal(response.status, 403);
});

test('7c. a role claimed by the client is ignored - only the stored roles count', async () => {
  const user = await seedUser({ phone: '919000000077', roles: ['user'] });
  // Forge every plausible escalation vector into the token itself.
  const forged = jwt.sign(
    { sub: String(user._id), type: 'user', roles: ['user', 'admin'], role: 'admin', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const response = await server.request('GET', '/api/admin/users', { token: forged });
  assert.equal(response.status, 403, 'a role claim in the JWT must grant nothing');
});

// --- 8. Inactive admin ----------------------------------------------------

test('8. an admin whose account is deactivated is refused', async () => {
  await seedAdmin();
  const { body: login } = await loginAdmin();
  const token = login.data.token;

  // The existing auth contract treats a non-active account as 401 in requireAuth.
  await User.updateOne({ 'phone.normalized': ADMIN_PHONE }, { $set: { status: 'inactive' } });

  const response = await server.request('GET', '/api/admin/users', { token });
  assert.equal(response.status, 401, 'an already-issued token stops working immediately');
  assert.equal(response.body.error.code, 'UNAUTHORIZED');

  // And they can no longer log in either.
  const relogin = await loginAdmin();
  assert.equal(relogin.status, 401);
});

test('8b. a blocked admin is refused', async () => {
  await seedAdmin();
  await User.updateOne({ 'phone.normalized': ADMIN_PHONE }, { $set: { status: 'blocked' } });
  assert.equal((await loginAdmin()).status, 401);
});

test('8c. revoking the admin role takes effect on the next request', async () => {
  await seedAdmin();
  const { body: login } = await loginAdmin();
  const token = login.data.token;

  assert.equal((await server.request('GET', '/api/admin/users', { token })).status, 200);

  await User.updateOne({ 'phone.normalized': ADMIN_PHONE }, { $set: { roles: ['user'] } });

  const after = await server.request('GET', '/api/admin/users', { token });
  assert.equal(after.status, 403, 'the same token must lose access without waiting to expire');
});

// --- 9/10. Token handling -------------------------------------------------

test('9. a missing token returns 401', async () => {
  const response = await server.request('GET', '/api/admin/users');
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
});

test('10. an invalid, expired or wrongly-signed JWT returns 401', async () => {
  const user = await seedUser({ phone: '919000000088', roles: ['user', 'admin'] });

  const cases = {
    garbage: 'not-a-jwt',
    wrongSecret: jwt.sign({ sub: String(user._id), type: 'user' }, 'the-wrong-secret'),
    expired: jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, {
      expiresIn: '-1h',
    }),
    wrongType: jwt.sign({ sub: String(user._id), type: 'service' }, process.env.JWT_SECRET),
  };

  for (const [label, token] of Object.entries(cases)) {
    const response = await server.request('GET', '/api/admin/users', { token });
    assert.equal(response.status, 401, label);
  }

  // A well-formed token for a user who has since been deleted.
  const deletedToken = jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET);
  await User.deleteOne({ _id: user._id });
  assert.equal((await server.request('GET', '/api/admin/users', { token: deletedToken })).status, 401);
});

// --- 11/12. No secret leakage --------------------------------------------

test('11 & 12. no response exposes the password hash, OTP material or any secret', async () => {
  await seedAdmin();
  await seedUser({ phone: '919000000201', name: 'Someone' });
  const loginResponse = await loginAdmin();
  const token = loginResponse.body.data.token;
  const admin = await User.findOne({ 'phone.normalized': ADMIN_PHONE });

  const payloads = [
    JSON.stringify(loginResponse.body),
    JSON.stringify((await server.request('GET', '/api/admin/me', { token })).body),
    JSON.stringify((await server.request('GET', '/api/admin/users?pageSize=100', { token })).body),
    JSON.stringify((await server.request('GET', `/api/admin/users/${admin._id}`, { token })).body),
  ];

  const forbiddenPatterns = [
    /passwordHash/i,
    /\$argon2/,
    /"password"/i,
    /otpHash/i,
    /"otp"/i,
    /"salt"/i,
    /failedLoginAttempts/i,
    /lockedUntil/i,
    /"auth"\s*:/i,
    /login_token/i,
    /bootstrapSecret/i,
    /JWT_SECRET/,
  ];

  for (const payload of payloads) {
    for (const pattern of forbiddenPatterns) {
      assert.ok(!pattern.test(payload), `response must not contain ${pattern}`);
    }
  }

  // Positive assertion: the shape is an explicit allow-list.
  const list = await server.request('GET', '/api/admin/users?pageSize=100', { token });
  for (const user of list.body.data.users) {
    assert.deepEqual(Object.keys(user).sort(), [
      'createdAt',
      'id',
      'legacy',
      'phone',
      'profile',
      'profileCompleted',
      'roles',
      'status',
      'updatedAt',
    ]);
    assert.equal(user.auth, undefined);
  }
});

// --- 13/14/15. Provisioning ----------------------------------------------

test('13. the existing account 918123260930 receives the admin role', async () => {
  const user = await seedUser({
    phone: ADMIN_PHONE,
    name: 'Prajwal',
    email: ADMIN_EMAIL,
    legacy: { source: 'gogetfit', userId: 187 },
  });
  assert.deepEqual(user.roles, ['user'], 'starts as a plain member');

  const result = await provisionAdmin({ phone: ADMIN_PHONE, apply: true });

  assert.equal(result.found, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.after.roles, ['user', 'admin']);
  assert.equal(result.after.status, 'active');

  const fresh = await User.findById(user._id);
  assert.deepEqual(fresh.roles, ['user', 'admin']);
});

test('14. running provisioning twice does not duplicate the admin role', async () => {
  await seedUser({ phone: ADMIN_PHONE, email: ADMIN_EMAIL });

  const first = await provisionAdmin({ phone: ADMIN_PHONE, apply: true });
  const second = await provisionAdmin({ phone: ADMIN_PHONE, apply: true });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false, 'the second run is a no-op');

  const fresh = await User.findOne({ 'phone.normalized': ADMIN_PHONE });
  assert.deepEqual(fresh.roles, ['user', 'admin']);
  assert.equal(fresh.roles.filter((r) => r === 'admin').length, 1);
});

test('15. existing roles and unrelated data are preserved by provisioning', async () => {
  const user = await seedUser({
    phone: ADMIN_PHONE,
    name: 'Prajwal',
    email: ADMIN_EMAIL,
    roles: ['user', 'client', 'coach'],
    legacy: { source: 'gogetfit', userId: 187 },
  });
  const createdAt = user.createdAt;

  await provisionAdmin({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD, apply: true });

  const fresh = await User.findById(user._id).select('+auth.passwordHash');
  assert.deepEqual(fresh.roles, ['user', 'client', 'coach', 'admin'], 'existing roles survive');
  assert.equal(String(fresh._id), String(user._id), '_id is preserved');
  assert.deepEqual(
    { source: fresh.legacy.source, userId: fresh.legacy.userId },
    { source: 'gogetfit', userId: 187 },
    'legacy mapping is preserved',
  );
  assert.equal(fresh.profile.name, 'Prajwal', 'profile is preserved');
  assert.equal(fresh.profile.email, ADMIN_EMAIL);
  assert.equal(createdAt.getTime(), fresh.createdAt.getTime(), 'createdAt is preserved');
  assert.ok(fresh.auth.passwordHash.startsWith('$argon2id$'));
});

test('15b. provisioning refuses to create a user for an unknown phone', async () => {
  const result = await provisionAdmin({ phone: '919999000011', apply: true });

  assert.equal(result.found, false);
  assert.equal(result.changed, false);
  assert.equal(await User.countDocuments({}), 0, 'nothing may be created');
});

test('15c. a dry run reports the change but writes nothing', async () => {
  await seedUser({ phone: ADMIN_PHONE, email: ADMIN_EMAIL });

  const result = await provisionAdmin({ phone: ADMIN_PHONE, apply: false });

  assert.equal(result.wouldChange, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.plan.roles.to, ['user', 'admin']);

  const fresh = await User.findOne({ 'phone.normalized': ADMIN_PHONE });
  assert.deepEqual(fresh.roles, ['user'], 'the database is untouched by a dry run');
});

test('15d. provisioning never overwrites an existing email', async () => {
  await seedUser({ phone: ADMIN_PHONE, email: 'original@example.com' });

  await provisionAdmin({ phone: ADMIN_PHONE, email: 'attacker@example.com', apply: true });

  const fresh = await User.findOne({ 'phone.normalized': ADMIN_PHONE });
  assert.equal(fresh.profile.email, 'original@example.com');
});

test('15e. an unknown role can never be stored', async () => {
  await seedUser({ phone: ADMIN_PHONE });
  await provisionAdmin({ phone: ADMIN_PHONE, roles: ['superuser'], apply: true });

  const fresh = await User.findOne({ 'phone.normalized': ADMIN_PHONE });
  assert.deepEqual(fresh.roles, ['user'], 'phantom roles are dropped');
});

// --- Brute-force protection ----------------------------------------------

test('16. repeated failures lock the account, and the lock survives a correct password', async () => {
  await seedAdmin();

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await loginAdmin('wrong-password')).status, 401);
  }

  const locked = await User.findOne({ 'phone.normalized': ADMIN_PHONE });
  assert.ok(locked.auth.lockedUntil instanceof Date, 'the account must be locked');
  assert.ok(locked.auth.lockedUntil.getTime() > Date.now());

  // Even the correct password is refused while locked, with the same generic error.
  const correct = await loginAdmin();
  assert.equal(correct.status, 401);
  assert.equal(correct.body.error.code, 'INVALID_CREDENTIALS');
});

test('17. a successful login clears the failure counter', async () => {
  await seedAdmin();

  await loginAdmin('wrong-password');
  await loginAdmin('wrong-password');
  assert.equal((await User.findOne({ 'phone.normalized': ADMIN_PHONE })).auth.failedLoginAttempts, 2);

  assert.equal((await loginAdmin()).status, 200);

  const fresh = await User.findOne({ 'phone.normalized': ADMIN_PHONE });
  assert.equal(fresh.auth.failedLoginAttempts, 0);
  assert.equal(fresh.auth.lockedUntil, null);
  assert.ok(fresh.auth.lastLoginAt instanceof Date);
});

test('18. the login endpoint is rate limited', async () => {
  await seedAdmin();

  let sawTooMany = false;
  for (let i = 0; i < 15; i += 1) {
    const response = await loginAdmin('wrong-password');
    if (response.status === 429) {
      sawTooMany = true;
      assert.equal(response.body.error.code, 'TOO_MANY_REQUESTS');
      break;
    }
  }

  assert.ok(sawTooMany, 'sustained attempts must eventually be throttled');
});

// --- Mobile regression ----------------------------------------------------

test('19. the mobile phone+OTP flow is unaffected by the admin password path', async () => {
  const requested = await server.request('POST', '/api/auth/request-otp', {
    body: { phone: '919000000301' },
  });
  assert.equal(requested.status, 200);

  const verified = await server.request('POST', '/api/auth/verify-otp', {
    body: { phone: '919000000301', otp: requested.body.data.devOtp },
  });
  assert.equal(verified.status, 201);
  assert.deepEqual(verified.body.data.user.roles, ['user']);

  // A member created by the mobile flow gets no password and no admin access.
  const created = await User.findOne({ 'phone.normalized': '919000000301' }).select(
    '+auth.passwordHash',
  );
  assert.equal(created.auth?.passwordHash ?? null, null);
  assert.equal(
    (await server.request('GET', '/api/admin/users', { token: verified.body.data.token })).status,
    403,
  );
});
