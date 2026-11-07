import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import Questionnaire from '../../src/models/questionnaire.model.js';
import User from '../../src/models/user.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * GET /api/coach/enrollments/:enrollmentId/questionnaire
 *
 * authenticated coach -> EnrolledClient.coachId -> enrollmentId -> Questionnaire.
 * The coach comes from the token only; another coach's enrollment is a 404.
 */

let server;
let coachA;
let coachAToken;
let coachB;
let coachBToken;
let member;
let memberToken;
let plan;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9184000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name: name ?? `User ${seq}` }, roles, status: 'active' });
};
const seedCoach = async (name) => {
  const user = await seedUser(['user', 'coach'], name);
  return { user, coach: await Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' }, status: 'active' }) };
};

const enroll = (coach, extra = {}) =>
  EnrolledClient.create({
    userId: member._id,
    planId: plan._id,
    coachId: coach._id,
    enrollDate: new Date('2026-09-01'),
    hasStarted: false,
    isDeleted: false,
    ...extra,
  });

/** Every answer a male member can give, slider values as ints. */
const fullAnswers = {
  gender: 'Male', age: '32', height: '5.6', weight: '66', goal: 'Fat / Weight Loss', city: 'Banglore',
  profession: 'Software Engineer', highestWeight: '66', contactTime: 'Anytime', foodPref: 'Vegetarian + Non-Veg',
  triedDiet: 'No', foodRoutine: 'Breakfast, lunch, dinner', foodsLike: 'Eggs', foodsDislike: 'Sweets',
  specialFood: 'Spicy', allergies: 'None', workoutPref: 'Gym Workout', workoutDuration: '30 days',
  trainingLevel: 6, cardioLevel: 5, injuries: 'No', dailyRoutine: 'Office then gym', medications: 'No',
  sickFreq: 'Monthly', coldFreq: 'When sick', digestiveFreq: 'No', digestiveHealth: 8, alcohol: 'Once a Week',
  smoke: 'Yes', bodyShaming: 'Yes', cognitive: 6, cravings: 4, whyTransform: 'Confidence',
  longTermGoal: '6 months', expectFromCoach: 'Support',
};

const seedQuestionnaire = (enrollment, { status = 'submitted', answers = fullAnswers } = {}) =>
  Questionnaire.create({
    userId: enrollment.userId,
    enrollmentId: enrollment._id,
    coachId: enrollment.coachId,
    answers,
    status,
    submittedAt: status === 'submitted' ? new Date('2026-09-02T10:00:00Z') : null,
  });

const read = (enrollmentId, token = coachAToken) =>
  server.request('GET', `/api/coach/enrollments/${enrollmentId}/questionnaire`, { token });

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
  const a = await seedCoach('Prajwal');
  coachA = a.coach;
  coachAToken = tokenFor(a.user);
  const b = await seedCoach('Siri');
  coachB = b.coach;
  coachBToken = tokenFor(b.user);
  member = await seedUser(['user', 'client'], 'Asha');
  memberToken = tokenFor(member);
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('1-2. a coach reads the submitted questionnaire of their own client, every answer as stored', async () => {
  const e = await enroll(coachA);
  const q = await seedQuestionnaire(e);

  const res = await read(e._id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { questionnaire } = res.body.data;
  assert.equal(questionnaire.questionnaireId, String(q._id));
  assert.equal(questionnaire.enrollmentId, String(e._id));
  assert.equal(questionnaire.coachId, String(coachA._id));
  assert.equal(questionnaire.status, 'submitted');
  assert.equal(questionnaire.submittedAt, '2026-09-02T10:00:00.000Z');
  // The member API's answer map, unchanged: strings for choices/text, ints for sliders.
  assert.deepEqual(questionnaire.answers, fullAnswers);
  assert.equal(questionnaire.plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.deepEqual(questionnaire.coach, { id: String(coachA._id), name: 'Prajwal', level: 'LEVEL 1' });
});

test("3. a coach cannot read another coach's client's questionnaire", async () => {
  const theirs = await enroll(coachB);
  await seedQuestionnaire(theirs);

  const res = await read(theirs._id, coachAToken);
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
  assert.equal(JSON.stringify(res.body).includes('Banglore'), false);
  // The owning coach still can.
  assert.equal((await read(theirs._id, coachBToken)).status, 200);
});

test('a coachId in the query is ignored - the coach is the token', async () => {
  const theirs = await enroll(coachB);
  await seedQuestionnaire(theirs);
  const res = await server.request('GET', `/api/coach/enrollments/${theirs._id}/questionnaire?coachId=${coachB._id}`, { token: coachAToken });
  assert.equal(res.status, 404);
});

test('4. a draft is never shown to the coach', async () => {
  const e = await enroll(coachA);
  await seedQuestionnaire(e, { status: 'draft' });
  // Even one that was submitted once and saved again as a draft.
  await Questionnaire.updateOne({ enrollmentId: e._id }, { $set: { submittedAt: new Date() } });

  const res = await read(e._id);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.questionnaire, null);
});

test('5. no questionnaire at all is an empty result, not an error', async () => {
  const e = await enroll(coachA);
  const res = await read(e._id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { questionnaire: null });
});

test('6. with several enrollments, only the selected enrollment\'s questionnaire is returned', async () => {
  const first = await enroll(coachA, { enrollDate: new Date('2025-01-01') });
  const second = await enroll(coachA, { enrollDate: new Date('2026-01-01') });
  const third = await enroll(coachA, { enrollDate: new Date('2026-06-01') }); // latest, none submitted
  await seedQuestionnaire(first, { answers: { ...fullAnswers, city: 'First' } });
  await seedQuestionnaire(second, { answers: { ...fullAnswers, city: 'Second' } });

  assert.equal((await read(first._id)).body.data.questionnaire.answers.city, 'First');
  assert.equal((await read(second._id)).body.data.questionnaire.answers.city, 'Second');
  // The latest enrollment has none - never falls back to an older one.
  assert.equal((await read(third._id)).body.data.questionnaire, null);
});

test('deleted, unknown and malformed enrollments are 404', async () => {
  const deleted = await enroll(coachA, { isDeleted: true });
  await seedQuestionnaire(deleted);
  for (const id of [deleted._id, new mongoose.Types.ObjectId(), 'nope']) {
    const res = await read(id);
    assert.equal(res.status, 404, String(id));
    assert.equal(res.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
  }
});

test('coaches only: a member gets 403, no token 401', async () => {
  const e = await enroll(coachA);
  assert.equal((await read(e._id, memberToken)).status, 403);
  assert.equal((await server.request('GET', `/api/coach/enrollments/${e._id}/questionnaire`)).status, 401);
});

test('7. the member read is unchanged by the coach endpoint', async () => {
  const e = await enroll(coachA);
  await seedQuestionnaire(e);
  const res = await server.request('GET', `/api/users/me/enrollments/${e._id}/questionnaire`, { token: memberToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.questionnaire.answers, fullAnswers);
});

// --- GET /api/coach/clients/:userId/questionnaires (Questionnaire History) ---

const history = (userId, token = coachAToken) =>
  server.request('GET', `/api/coach/clients/${userId}/questionnaires`, { token });

test('history: every submitted questionnaire across the client\'s enrollments with this coach, newest first', async () => {
  // Bought the same plan twice; answered only the first time.
  const first = await enroll(coachA, { enrollDate: new Date('2026-10-02') });
  const second = await enroll(coachA, { enrollDate: new Date('2026-10-24') });
  const q = await seedQuestionnaire(first);

  const res = await history(member._id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.total, 1);
  const [row] = res.body.data.questionnaires;
  assert.equal(row.questionnaireId, String(q._id));
  // Keeps its own enrollment - never shown as the newer one's.
  assert.equal(row.enrollmentId, String(first._id));
  assert.equal(row.enrollment.enrollDate, '2026-10-02T00:00:00.000Z');
  assert.deepEqual(row.answers, fullAnswers);
  assert.equal(res.body.data.questionnaires.some((x) => x.enrollmentId === String(second._id)), false);
  // The per-enrollment read is unchanged: the newer cycle still has none.
  assert.equal((await read(second._id)).body.data.questionnaire, null);

  // A later submission is listed on top, the older one kept as it was.
  const later = await seedQuestionnaire(second, { answers: { ...fullAnswers, city: 'Later' } });
  await Questionnaire.updateOne({ _id: later._id }, { $set: { submittedAt: new Date('2026-10-25T10:00:00Z') } });
  const both = (await history(member._id)).body.data.questionnaires;
  assert.deepEqual(both.map((x) => x.answers.city), ['Later', 'Banglore']);
});

test('history: drafts, deleted enrollments and other coaches\' enrollments are left out', async () => {
  const mine = await enroll(coachA);
  await seedQuestionnaire(mine, { status: 'draft' });
  const deleted = await enroll(coachA, { isDeleted: true });
  await seedQuestionnaire(deleted);
  const theirs = await enroll(coachB);
  await seedQuestionnaire(theirs, { answers: { ...fullAnswers, city: 'Theirs' } });

  const res = await history(member._id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { questionnaires: [], total: 0 });
  // Coach B sees only their own enrollment's submission.
  const b = (await history(member._id, coachBToken)).body.data.questionnaires;
  assert.deepEqual(b.map((x) => x.answers.city), ['Theirs']);
});

test('history: a member who is not this coach\'s client is a 404; members 403; no token 401', async () => {
  const theirs = await enroll(coachB);
  await seedQuestionnaire(theirs);
  for (const id of [member._id, new mongoose.Types.ObjectId(), 'nope']) {
    const res = await history(id);
    assert.equal(res.status, 404, String(id));
    assert.equal(res.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
    assert.equal(JSON.stringify(res.body).includes('Banglore'), false);
  }
  assert.equal((await history(member._id, memberToken)).status, 403);
  assert.equal((await server.request('GET', `/api/coach/clients/${member._id}/questionnaires`)).status, 401);
});
