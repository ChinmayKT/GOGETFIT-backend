import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import Questionnaire from '../../src/models/questionnaire.model.js';
import User from '../../src/models/user.model.js';
import { QUESTIONNAIRE_QUESTIONS } from '../../src/constants/questionnaire-definition.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let adminToken;
let memberToken;
let member;
let coach;
let plan;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9183000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name: name ?? `User ${seq}` }, roles, status: 'active' });
};

const enroll = (enrollDate) =>
  EnrolledClient.create({ userId: member._id, planId: plan._id, coachId: coach._id, enrollDate, hasStarted: false, isDeleted: false });

const answers = (overrides = {}) => ({
  gender: 'Male', age: '25', height: '5.7', weight: '70', goal: 'Fat / Weight Loss',
  contactTime: 'Weekdays', foodPref: 'Vegetarian + Egg', workoutPref: 'Gym Workout', trainingLevel: 6,
  ...overrides,
});

const list = (id, token = adminToken) => server.request('GET', `/api/admin/users/${id}/questionnaires`, { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  plan = await GogetfitPlan.create({
    name: '12 WEEKS GOGETFIT PLAN', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1,
    pricing: { basePrice: 4999, reward: 0 },
  });
  const coachUser = await seedUser(['user', 'coach'], 'Prajwal');
  coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  adminToken = tokenFor(await seedUser(['user', 'admin']));
  member = await seedUser(['user', 'client'], 'Asha');
  memberToken = tokenFor(member);
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('lists submitted questionnaires newest first, with plan, coach and every question in order', async () => {
  const older = await enroll(new Date('2025-01-01'));
  const newer = await enroll(new Date('2025-06-01'));
  await Questionnaire.create({ userId: member._id, enrollmentId: older._id, coachId: coach._id, answers: answers(), status: 'submitted', submittedAt: new Date('2025-01-02') });
  await Questionnaire.create({ userId: member._id, enrollmentId: newer._id, coachId: coach._id, answers: answers({ goal: 'Maintain Weight' }), status: 'submitted', submittedAt: new Date('2025-06-02') });

  const res = await list(member._id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { questionnaires, total } = res.body.data;
  assert.equal(total, 2);
  assert.deepEqual(questionnaires.map((q) => q.enrollmentId), [String(newer._id), String(older._id)]);

  const [q] = questionnaires;
  assert.equal(q.plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.deepEqual(q.coach, { id: String(coach._id), name: 'Prajwal', level: 'LEVEL 1' });
  // Male: the two female-only questions are not listed.
  const asked = QUESTIONNAIRE_QUESTIONS.filter((x) => !x.femaleOnly);
  assert.deepEqual(q.questions.map((x) => x.key), asked.map((x) => x.key));
  const byKey = Object.fromEntries(q.questions.map((x) => [x.key, x]));
  assert.equal(byKey.goal.question, 'Goal');
  assert.equal(byKey.goal.answer, 'Maintain Weight');
  assert.equal(byKey.goal.stepTitle, 'Basic Information');
  assert.equal(byKey.trainingLevel.answer, 6);
  assert.equal(byKey.profession.answer, null); // unanswered
});

test('female members see the female-only questions too', async () => {
  const e = await enroll(new Date('2025-01-01'));
  await Questionnaire.create({ userId: member._id, enrollmentId: e._id, coachId: coach._id, answers: answers({ gender: 'Female', periodCramps: 3 }), status: 'submitted', submittedAt: new Date() });
  const [q] = (await list(member._id)).body.data.questionnaires;
  assert.equal(q.questions.find((x) => x.key === 'periodCramps').answer, 3);
  assert.equal(q.questions.find((x) => x.key === 'moodSwings').answer, null);
});

test('drafts and other members are not included', async () => {
  const e = await enroll(new Date('2025-01-01'));
  await Questionnaire.create({ userId: member._id, enrollmentId: e._id, coachId: coach._id, answers: answers(), status: 'draft' });
  const other = await seedUser(['user', 'client']);
  const oe = await EnrolledClient.create({ userId: other._id, planId: plan._id, coachId: coach._id, enrollDate: new Date(), isDeleted: false });
  await Questionnaire.create({ userId: other._id, enrollmentId: oe._id, coachId: coach._id, answers: answers(), status: 'submitted', submittedAt: new Date() });

  const res = await list(member._id);
  assert.deepEqual(res.body.data, { questionnaires: [], total: 0 });
});

test('unknown or malformed user is a 404; admins only', async () => {
  for (const id of [new mongoose.Types.ObjectId().toString(), 'nope']) {
    const res = await list(id);
    assert.equal(res.status, 404, id);
    assert.equal(res.body.error.code, 'USER_NOT_FOUND');
  }
  assert.equal((await list(member._id, memberToken)).status, 403);
  assert.equal((await server.request('GET', `/api/admin/users/${member._id}/questionnaires`)).status, 401);
});

test('only status "submitted" is shown: a draft is not, even with a submittedAt', async () => {
  const e = await enroll(new Date('2025-01-01'));
  await Questionnaire.create({
    userId: member._id, enrollmentId: e._id, coachId: coach._id,
    answers: answers(), status: 'draft', submittedAt: new Date('2025-01-02'),
  });
  assert.equal((await list(member._id)).body.data.total, 0);
  await Questionnaire.updateOne({ enrollmentId: e._id }, { $set: { status: 'submitted' } });
  assert.equal((await list(member._id)).body.data.total, 1);
});
