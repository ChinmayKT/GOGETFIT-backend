import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import Questionnaire from '../../src/models/questionnaire.model.js';
import User from '../../src/models/user.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * GET /api/coach/clients — the Coach Workspace's Clients tab.
 *
 * One row per member, carrying their current/latest enrollment with the coach;
 * every cycle stays reachable through GET /api/coach/clients/:userId/enrollments.
 * The coach comes from the token, so a coach can only ever read their own.
 */
let server;
let coachA;
let coachB;
let coachAToken;
let coachBToken;
let memberToken;
let plan;

const DAY = 24 * 60 * 60 * 1000;
const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const PLAN_IMAGE = { url: 'http://example.test/uploads/plans/p1/cover.jpg', storageKey: 'plans/p1/cover.jpg' };
const CLIENT_PICTURE = 'http://example.test/uploads/profile/client.jpg';

let seq = 0;
const seedUser = ({ roles = ['user', 'client'], name, profilePicture = null } = {}) => {
  seq += 1;
  const phone = `9182000${String(seq).padStart(5, '0')}`;
  return User.create({
    phone: { raw: phone, normalized: phone },
    profile: { name: name ?? `Client ${seq}`, email: `c${seq}@example.com`, profilePicture },
    roles,
    status: 'active',
  });
};

const seedCoach = async () => {
  const user = await seedUser({ roles: ['user', 'coach'] });
  const coach = await Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' } });
  return { user, coach };
};

let txn = 0;
/** One enrollment with [coach]; `kind` decides its state relative to now. */
const enroll = async (coach, kind, { member, planDoc } = {}) => {
  txn += 1;
  const client = member ?? (await seedUser({ profilePicture: CLIENT_PICTURE }));
  const now = Date.now();
  const states = {
    active: { hasStarted: true, startDate: new Date(now - 10 * DAY), endDate: new Date(now + 30 * DAY) },
    pending: { hasStarted: false, startDate: null, endDate: null },
    ended: { hasStarted: true, startDate: new Date(now - 100 * DAY), endDate: new Date(now - 1 * DAY) },
    deleted: { hasStarted: true, startDate: new Date(now - 10 * DAY), endDate: new Date(now + 30 * DAY), isDeleted: true },
  };
  const doc = await EnrolledClient.create({
    userId: client._id,
    planId: (planDoc ?? plan)._id,
    coachId: coach._id,
    enrollDate: new Date(now - (20 + txn) * DAY),
    isDeleted: false,
    ...states[kind],
    payment: { transactionId: `pay_clients_${txn}`, amount: 4999, currency: 'INR', status: 'Success' },
  });
  return { client, enrollment: doc };
};

const clients = (token = coachAToken, qs = '') =>
  server.request('GET', `/api/coach/clients${qs}`, { token });

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
    image: PLAN_IMAGE,
  });
  const a = await seedCoach();
  const b = await seedCoach();
  coachA = a.coach;
  coachB = b.coach;
  coachAToken = tokenFor(a.user);
  coachBToken = tokenFor(b.user);
  memberToken = tokenFor(await seedUser());
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('a coach sees only their own clients', async () => {
  await enroll(coachA, 'active');
  await enroll(coachA, 'active');
  await enroll(coachB, 'active');

  const mine = await clients(coachAToken);
  const theirs = await clients(coachBToken);

  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.clients.length, 2);
  assert.equal(theirs.body.data.clients.length, 1);
  // Nothing of coach B's appears in coach A's list.
  const bIds = theirs.body.data.clients.map((c) => c.enrollmentId);
  for (const row of mine.body.data.clients) {
    assert.equal(bIds.includes(row.enrollmentId), false);
  }
});

test('active, pending and ended are reported per enrollment and counted', async () => {
  await enroll(coachA, 'active');
  await enroll(coachA, 'pending');
  await enroll(coachA, 'ended');

  const res = await clients();
  const byStatus = Object.fromEntries(
    res.body.data.clients.map((c) => [c.status, c]),
  );

  assert.equal(byStatus.active.hasStarted, true);
  assert.equal(byStatus.not_started.hasStarted, false, 'bought, not begun');
  assert.equal(byStatus.not_started.startDate, null, 'no window is invented');
  assert.equal(byStatus.inactive.hasStarted, true, 'it ran, and is over');

  assert.deepEqual(res.body.data.summary, {
    total: 3,
    uniqueClients: 3,
    active: 1,
    pending: 1,
    ended: 1,
  });
});

