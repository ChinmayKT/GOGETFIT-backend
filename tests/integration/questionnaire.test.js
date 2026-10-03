import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import User from '../../src/models/user.model.js';
import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import Questionnaire from '../../src/models/questionnaire.model.js';
import { REQUIRED_QUESTION_KEYS } from '../../src/constants/questionnaire-definition.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * The member's own questionnaire, one per enrollment.
 *
 * The security tests here are the point of the file: the only id a client sends
 * is the enrollment's, and these pin down that it buys nothing - not another
 * member's enrollment, not another member's questionnaire, not a deleted
 * enrollment, and not a userId or coachId of the caller's choosing.
 */

let server;
let member;
let memberToken;
let otherMember;
let otherToken;
let coach;
let secondCoach;
let plan;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const seedUser = (phone, roles = ['user'], name) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: name ?? `User ${phone}` }, roles, status: 'active' });

const seedCoach = async (phone, name, level = 'LEVEL 1') => {
  const coachUser = await seedUser(phone, ['user', 'coach'], name);
  return Coach.create({ userId: coachUser._id, profile: { level }, status: 'active' });
};

const days = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
};

const seedEnrollment = (overrides = {}) =>
  EnrolledClient.create({
    userId: member._id,
    planId: plan._id,
    coachId: coach._id,
    enrollDate: days(-30),
    startDate: days(-29),
    endDate: days(55),
    hasStarted: true,
    isDeleted: false,
    createdBy: member._id,
    updatedBy: member._id,
    ...overrides,
  });

/** A complete set of the eight answers the app's step gate requires. */
const requiredAnswers = (overrides = {}) => ({
  gender: 'Male',
  age: '25',
  height: '5.7',
  weight: '70',
  goal: 'Fat / Weight Loss',
  contactTime: 'Weekdays',
  foodPref: 'Vegetarian + Egg',
  workoutPref: 'Gym Workout',
  ...overrides,
});

const path = (enrollmentId) => `/api/users/me/enrollments/${enrollmentId}/questionnaire`;

const save = (enrollmentId, body, token = memberToken) =>
  server.request('POST', path(enrollmentId), { body, token });

