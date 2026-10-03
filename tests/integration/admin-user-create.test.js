import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import FreeDietPlan from '../../src/models/free-diet-plan.model.js';
import User from '../../src/models/user.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let adminToken;
let memberToken;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

/** yyyy-mm-dd for someone who turned [years] about ten days ago. */
const dobForAge = (years) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - 10);
  return d.toISOString().slice(0, 10);
};

/** The first Dart parity vector: male, 28, 170.7 cm, 72.5 kg, moderate. */
const DART = { bodyFat: 20.097415397983905, bmr: 1656.875, tdee: 2568.15625 };

const body = (overrides = {}, fitness = {}) => ({
  phone: '9876543210',
  name: 'Rahul Sharma',
  dateOfBirth: dobForAge(28),
  gender: 'male',
  city: 'Bengaluru',
  ...overrides,
  fitnessProfile: { height: 170.7, weight: 72.5, activityLevel: 'moderate', foodType: 'nonVegetarian', goal: 'maintainPhysique', ...fitness },
});
const create = (b = body(), token = adminToken) => server.request('POST', '/api/admin/users', { token, body: b });

/** A Veg/NonVeg template covering maintainPhysique for the vector: tdee + 10 = 2578. */
const seedTemplate = () =>
  FreeDietPlan.create({
    dietType: 'Veg/NonVeg',
    range: { from: 2571, to: 2590 },
    status: 'active',
    meals: [{ mealId: 1, foods: [{ legacyPlanMealId: 1, foodName: 'Rice', foodType: null, unit: 'g', quantity: 100, calories: 130, fat: 0.3, carbs: 28, protein: 2.7 }] }],
    legacy: { source: 'gogetfit', planId: 900 },
  });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  await FreeDietPlan.deleteMany({});
  const admin = await User.create({ phone: { raw: '9100000001', normalized: '919100000001' }, profile: { name: 'Admin' }, roles: ['user', 'admin'], status: 'active' });
  adminToken = tokenFor(admin);
  const member = await User.create({ phone: { raw: '9100000002', normalized: '919100000002' }, profile: { name: 'Member' }, roles: ['user', 'coach'], status: 'active' });
  memberToken = tokenFor(member);
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('1-9, 13, 14. an admin onboards a normal user: profile saved, figures calculated as the app does, diet plan matched', async () => {
  const plan = await seedTemplate();
  const res = await create();
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { user, freeDietPlan } = res.body.data;

  // 2-4. A normal user: role "user" only, no enrollment, no Coach.
  assert.deepEqual(user.roles, ['user']);
  assert.equal(await EnrolledClient.countDocuments(), 0);
  assert.equal(await Coach.countDocuments(), 0);

  const doc = await User.findById(user.id).lean();
  assert.equal(doc.phone.normalized, '919876543210');
  assert.equal(doc.profile.name, 'Rahul Sharma');
  // 5-6. DOB is stored as the calendar day; age is derived from it.
  assert.equal(doc.profile.dateOfBirth.toISOString().slice(0, 10), body().dateOfBirth);
  assert.equal(doc.profile.age, 28);
  assert.equal(user.profile.age, 28);
  assert.equal(doc.profile.gender, 'male');
  assert.equal(doc.profile.city, 'Bengaluru');
  // The user completes their profile and verifies their email in the app.
  assert.equal(doc.profileCompleted, false);
  assert.equal(doc.profile.isEmailVerified, false);
  assert.equal(doc.status, 'active');

  // 8-9, 13. Height/weight as entered; body fat, BMR, TDEE as the app computes them.
  const f = doc.profile.fitnessProfile;
  assert.equal(f.height, 170.7);
  assert.equal(f.weight, 72.5);
  assert.equal(f.bodyFatPercentage, 20.1); // the app's figure through the same 2-decimal storage rule
  assert.equal(f.bmr, DART.bmr);
  assert.equal(f.tdee, DART.tdee);
  assert.equal(f.activityLevel, 'moderate');
  assert.equal(f.foodType, 'nonVegetarian');
  assert.equal(f.goal, 'maintainPhysique');

  // 14. The same backend matcher assigns the Free Diet Plan.
  assert.equal(freeDietPlan.status, 'matched');
  assert.equal(String(doc.profile.freeDietPlanId), String(plan._id));
});