test('deleted enrollments are excluded, from the rows and the counts', async () => {
  await enroll(coachA, 'active');
  const removed = await enroll(coachA, 'deleted');

  const res = await clients();

  assert.equal(res.body.data.clients.length, 1);
  assert.equal(res.body.data.summary.total, 1);
  assert.equal(
    res.body.data.clients.some((c) => c.enrollmentId === String(removed.enrollment._id)),
    false,
  );
});

test('each row carries the client and the plan the app renders', async () => {
  const { client } = await enroll(coachA, 'active');

  const res = await clients();
  const row = res.body.data.clients[0];

  assert.equal(row.client.userId, String(client._id));
  assert.equal(row.client.name, client.profile.name);
  assert.equal(row.client.profilePicture, CLIENT_PICTURE);
  assert.equal(row.client.phone, client.phone.normalized);
  assert.equal(row.client.email, client.profile.email);

  assert.equal(row.plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.deepEqual(row.plan.image, PLAN_IMAGE);

  assert.ok(row.enrollmentId, 'the cycle every later screen is scoped to');
  assert.ok(row.enrollDate);
});

test('two enrollments with the same coach are one client, carrying the current one', async () => {
  const member = await seedUser({ name: 'Returning Client' });
  await enroll(coachA, 'ended', { member });
  const second = await enroll(coachA, 'active', { member });

  const res = await clients();

  assert.equal(res.body.data.clients.length, 1, 'one person, one row');
  const [row] = res.body.data.clients;
  assert.equal(row.client.userId, String(member._id));
  assert.equal(row.enrollmentId, String(second.enrollment._id), 'the active cycle is current');
  assert.equal(row.enrollmentCount, 2);
  assert.equal(res.body.data.pagination.total, 1, 'people, not purchases');
  // The summary still reports both: cycles and people.
  assert.equal(res.body.data.summary.total, 2);
  assert.equal(res.body.data.summary.uniqueClients, 1);
});

test('three or more enrollments are still one client', async () => {
  const member = await seedUser({ name: 'Loyal Client' });
  await enroll(coachA, 'ended', { member });
  await enroll(coachA, 'ended', { member });
  await enroll(coachA, 'pending', { member });
  await enroll(coachA, 'active');

  const res = await clients();

  assert.equal(res.body.data.clients.length, 2);
  assert.equal(new Set(res.body.data.clients.map((c) => c.client.userId)).size, 2);
  const loyal = res.body.data.clients.find((c) => c.client.userId === String(member._id));
  assert.equal(loyal.enrollmentCount, 3);
});

test('with no active cycle, the newest enrollment is the current one', async () => {
  const member = await seedUser();
  // enroll() dates each call a day earlier than the previous one.
  const newest = await enroll(coachA, 'ended', { member });
  await enroll(coachA, 'ended', { member });

  const [row] = (await clients()).body.data.clients;

  assert.equal(row.enrollmentId, String(newest.enrollment._id));
});

test('pages and totals count unique members, not enrollments', async () => {
  // 3 members, 6 enrollments.
  for (let i = 0; i < 3; i += 1) {
    const member = await seedUser();
    for (let j = 0; j <= i; j += 1) await enroll(coachA, j === i ? 'active' : 'ended', { member });
  }

  const first = await clients(coachAToken, '?page=1&pageSize=2');
  const second = await clients(coachAToken, '?page=2&pageSize=2');

  assert.deepEqual(first.body.data.pagination, { page: 1, pageSize: 2, total: 3, totalPages: 2 });
  assert.equal(first.body.data.clients.length, 2);
  assert.equal(second.body.data.clients.length, 1);
  const users = [...first.body.data.clients, ...second.body.data.clients].map((c) => c.client.userId);
  assert.equal(new Set(users).size, 3, 'every member once across pages');
});

test('search matches the member once, however many enrollments they have', async () => {
  const chethan = await seedUser({ name: 'Chethan Kumar' });
  await enroll(coachA, 'ended', { member: chethan });
  await enroll(coachA, 'active', { member: chethan });
  await enroll(coachA, 'active', { member: await seedUser({ name: 'Poorvi' }) });

  const res = await clients(coachAToken, '?search=chethan');

  assert.equal(res.body.data.clients.length, 1);
  assert.equal(res.body.data.clients[0].client.userId, String(chethan._id));
  assert.equal(res.body.data.pagination.total, 1);

  const byPhone = await clients(coachAToken, `?search=${chethan.phone.normalized}`);
  assert.equal(byPhone.body.data.clients.length, 1);
});

test('a member with two coaches is one row in each list, each with that coach\'s cycle', async () => {
  const member = await seedUser();
  const withA = await enroll(coachA, 'ended', { member });
  const withB = await enroll(coachB, 'active', { member });

  const a = (await clients(coachAToken)).body.data.clients;
  const b = (await clients(coachBToken)).body.data.clients;

  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].enrollmentId, String(withA.enrollment._id));
  assert.equal(b[0].enrollmentId, String(withB.enrollment._id));
  assert.equal(a[0].enrollmentCount, 1, 'only coach A\'s cycles are counted for coach A');
});