const read = (enrollmentId, token = memberToken) =>
  server.request('GET', path(enrollmentId), { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  member = await seedUser('919000000001', ['user'], 'Rohit Sharma');
  memberToken = tokenFor(member);
  otherMember = await seedUser('919000000002', ['user'], 'Someone Else');
  otherToken = tokenFor(otherMember);
  coach = await seedCoach('917000000001', 'Coach Prajwal');
  secondCoach = await seedCoach('917000000002', 'Coach Anita', 'LEVEL 2');
  plan = await GogetfitPlan.create({
    name: '12 WEEKS GOGETFIT PLAN',
    planType: 'Enrollment',
    coachLevel: 'LEVEL 1',
    durationWeeks: 12,
    personsAllowed: 1,
    pricing: { basePrice: 4999, reward: null },
    status: 'active',
  });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('both questionnaire routes require authentication', async () => {
  const enrollment = await seedEnrollment();

  assert.equal((await server.request('GET', path(enrollment._id), {})).status, 401);
  assert.equal((await server.request('POST', path(enrollment._id), { body: { answers: {} } })).status, 401);
});

test('a draft is created with incomplete answers', async () => {
  const enrollment = await seedEnrollment();

  const res = await save(enrollment._id, { answers: { gender: 'Male', age: '31' }, status: 'draft' });

  assert.equal(res.status, 201);
  const q = res.body.data.questionnaire;
  assert.equal(q.status, 'draft');
  assert.equal(q.submittedAt, null);
  assert.deepEqual(q.answers, { gender: 'Male', age: '31' });
  assert.equal(q.schemaVersion, 1);
  assert.ok(q.questionnaireId);
  assert.ok(q.createdAt);
  assert.ok(q.updatedAt);
});

test('status defaults to draft when the body omits it', async () => {
  const enrollment = await seedEnrollment();

  const res = await save(enrollment._id, { answers: { gender: 'Female' } });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.questionnaire.status, 'draft');
});

test('a submitted questionnaire stores every answer and stamps submittedAt', async () => {
  const enrollment = await seedEnrollment();

  const res = await save(enrollment._id, {
    answers: requiredAnswers({ trainingLevel: 7, allergies: 'Peanuts', city: 'Bengaluru' }),
    status: 'submitted',
  });

  assert.equal(res.status, 201);
  const q = res.body.data.questionnaire;
  assert.equal(q.status, 'submitted');
  assert.ok(q.submittedAt, 'submittedAt must be set on submit');
  assert.equal(q.answers.trainingLevel, 7);
  assert.equal(q.answers.allergies, 'Peanuts');
  assert.equal(q.answers.city, 'Bengaluru');
});

test('submitting without every required answer is refused and nothing is stored', async () => {
  const enrollment = await seedEnrollment();
  const { gender, age } = requiredAnswers();

  const res = await save(enrollment._id, { answers: { gender, age }, status: 'submitted' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.ok(res.body.error.message.includes('weight'), res.body.error.message);
  assert.equal(await Questionnaire.countDocuments({}), 0);
});

test('the eight required keys are exactly the ones the app gates on', () => {
  assert.deepEqual(REQUIRED_QUESTION_KEYS, [
    'gender',
    'age',
    'height',
    'weight',
    'goal',
    'contactTime',
    'foodPref',
    'workoutPref',
  ]);
});

test('female-only questions are accepted for a female member and refused otherwise', async () => {
  const enrollment = await seedEnrollment();

  const female = await save(enrollment._id, {
    answers: requiredAnswers({ gender: 'Female', periodCramps: 6, moodSwings: 3 }),
    status: 'submitted',
  });
  assert.equal(female.status, 201);
  assert.equal(female.body.data.questionnaire.answers.periodCramps, 6);

  const male = await save(enrollment._id, {
    answers: requiredAnswers({ gender: 'Male', periodCramps: 6 }),
    status: 'submitted',
  });
  assert.equal(male.status, 400);
  assert.ok(male.body.error.message.includes('periodCramps'));
});

test('a male member may submit without the two female-only answers', async () => {
  const enrollment = await seedEnrollment();

  const res = await save(enrollment._id, { answers: requiredAnswers({ gender: 'Male' }), status: 'submitted' });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.questionnaire.answers.periodCramps, undefined);
  assert.equal(res.body.data.questionnaire.answers.moodSwings, undefined);
});

test('invalid keys, types and option values are refused', async () => {
  const enrollment = await seedEnrollment();

  const cases = [
    [{ answers: { notAQuestion: 'x' } }, 'Unknown question key'],
    [{ answers: { goal: 'Get Swole' } }, 'goal'],
    [{ answers: { trainingLevel: '7' } }, 'whole number'],
    [{ answers: { trainingLevel: 11 } }, 'between 0 and 10'],
    [{ answers: { height: '170' } }, 'height'],
    [{ answers: { allergies: 'x'.repeat(201) } }, '200 characters'],
    [{ answers: {}, status: 'archived' }, 'status'],
    [{ answers: [] }, 'answers must be an object'],
  ];

  for (const [body, fragment] of cases) {
    const res = await save(enrollment._id, body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 60)}`);
    assert.ok(
      res.body.error.message.includes(fragment),
      `expected "${fragment}" in "${res.body.error.message}"`,
    );
  }

  assert.equal(await Questionnaire.countDocuments({}), 0);
});

test('the questionnaire is read back with everything the app needs', async () => {
  const enrollment = await seedEnrollment();
  await save(enrollment._id, { answers: requiredAnswers({ injuries: 'None' }), status: 'submitted' });

  const res = await read(enrollment._id);

  assert.equal(res.status, 200);
  const q = res.body.data.questionnaire;
  assert.equal(q.enrollmentId, String(enrollment._id));
  assert.equal(q.coachId, String(coach._id));
  assert.equal(q.schemaVersion, 1);
  assert.equal(q.status, 'submitted');
  assert.equal(q.answers.injuries, 'None');
  assert.ok(q.submittedAt);
  assert.ok(q.createdAt);
  assert.ok(q.updatedAt);
  assert.ok(q.questionnaireId);
});

test('saving again updates the one questionnaire instead of creating a second', async () => {
  const enrollment = await seedEnrollment();

  const first = await save(enrollment._id, { answers: { gender: 'Male', city: 'Mysuru' }, status: 'draft' });
  assert.equal(first.status, 201);

  const second = await save(enrollment._id, {
    answers: requiredAnswers({ city: 'Bengaluru' }),
    status: 'submitted',
  });

  assert.equal(second.status, 200, 'an update is 200, not another 201');
  assert.equal(second.body.data.questionnaire.questionnaireId, first.body.data.questionnaire.questionnaireId);
  assert.equal(await Questionnaire.countDocuments({ enrollmentId: enrollment._id }), 1);

  const after = await read(enrollment._id);
  assert.equal(after.body.data.questionnaire.answers.city, 'Bengaluru');
  assert.equal(after.body.data.questionnaire.status, 'submitted');
});

test('answers are replaced, not merged, so a cleared answer really clears', async () => {
  const enrollment = await seedEnrollment();
  await save(enrollment._id, { answers: { gender: 'Male', allergies: 'Peanuts' } });

  await save(enrollment._id, { answers: { gender: 'Male' } });

  const res = await read(enrollment._id);
  assert.deepEqual(res.body.data.questionnaire.answers, { gender: 'Male' });
});

test('an empty answer is treated as unanswered rather than stored', async () => {
  const enrollment = await seedEnrollment();

  const res = await save(enrollment._id, { answers: { gender: 'Male', city: '   ', allergies: '' } });

  assert.deepEqual(res.body.data.questionnaire.answers, { gender: 'Male' });
});

test('the submittedAt of the first submission survives a later correction', async () => {
  const enrollment = await seedEnrollment();
  const submitted = await save(enrollment._id, { answers: requiredAnswers(), status: 'submitted' });
  const first = submitted.body.data.questionnaire.submittedAt;

  await new Promise((resolve) => setTimeout(resolve, 20));
  const corrected = await save(enrollment._id, {
    answers: requiredAnswers({ city: 'Mangaluru' }),
    status: 'submitted',
  });

  assert.equal(corrected.body.data.questionnaire.submittedAt, first);
  assert.notEqual(corrected.body.data.questionnaire.updatedAt, submitted.body.data.questionnaire.updatedAt);
});

test('REGRESSION: a draft save can never un-submit a questionnaire', async () => {
  const enrollment = await seedEnrollment();
  const submitted = await save(enrollment._id, { answers: requiredAnswers({ city: 'Bengaluru' }), status: 'submitted' });
  assert.equal(submitted.body.data.questionnaire.status, 'submitted');

  // What the app does on every finished step and whenever the form is left. It
  // used to flip the record back to `draft`, which made the member's History,
  // the admin portal and the app's own completed state all disagree.
  const late = await save(enrollment._id, { answers: requiredAnswers({ city: 'Mysuru' }), status: 'draft' });

  assert.equal(late.status, 200);
  assert.equal(late.body.data.questionnaire.status, 'submitted');
  assert.ok(late.body.data.questionnaire.submittedAt);
  // The answers still update - only the status is refused.
  assert.equal(late.body.data.questionnaire.answers.city, 'Mysuru');

  const stored = await Questionnaire.findOne({ enrollmentId: enrollment._id }).lean();
  assert.equal(stored.status, 'submitted');

  // And it is still in History, which is what the member sees.
  const history = await server.request('GET', '/api/users/me/questionnaires?status=submitted', { token: memberToken });
  assert.equal(history.body.data.total, 1);
});

test('the whole lifecycle: draft, submit, read back, history', async () => {
  const enrollment = await seedEnrollment();

  // 1. A half-filled draft.
  const draft = await save(enrollment._id, { answers: { gender: 'Male', city: 'Bengaluru' }, status: 'draft' });
  assert.equal(draft.body.data.questionnaire.status, 'draft');
  assert.equal(draft.body.data.questionnaire.submittedAt, null);
  assert.equal((await Questionnaire.findOne({ enrollmentId: enrollment._id }).lean()).status, 'draft');

  // 2. It is NOT history yet.
  const beforeHistory = await server.request('GET', '/api/users/me/questionnaires?status=submitted', { token: memberToken });
  assert.equal(beforeHistory.body.data.total, 0);

  // 3. Submitting flips it, exactly once, and stamps the time.
  const submitted = await save(enrollment._id, { answers: requiredAnswers({ city: 'Bengaluru' }), status: 'submitted' });
  assert.equal(submitted.body.data.questionnaire.status, 'submitted');
  assert.ok(submitted.body.data.questionnaire.submittedAt);

  const stored = await Questionnaire.findOne({ enrollmentId: enrollment._id }).lean();
  assert.equal(stored.status, 'submitted');
  assert.ok(stored.submittedAt instanceof Date);
  assert.equal(stored.answers.city, 'Bengaluru');
  assert.equal(await Questionnaire.countDocuments({ enrollmentId: enrollment._id }), 1);

  // 4. The single read agrees.
  const read1 = await read(enrollment._id);
  assert.equal(read1.body.data.questionnaire.status, 'submitted');

  // 5. And History has it.
  const history = await server.request('GET', '/api/users/me/questionnaires?status=submitted', { token: memberToken });
  assert.equal(history.body.data.total, 1);
  assert.equal(history.body.data.questionnaires[0].questionnaireId, submitted.body.data.questionnaire.questionnaireId);
  assert.equal(history.body.data.questionnaires[0].answers.city, 'Bengaluru');
});

test('the duplicate index holds even against a direct insert', async () => {
  const enrollment = await seedEnrollment();
  await save(enrollment._id, { answers: { gender: 'Male' } });

  await assert.rejects(
    () =>
      Questionnaire.create({
        userId: member._id,
        enrollmentId: enrollment._id,
        coachId: coach._id,
        answers: { gender: 'Female' },
        status: 'draft',
      }),
    (error) => error.code === 11000,
  );
});

test('userId comes from the token, not from anything the client sends', async () => {
  const enrollment = await seedEnrollment();

  // Sending a userId at all is refused rather than quietly ignored.
  const spoofed = await save(enrollment._id, {
    answers: requiredAnswers(),
    status: 'draft',
    userId: String(otherMember._id),
  });
  assert.equal(spoofed.status, 400);
  assert.ok(spoofed.body.error.message.includes('userId'));

  await save(enrollment._id, { answers: requiredAnswers(), status: 'draft' });
  const stored = await Questionnaire.findOne({ enrollmentId: enrollment._id }).lean();
  assert.equal(String(stored.userId), String(member._id));
});

test('coachId comes from the enrollment, not from the request', async () => {
  const enrollment = await seedEnrollment({ coachId: secondCoach._id });

  const sent = await save(enrollment._id, {
    answers: requiredAnswers(),
    status: 'draft',
    coachId: String(coach._id),
  });
  assert.equal(sent.status, 400);
  assert.ok(sent.body.error.message.includes('coachId'));

  const res = await save(enrollment._id, { answers: requiredAnswers(), status: 'draft' });
  assert.equal(res.body.data.questionnaire.coachId, String(secondCoach._id));
});

test('a coach reassignment on the enrollment moves the questionnaire with it', async () => {
  const enrollment = await seedEnrollment();
  await save(enrollment._id, { answers: { gender: 'Male' } });

  await EnrolledClient.updateOne({ _id: enrollment._id }, { $set: { coachId: secondCoach._id } });
  await save(enrollment._id, { answers: { gender: 'Male', city: 'Hubballi' } });

  const res = await read(enrollment._id);
  assert.equal(res.body.data.questionnaire.coachId, String(secondCoach._id));
});

test("another member's enrollment is refused for both reading and writing", async () => {
  const enrollment = await seedEnrollment();
  await save(enrollment._id, { answers: requiredAnswers(), status: 'submitted' });

  const readAttempt = await read(enrollment._id, otherToken);
  const writeAttempt = await save(enrollment._id, { answers: { gender: 'Female' } }, otherToken);

  assert.equal(readAttempt.status, 404);
  assert.equal(readAttempt.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
  assert.equal(writeAttempt.status, 404);
  // The intruder changed nothing.
  const stored = await Questionnaire.findOne({ enrollmentId: enrollment._id }).lean();
  assert.equal(String(stored.userId), String(member._id));
  assert.equal(stored.answers.gender, 'Male');
  assert.equal(await Questionnaire.countDocuments({}), 1);
});

test("another member's questionnaire cannot be reached by guessing enrollment ids", async () => {
  const mine = await seedEnrollment();
  const theirs = await EnrolledClient.create({
    userId: otherMember._id,
    planId: plan._id,
    coachId: coach._id,
    enrollDate: days(-10),
    startDate: days(-9),
    endDate: days(75),
    hasStarted: true,
    isDeleted: false,
  });
  await save(mine._id, { answers: { gender: 'Male' } });
  await save(theirs._id, { answers: { gender: 'Female' } }, otherToken);

  // Each member sees only their own, and neither can read across.
  assert.equal((await read(theirs._id)).status, 404);
  assert.equal((await read(mine._id, otherToken)).status, 404);
  assert.equal((await read(mine._id)).body.data.questionnaire.answers.gender, 'Male');
  assert.equal((await read(theirs._id, otherToken)).body.data.questionnaire.answers.gender, 'Female');
});

test('a soft-deleted enrollment is refused', async () => {
  const enrollment = await seedEnrollment({ isDeleted: true });

  assert.equal((await read(enrollment._id)).status, 404);
  const write = await save(enrollment._id, { answers: { gender: 'Male' } });
  assert.equal(write.status, 404);
  assert.equal(write.body.error.code, 'ENROLLED_CLIENT_NOT_FOUND');
  assert.equal(await Questionnaire.countDocuments({}), 0);
});

test('an unknown or malformed enrollment id is refused, not crashed on', async () => {
  const unknown = new mongoose.Types.ObjectId();

  assert.equal((await read(unknown)).status, 404);
  assert.equal((await save(unknown, { answers: { gender: 'Male' } })).status, 404);
  assert.equal((await read('not-an-id')).status, 404);
  assert.equal((await save('not-an-id', { answers: { gender: 'Male' } })).status, 404);
});

test('an enrollment with no questionnaire yet returns 404, not an empty draft', async () => {
  const enrollment = await seedEnrollment();

  const res = await read(enrollment._id);

  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'QUESTIONNAIRE_NOT_FOUND');
  assert.equal(await Questionnaire.countDocuments({}), 0);
});

test('each enrollment keeps its own questionnaire - a second purchase never overwrites the first', async () => {
  const first = await seedEnrollment();
  const second = await seedEnrollment({
    coachId: secondCoach._id,
    enrollDate: days(-1),
    startDate: days(0),
    endDate: days(84),
  });

  await save(first._id, { answers: requiredAnswers({ city: 'Enrollment A city' }), status: 'submitted' });
  await save(second._id, { answers: requiredAnswers({ city: 'Enrollment B city' }), status: 'draft' });

  const a = await read(first._id);
  const b = await read(second._id);

  assert.equal(a.body.data.questionnaire.answers.city, 'Enrollment A city');
  assert.equal(a.body.data.questionnaire.status, 'submitted');
  assert.equal(a.body.data.questionnaire.coachId, String(coach._id));

  assert.equal(b.body.data.questionnaire.answers.city, 'Enrollment B city');
  assert.equal(b.body.data.questionnaire.status, 'draft');
  assert.equal(b.body.data.questionnaire.coachId, String(secondCoach._id));

  assert.notEqual(a.body.data.questionnaire.questionnaireId, b.body.data.questionnaire.questionnaireId);
  assert.equal(await Questionnaire.countDocuments({ userId: member._id }), 2);
});

test('the history lists only submitted questionnaires, newest first', async () => {
  const older = await seedEnrollment();
  const newer = await seedEnrollment({ coachId: secondCoach._id, enrollDate: days(-1) });
  const stillADraft = await seedEnrollment({ enrollDate: days(-2) });

  await save(older._id, { answers: requiredAnswers({ city: 'Older' }), status: 'submitted' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await save(newer._id, { answers: requiredAnswers({ city: 'Newer' }), status: 'submitted' });
  await save(stillADraft._id, { answers: { gender: 'Male' }, status: 'draft' });

  const res = await server.request('GET', '/api/users/me/questionnaires?status=submitted', { token: memberToken });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 2, 'the draft must not appear in history');
  const [first, second] = res.body.data.questionnaires;
  assert.equal(first.answers.city, 'Newer');
  assert.equal(second.answers.city, 'Older');
  assert.ok(res.body.data.questionnaires.every((q) => q.status === 'submitted'));
});

test('a history row carries the plan, the coach and the submission date', async () => {
  const enrollment = await seedEnrollment();
  await save(enrollment._id, { answers: requiredAnswers(), status: 'submitted' });

  const res = await server.request('GET', '/api/users/me/questionnaires?status=submitted', { token: memberToken });

  const [row] = res.body.data.questionnaires;
  assert.equal(row.enrollmentId, String(enrollment._id));
  assert.equal(row.plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.equal(row.plan.durationWeeks, 12);
  assert.equal(row.coach.name, 'Coach Prajwal');
  assert.equal(row.coach.level, 'LEVEL 1');
  assert.ok(row.submittedAt);
  // The answers travel with the row, so opening one needs no second request.
  assert.equal(row.answers.gender, 'Male');
});

test('the history is scoped to the authenticated user', async () => {
  const mine = await seedEnrollment();
  const theirs = await EnrolledClient.create({
    userId: otherMember._id,
    planId: plan._id,
    coachId: coach._id,
    enrollDate: days(-10),
    isDeleted: false,
  });
  await save(mine._id, { answers: requiredAnswers({ city: 'Mine' }), status: 'submitted' });
  await save(theirs._id, { answers: requiredAnswers({ city: 'Theirs' }), status: 'submitted' }, otherToken);

  const mineRes = await server.request('GET', '/api/users/me/questionnaires?status=submitted', { token: memberToken });
  const theirsRes = await server.request('GET', '/api/users/me/questionnaires?status=submitted', { token: otherToken });

  assert.equal(mineRes.body.data.total, 1);
  assert.equal(mineRes.body.data.questionnaires[0].answers.city, 'Mine');
  assert.equal(theirsRes.body.data.total, 1);
  assert.equal(theirsRes.body.data.questionnaires[0].answers.city, 'Theirs');
  // No userId parameter exists, and one cannot be smuggled in.
  const spoofed = await server.request(
    `GET`,
    `/api/users/me/questionnaires?status=submitted&userId=${otherMember._id}`,
    { token: memberToken },
  );
  assert.equal(spoofed.body.data.total, 1);
  assert.equal(spoofed.body.data.questionnaires[0].answers.city, 'Mine');
});

test('the history requires authentication and refuses an unknown status', async () => {
  assert.equal((await server.request('GET', '/api/users/me/questionnaires', {})).status, 401);

  const res = await server.request('GET', '/api/users/me/questionnaires?status=everything', { token: memberToken });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('a questionnaire on a deleted enrollment drops out of the history', async () => {
  const enrollment = await seedEnrollment();
  await save(enrollment._id, { answers: requiredAnswers(), status: 'submitted' });
  await EnrolledClient.updateOne({ _id: enrollment._id }, { $set: { isDeleted: true } });

  const res = await server.request('GET', '/api/users/me/questionnaires?status=submitted', { token: memberToken });

  assert.equal(res.body.data.total, 0);
});

test('without a status the history returns every questionnaire the member owns', async () => {
  const first = await seedEnrollment();
  const second = await seedEnrollment({ enrollDate: days(-3) });
  await save(first._id, { answers: requiredAnswers(), status: 'submitted' });
  await save(second._id, { answers: { gender: 'Male' }, status: 'draft' });

  const res = await server.request('GET', '/api/users/me/questionnaires', { token: memberToken });

  assert.equal(res.body.data.total, 2);
});

test('an empty history is an empty list, not a 404', async () => {
  await seedEnrollment();

  const res = await server.request('GET', '/api/users/me/questionnaires?status=submitted', { token: memberToken });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.questionnaires, []);
  assert.equal(res.body.data.total, 0);
});

test('a submitted questionnaire survives and is still readable afterwards', async () => {
  const enrollment = await seedEnrollment();
  await save(enrollment._id, { answers: requiredAnswers({ whyTransform: 'For my health' }), status: 'submitted' });

  // Nothing clears it: a later read returns the same answers.
  const first = await read(enrollment._id);
  const second = await read(enrollment._id);

  assert.equal(first.body.data.questionnaire.answers.whyTransform, 'For my health');
  assert.deepEqual(second.body.data.questionnaire, first.body.data.questionnaire);
});