test('FINAL CHECK: an admin-created user equals a user who onboards the same way in the app', async () => {
  await seedTemplate();
  const viaAdmin = (await create(body({ phone: '9876500001' }))).body.data.user;

  // The app: phone sign-up creates the user, onboarding saves name/DOB/gender/city,
  // Edit Profile saves the fitness profile with the figures the app calculated.
  const appUser = await User.create({
    phone: { raw: '9876500002', normalized: '919876500002' },
    profile: { name: null, fitnessProfile: {} },
    roles: ['user'],
    status: 'active',
  });
  const token = tokenFor(appUser);
  const p1 = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: { name: 'Rahul Sharma', dateOfBirth: body().dateOfBirth, gender: 'male', city: 'Bengaluru' },
  });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  const p2 = await server.request('PATCH', '/api/users/me/profile', {
    token,
    body: {
      fitnessProfile: {
        height: 170.7,
        weight: 72.5,
        activityLevel: 'moderate',
        foodType: 'nonVegetarian',
        goal: 'maintainPhysique',
        bodyFatPercentage: DART.bodyFat,
        bmr: DART.bmr,
        tdee: DART.tdee,
      },
    },
  });
  assert.equal(p2.status, 200, JSON.stringify(p2.body));

  const viaApp = (await server.request('GET', `/api/admin/users/${appUser._id}`, { token: adminToken })).body.data.user;
  // Same profile, role and status. Neither is complete yet: no profile picture.
  const comparable = (u) => ({ profile: u.profile, roles: u.roles, status: u.status });
  assert.deepEqual(comparable(viaApp), comparable(viaAdmin));
  assert.equal(viaApp.profileCompleted, false);
  assert.equal(viaAdmin.profileCompleted, false);
});