test('newest first', async () => {
  await enroll(coachA, 'active');
  await enroll(coachA, 'active');

  const res = await clients();
  const dates = res.body.data.clients.map((c) => Date.parse(c.enrollDate));

  assert.deepEqual([...dates].sort((a, b) => b - a), dates);
});

test('a coach with no clients gets an empty list, not an error', async () => {
  const res = await clients();

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.clients, []);
  assert.equal(res.body.data.summary.total, 0);
});

test('a member cannot read the coach client list', async () => {
  await enroll(coachA, 'active');

  const res = await clients(memberToken);

  assert.equal(res.status, 403);
});

test('an unauthenticated caller is refused', async () => {
  const res = await server.request('GET', '/api/coach/clients');

  assert.equal(res.status, 401);
});

test('a coachId in the query is ignored — the token decides', async () => {
  await enroll(coachA, 'active');
  await enroll(coachB, 'active');
  await enroll(coachB, 'active');

  const res = await server.request(
    'GET',
    `/api/coach/clients?coachId=${String(coachB._id)}`,
    { token: coachAToken },
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.data.clients.length, 1, "still only coach A's");
});

// ---- Pagination ------------------------------------------------------------

test('the roster is paged, newest first, with no member repeated or skipped', async () => {
  for (let i = 0; i < 5; i += 1) await enroll(coachA, 'active');

  const first = await clients(coachAToken, '?page=1&pageSize=2');
  const second = await clients(coachAToken, '?page=2&pageSize=2');
  const third = await clients(coachAToken, '?page=3&pageSize=2');

  assert.equal(first.body.data.clients.length, 2);
  assert.equal(second.body.data.clients.length, 2);
  assert.equal(third.body.data.clients.length, 1, 'the last page is short');

  assert.deepEqual(first.body.data.pagination, {
    page: 1,
    pageSize: 2,
    total: 5,
    totalPages: 3,
  });

  // Every cycle appears exactly once across the pages.
  const ids = [
    ...first.body.data.clients,
    ...second.body.data.clients,
    ...third.body.data.clients,
  ].map((c) => c.enrollmentId);
  assert.equal(new Set(ids).size, 5);

  // And the order holds across the page boundary.
  const dates = [
    ...first.body.data.clients,
    ...second.body.data.clients,
    ...third.body.data.clients,
  ].map((c) => Date.parse(c.enrollDate));
  assert.deepEqual([...dates].sort((a, b) => b - a), dates);
});

test('the counts describe the whole roster, not the page', async () => {
  await enroll(coachA, 'active');
  await enroll(coachA, 'pending');
  await enroll(coachA, 'ended');

  const res = await clients(coachAToken, '?page=1&pageSize=1');

  assert.equal(res.body.data.clients.length, 1);
  assert.equal(res.body.data.summary.total, 3, 'the roster, not the page');
  assert.equal(res.body.data.summary.active, 1);
  assert.equal(res.body.data.summary.pending, 1);
  assert.equal(res.body.data.summary.ended, 1);
});

test('a page past the end is empty rather than an error', async () => {
  await enroll(coachA, 'active');

  const res = await clients(coachAToken, '?page=9&pageSize=10');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.clients, []);
  assert.equal(res.body.data.pagination.page, 9);
});

test('a nonsense page is refused rather than guessed', async () => {
  for (const qs of ['?page=0', '?page=-1', '?pageSize=0', '?page=abc']) {
    const res = await clients(coachAToken, qs);
    assert.equal(res.status, 400, qs);
  }
});

test('pageSize is capped, so one request cannot ask for everything', async () => {
  await enroll(coachA, 'active');

  const res = await clients(coachAToken, '?pageSize=100000');

  assert.equal(res.status, 200);
  assert.equal(res.body.data.pagination.pageSize, 100, 'the cap');
});

// ---- Enrollment history: GET /api/coach/clients/:userId/enrollments ------------

const history = (userId, token = coachAToken) =>
  server.request('GET', `/api/coach/clients/${userId}/enrollments`, { token });

