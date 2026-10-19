import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import DietPlan from '../../src/models/diet-plan.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import Questionnaire from '../../src/models/questionnaire.model.js';
import User from '../../src/models/user.model.js';
import { calculateAge } from '../../src/utils/age.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * GET /api/coach/enrollments/:enrollmentId/diet-plan/create-data - the six
 * values the coach's Create Diet Plan screen opens with. From the profile
 * ONLY - the questionnaire is never read - null where the profile has
 * nothing. Exactly six keys, read-only.
 */
const KEYS = ['activityLevel', 'age', 'gender', 'goal', 'height', 'weight'];
const DOB = new Date(Date.UTC(1994, 4, 10));

let server;
let coachA;
let coachB;
let coachAToken;
let memberToken;
let plan;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let seq = 0;
const seedUser = ({ roles = ['user', 'client'], profile = {} } = {}) => {
  seq += 1;
  const phone = `9183000${String(seq).padStart(5, '0')}`;
  return User.create({
    phone: { raw: phone, normalized: phone },
    profile: { name: `Member ${seq}`, ...profile },
    roles,
    status: 'active',
  });
};

const seedCoach = async () => {
  const user = await seedUser({ roles: ['user', 'coach'] });
  const coach = await Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' } });
  return { user, coach };
};

const enroll = (coach, member, extra = {}) =>
  EnrolledClient.create({
    userId: member._id,
    planId: plan._id,
    coachId: coach._id,
    enrollDate: new Date(),
    hasStarted: false,
    isDeleted: false,
    payment: { transactionId: `pay_create_${seq}_${Math.random()}`, amount: 4999, currency: 'INR', status: 'Success' },
    ...extra,
  });

const answer = (member, enrollment, answers, status = 'submitted') =>
  Questionnaire.create({
    userId: member._id,
    enrollmentId: enrollment._id,
    coachId: enrollment.coachId,
    answers,
    status,
    submittedAt: status === 'submitted' ? new Date() : null,
  });

const FULL_PROFILE = {
  gender: 'male',
  dateOfBirth: DOB,
  fitnessProfile: { height: 175, weight: 70, activityLevel: 'moderate', goal: 'fatLoss' },
};
const QUESTIONNAIRE = { gender: 'Female', age: '41', height: '5.6', weight: '72', goal: 'Maintain Weight' };

const createData = (enrollmentId, token = coachAToken) =>
  server.request('GET', `/api/coach/enrollments/${enrollmentId}/diet-plan/create-data`, { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  plan = await GogetfitPlan.create({
    name: '12 WEEKS GOGETFIT PLAN',
    planType: 'Enrollment',
    coachLevel: 'LEVEL 1',
    durationWeeks: 12,
    personsAllowed: 1,
    pricing: { basePrice: 4999, reward: 0 },
  });
  const a = await seedCoach();
  coachA = a.coach;
  coachAToken = tokenFor(a.user);
  coachB = (await seedCoach()).coach;
  memberToken = tokenFor(await seedUser());
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('a complete profile: all six from the profile, in its own types, and exactly six keys', async () => {
  const member = await seedUser({ profile: FULL_PROFILE });
  const enrollment = await enroll(coachA, member);
  await answer(member, enrollment, QUESTIONNAIRE);

  const res = await createData(enrollment._id);

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.data).sort(), KEYS);
  assert.deepEqual(res.body.data, {
    gender: 'male',
    age: calculateAge(DOB),
    height: 175,
    weight: 70,
    activityLevel: 'moderate',
    goal: 'fatLoss',
  });
});

test('a partial profile: what it has is returned, the rest is null - the questionnaire does not fill it', async () => {
  const member = await seedUser({
    profile: { gender: 'male', fitnessProfile: { height: 175, weight: null, activityLevel: null, goal: 'fatLoss' } },
  });
  const enrollment = await enroll(coachA, member);
  await answer(member, enrollment, QUESTIONNAIRE); // has age, weight, goal... all ignored

  const { data } = (await createData(enrollment._id)).body;

  assert.deepEqual(data, { gender: 'male', age: null, height: 175, weight: null, activityLevel: null, goal: 'fatLoss' });
});