test('2, 17. members and coaches cannot use it, and roles/userType can never be sent', async () => {
  assert.equal((await create(body(), memberToken)).status, 403);
  assert.equal((await server.request('POST', '/api/admin/users', { body: body() })).status, 401);
  for (const extra of [{ roles: ['user', 'admin'] }, { role: 'coach' }, { userType: 'Admin' }, { status: 'blocked' }, { isEmailVerified: true }]) {
    const res = await create({ ...body(), ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
  }
  assert.equal(await User.countDocuments({ 'phone.normalized': '919876543210' }), 0);
});

test('9, 13. age, body fat, BMR and TDEE are calculated by the server and cannot be supplied', async () => {
  for (const [key, value] of [['age', 30]]) {
    assert.equal((await create({ ...body(), [key]: value })).status, 400, key);
  }
  for (const field of ['bodyFatPercentage', 'bmr', 'tdee']) {
    assert.equal((await create(body({}, { [field]: 10 }))).status, 400, field);
  }
});

test('email is optional, uses the app rule, is stored unverified and is not unique', async () => {
  const none = await create(body({ phone: '9876500011' }));
  assert.equal(none.body.data.user.profile.email, null);

  const withEmail = await create(body({ phone: '9876500012', email: '  rahul.sharma+gym@gmail.com ' }));
  assert.equal(withEmail.status, 201);
  assert.equal(withEmail.body.data.user.profile.email, 'rahul.sharma+gym@gmail.com');
  assert.equal(withEmail.body.data.user.profile.isEmailVerified, false);

  // Not an identity: a second user may share it (the legacy data does).
  assert.equal((await create(body({ phone: '9876500013', email: 'rahul.sharma+gym@gmail.com' }))).status, 201);

  for (const email of ['rahul', 'rahul@gmail', '@gmail.com', 'rahul @gmail.com', 42]) {
    assert.equal((await create(body({ phone: '9876500014', email }))).status, 400, String(email));
  }
});

test('7. city is free text', async () => {
  const res = await create(body({ city: '  Navi Mumbai (Kharghar Sector 12)  ' }));
  assert.equal(res.status, 201);
  assert.equal(res.body.data.user.profile.city, 'Navi Mumbai (Kharghar Sector 12)');
});

test('10-12. activity level, food type and goal accept exactly the app values', async () => {
  let n = 0;
  const ok = async (fitness) => {
    n += 1;
    return create(body({ phone: `98765${String(n).padStart(5, '0')}` }, fitness));
  };
  for (const activityLevel of ['sedentary', 'light', 'moderate', 'active', 'veryActive']) assert.equal((await ok({ activityLevel })).status, 201, activityLevel);
  for (const foodType of ['vegetarian', 'nonVegetarian', 'vegetarianPlusEgg']) assert.equal((await ok({ foodType })).status, 201, foodType);
  for (const goal of ['fatLoss', 'muscleGain', 'maintainPhysique']) assert.equal((await ok({ goal })).status, 201, goal);

  for (const fitness of [
    { activityLevel: 'Moderately Active' },
    { activityLevel: 'extreme' },
    { foodType: 'Vegetarian' },
    { foodType: 'vegetarianEgg' },
    { goal: 'Fat / Weight Loss' },
    { goal: 'weightLoss' },
    { goal: undefined },
  ]) {
    assert.equal((await create(body({ phone: '9999900000' }, fitness))).status, 400, JSON.stringify(fitness));
  }
});

test('16. invalid fitness values, names, dates and genders are rejected', async () => {
  const bad = [
    body({}, { height: 0 }),
    body({}, { height: -170 }),
    body({}, { height: 120 }),
    body({}, { height: 250 }),
    body({}, { weight: 0 }),
    body({}, { weight: 29.9 }),
    body({}, { weight: 251 }),
    body({}, { height: '170' }),
    body({ name: ' ' }),
    body({ name: 'A' }),
    body({ dateOfBirth: '2026-02-30' }),
    body({ dateOfBirth: dobForAge(12) }),
    body({ dateOfBirth: dobForAge(101) }),
    body({ dateOfBirth: '01/01/1990' }),
    body({ gender: 'other' }),
    body({ gender: undefined }),
    body({ city: '' }),
  ];
  for (const b of bad) assert.equal((await create(b)).status, 400, JSON.stringify(b));
  assert.equal(await User.countDocuments({ 'phone.normalized': '919876543210' }), 0);
});

test('18. phone follows the existing rules: normalised, invalid refused, duplicates refused', async () => {
  const first = await create(body({ phone: '+91 98765-43210' }));
  assert.equal(first.status, 201);
  assert.equal(first.body.data.user.phone.normalized, '919876543210');

  const dup = await create(body({ phone: '9876543210' }));
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'PHONE_ALREADY_REGISTERED');

  const invalid = await create(body({ phone: '12' }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_PHONE');
  assert.equal((await create(body({ phone: undefined }))).status, 400);
});

test('14. no matching template is reported, not an error; the user is still created', async () => {
  const res = await create();
  assert.equal(res.status, 201);
  assert.equal(res.body.data.freeDietPlan.status, 'not_found');
  assert.equal(res.body.data.user.profile.freeDietPlanId, null);
});

test('15. existing user behaviour is unchanged: app sign-up users and the admin list still work', async () => {
  await create();
  const list = await server.request('GET', '/api/admin/users?search=Rahul', { token: adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.users.length, 1);
  assert.deepEqual(list.body.data.users[0].roles, ['user']);
});

// --- Edit (PATCH /api/admin/users/:id) ------------------------------------------------------

const editBody = (overrides = {}, fitness = {}) => {
  const { phone, ...rest } = body(overrides, fitness);
  return rest;
};
const edit = (id, b, token = adminToken) => server.request('PATCH', `/api/admin/users/${id}`, { token, body: b });

test('edit: saves the same form, recalculates the figures, and leaves phone, roles and profileCompleted alone', async () => {
  const { user } = (await create()).body.data;
  const res = await edit(user.id, editBody({ name: 'Rahul S', city: 'Mysuru', email: 'r@x.com' }, { weight: 80, activityLevel: 'active', goal: 'fatLoss' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const doc = await User.findById(user.id).lean();
  assert.equal(doc.profile.name, 'Rahul S');
  assert.equal(doc.profile.city, 'Mysuru');
  assert.equal(doc.profile.email, 'r@x.com');
  assert.equal(doc.profile.fitnessProfile.weight, 80);
  assert.equal(doc.profile.fitnessProfile.bmr, 10 * 80 + 6.25 * 170.7 - 5 * 28 + 5);
  assert.equal(doc.profile.fitnessProfile.tdee, (10 * 80 + 6.25 * 170.7 - 5 * 28 + 5) * 1.725);
  assert.equal(doc.phone.normalized, '919876543210');
  assert.deepEqual(doc.roles, ['user']);
  assert.equal(doc.profileCompleted, false);
});

test('edit: an existing height/weight is kept exactly (no rounding), within the app save ranges', async () => {
  const { user } = (await create()).body.data;
  const res = await edit(user.id, editBody({}, { height: 174.05, weight: 65.25 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const doc = await User.findById(user.id).lean();
  assert.equal(doc.profile.fitnessProfile.height, 174.05);
  assert.equal(doc.profile.fitnessProfile.weight, 65.25);
});

test('edit: phone and roles cannot be changed here; unknown users are 404; members are refused', async () => {
  const { user } = (await create()).body.data;
  assert.equal((await edit(user.id, { ...editBody(), phone: '9999999999' })).status, 400);
  assert.equal((await edit(user.id, { ...editBody(), roles: ['user', 'admin'] })).status, 400);
  assert.equal((await edit('6abb83a94ea8e73e24d5c399', editBody())).status, 404);
  assert.equal((await edit('nope', editBody())).status, 404);
  assert.equal((await edit(user.id, editBody(), memberToken)).status, 403);
});

test('edit: a verified email cannot be changed', async () => {
  const { user } = (await create(body({ email: 'rahul@gmail.com' }))).body.data;
  await User.updateOne({ _id: user.id }, { $set: { 'profile.isEmailVerified': true } });
  const res = await edit(user.id, editBody({ email: 'other@gmail.com' }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'EMAIL_ALREADY_VERIFIED');
  assert.equal((await edit(user.id, editBody({ email: 'rahul@gmail.com' }))).status, 200);
});