test('questionnaireSubmitted: true only for the cycle whose questionnaire is submitted', async () => {
  const { client, enrollment: submitted } = await enroll(coachA, 'active');
  const { enrollment: draft } = await enroll(coachA, 'pending', { member: client });
  const { enrollment: none } = await enroll(coachA, 'ended', { member: client });
  await Questionnaire.create({ userId: client._id, enrollmentId: submitted._id, coachId: coachA._id, answers: { gender: 'Male' }, status: 'submitted', submittedAt: new Date() });
  // A draft - even one submitted once before - does not count.
  await Questionnaire.create({ userId: client._id, enrollmentId: draft._id, coachId: coachA._id, answers: { gender: 'Male' }, status: 'draft', submittedAt: new Date() });

  const rows = (await history(client._id)).body.data.enrollments;
  const byId = Object.fromEntries(rows.map((r) => [r.enrollmentId, r.questionnaireSubmitted]));
  assert.deepEqual(byId, { [String(submitted._id)]: true, [String(draft._id)]: false, [String(none._id)]: false });
  // And the list row carries the current cycle's flag.
  const [row] = (await clients()).body.data.clients;
  assert.equal(row.questionnaireSubmitted, true);
});

test('history returns every cycle, current first, then newest to oldest', async () => {
  const member = await seedUser({ name: 'Chethan Kumar' });
  // enroll() dates each call a day earlier than the previous one.
  const newerEnded = await enroll(coachA, 'ended', { member });
  const current = await enroll(coachA, 'active', { member });
  const oldest = await enroll(coachA, 'ended', { member });

  const res = await history(member._id);

  assert.equal(res.status, 200);
  const { client, enrollments } = res.body.data;
  assert.equal(client.userId, String(member._id));
  assert.equal(client.name, 'Chethan Kumar');
  assert.deepEqual(
    enrollments.map((e) => e.enrollmentId),
    [current, newerEnded, oldest].map((e) => String(e.enrollment._id)),
    'an active cycle is current even when a later one exists; the rest newest first',
  );
  assert.deepEqual(enrollments.map((e) => e.isCurrent), [true, false, false]);
  assert.equal(enrollments[0].status, 'active');
  assert.equal(enrollments[2].status, 'inactive');
});

test('history entries carry plan, dates, status and coach', async () => {
  const { client, enrollment } = await enroll(coachA, 'ended');

  const [entry] = (await history(client._id)).body.data.enrollments;

  assert.equal(entry.enrollmentId, String(enrollment._id));
  assert.equal(entry.plan.name, '12 WEEKS GOGETFIT PLAN');
  assert.equal(entry.startDate, enrollment.startDate.toISOString());
  assert.equal(entry.endDate, enrollment.endDate.toISOString());
  assert.equal(entry.enrollDate, enrollment.enrollDate.toISOString());
  assert.equal(entry.status, 'inactive');
  assert.equal(entry.isCurrent, false, 'nothing active, so the top card is only the latest');
  assert.equal(entry.coach.id, String(coachA._id));
  assert.ok(entry.coach.name);
});

test('history never includes another coach\'s cycles', async () => {
  const member = await seedUser();
  const mine = await enroll(coachA, 'ended', { member });
  await enroll(coachB, 'active', { member });

  const res = await history(member._id);

  assert.deepEqual(res.body.data.enrollments.map((e) => e.enrollmentId), [String(mine.enrollment._id)]);
});

test('history of a member with no cycle with this coach is 404', async () => {
  const { client } = await enroll(coachB, 'active');

  const theirs = await history(client._id);
  const nobody = await history('64b7f0000000000000000000');
  const garbage = await history('not-an-id');

  assert.equal(theirs.status, 404);
  assert.equal(nobody.status, 404);
  assert.equal(garbage.status, 404);
});

test('deleted cycles stay out of the history', async () => {
  const member = await seedUser();
  const kept = await enroll(coachA, 'ended', { member });
  await enroll(coachA, 'deleted', { member });

  const res = await history(member._id);

  assert.deepEqual(res.body.data.enrollments.map((e) => e.enrollmentId), [String(kept.enrollment._id)]);
});

test('history is coach-only', async () => {
  const { client } = await enroll(coachA, 'active');

  assert.equal((await history(client._id, memberToken)).status, 403);
  assert.equal((await server.request('GET', `/api/coach/clients/${client._id}/enrollments`)).status, 401);
});

test('reading the list and the history modifies no enrollment', async () => {
  const member = await seedUser();
  await enroll(coachA, 'ended', { member });
  await enroll(coachA, 'active', { member });
  const before = await EnrolledClient.find().sort({ _id: 1 }).lean();

  await clients();
  await clients(coachAToken, '?search=client');
  await history(member._id);

  const after = await EnrolledClient.find().sort({ _id: 1 }).lean();
  assert.deepEqual(after, before);
});