test('an empty profile with a complete questionnaire: still all null', async () => {
  const member = await seedUser();
  const enrollment = await enroll(coachA, member);
  await answer(member, enrollment, { gender: 'Male', age: '29', height: '5.6', weight: '66', goal: 'Muscle / Weight Gain' });

  const res = await createData(enrollment._id);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { gender: null, age: null, height: null, weight: null, activityLevel: null, goal: null });
});

test('where profile and questionnaire differ, the profile is returned', async () => {
  const member = await seedUser({ profile: FULL_PROFILE });
  const enrollment = await enroll(coachA, member);
  await answer(member, enrollment, QUESTIONNAIRE); // Female, 41, 5.6 ft, 72 kg, Maintain Weight

  const { data } = (await createData(enrollment._id)).body;

  assert.equal(data.gender, 'male');
  assert.equal(data.age, calculateAge(DOB));
  assert.equal(data.height, 175);
  assert.equal(data.weight, 70);
  assert.equal(data.goal, 'fatLoss');
});

test('the questionnaire collection is never queried: exactly coach, enrollment and user are read', async () => {
  const member = await seedUser({ profile: { gender: 'female' } });
  const enrollment = await enroll(coachA, member);
  await answer(member, enrollment, QUESTIONNAIRE);

  const queried = [];
  mongoose.set('debug', (collection, method) => queried.push(`${collection}.${method}`));
  try {
    await createData(enrollment._id);
  } finally {
    mongoose.set('debug', false);
  }

  assert.equal(queried.some((q) => q.startsWith('questionnaires')), false, queried.join(', '));
  // Auth reads the signed-in user; the service then reads the coach, the
  // enrollment and the member - one profile read, nothing else.
  assert.deepEqual(queried.map((q) => q.split('.')[0]), ['users', 'coaches', 'enrolledclients', 'users']);
});

test('values outside the app\'s vocabulary are treated as missing', async () => {
  const member = await seedUser({
    profile: { fitnessProfile: { activityLevel: 'couch', goal: 'beach body', height: 0 } },
  });
  const enrollment = await enroll(coachA, member);
  await answer(member, enrollment, { goal: 'Fat / Weight Loss', height: '6.0' });

  const { data } = (await createData(enrollment._id)).body;

  assert.equal(data.activityLevel, null);
  assert.equal(data.goal, null, 'not usable, and nothing else fills it');
  assert.equal(data.height, null);
});

test('another coach\'s enrollment is 403', async () => {
  const member = await seedUser({ profile: FULL_PROFILE });
  const enrollment = await enroll(coachB, member);

  const res = await createData(enrollment._id);

  assert.equal(res.status, 403);
  assert.equal(res.body.data, undefined, 'nothing about the member leaks');
});

test('an unknown or malformed enrollment is 404', async () => {
  assert.equal((await createData('64b7f0000000000000000000')).status, 404);
  assert.equal((await createData('not-an-id')).status, 404);
});

test('a deleted enrollment is 404', async () => {
  const member = await seedUser({ profile: FULL_PROFILE });
  const enrollment = await enroll(coachA, member, { isDeleted: true });

  assert.equal((await createData(enrollment._id)).status, 404);
});

test('coach-only: a member is 403, no token is 401', async () => {
  const member = await seedUser();
  const enrollment = await enroll(coachA, member);

  assert.equal((await createData(enrollment._id, memberToken)).status, 403);
  assert.equal((await server.request('GET', `/api/coach/enrollments/${enrollment._id}/diet-plan/create-data`)).status, 401);
});

test('read-only: no user, enrollment, questionnaire or diet plan is changed or created', async () => {
  const member = await seedUser({ profile: { gender: 'female' } });
  const enrollment = await enroll(coachA, member);
  await answer(member, enrollment, QUESTIONNAIRE);
  const snapshot = async () => ({
    users: await User.find().sort({ _id: 1 }).lean(),
    enrollments: await EnrolledClient.find().sort({ _id: 1 }).lean(),
    questionnaires: await Questionnaire.find().sort({ _id: 1 }).lean(),
    dietPlans: await DietPlan.countDocuments(),
  });
  const before = await snapshot();

  await createData(enrollment._id);

  assert.deepEqual(await snapshot(), before);
});
