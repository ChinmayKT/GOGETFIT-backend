import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Faq from '../../src/models/faq.model.js';
import User from '../../src/models/user.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * FAQs (the new home of legacy m_faq): a question and its answer saved
 * together in one document; listed publicly (GET /api/faqs, no login - as
 * legacy GetFAQ) oldest first with a safe case-insensitive search over both;
 * created and edited only by an admin. No delete.
 */
let server;
let admin;
let adminToken;
let memberToken;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const seedUser = (phone, roles) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `User ${phone}` }, roles, status: 'active' });

const create = (body, token = adminToken) => server.request('POST', '/api/admin/faqs', { token, body });
const patch = (id, body, token = adminToken) => server.request('PATCH', `/api/admin/faqs/${id}`, { token, body });
const publicList = (search) =>
  server.request('GET', `/api/faqs${search === undefined ? '' : `?search=${encodeURIComponent(search)}`}`);

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  admin = await seedUser('918000000000', ['user', 'admin']);
  adminToken = tokenFor(admin);
  memberToken = tokenFor(await seedUser('918000000001', ['user', 'client']));
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('an admin creates a question and its answer together: one document', async () => {
  const res = await create({ question: '  How do I book a coach?  ', answer: '  Open Coach + Plans and pick a plan.  ' });
  assert.equal(res.status, 201);
  const { faq } = res.body.data;
  assert.equal(faq.question, 'How do I book a coach?');
  assert.equal(faq.answer, 'Open Coach + Plans and pick a plan.');
  assert.ok(faq.id && faq.createdAt && faq.updatedAt);
  const docs = await Faq.find({}).lean();
  assert.equal(docs.length, 1);
  assert.equal(String(docs[0].createdBy), String(admin._id));
  assert.equal(String(docs[0].updatedBy), String(admin._id));
});

test('a missing, blank or too long question or answer is refused and nothing is saved', async () => {
  for (const body of [
    { answer: 'A' },
    { question: 'Q' },
    { question: '   ', answer: 'A' },
    { question: 'Q', answer: ' \n\t ' },
    { question: 42, answer: 'A' },
    { question: 'Q'.repeat(501), answer: 'A' },
    { question: 'Q', answer: 'A'.repeat(5001) },
  ]) {
    const res = await create(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(res.body.error?.code ?? res.body.code, 'VALIDATION_ERROR');
  }
  assert.equal(await Faq.countDocuments(), 0);
});

test('the public list: everything, oldest first, no login needed', async () => {
  for (const q of ['First?', 'Second?', 'Third?']) await create({ question: q, answer: `Answer to ${q}` });
  const res = await publicList();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.faqs.map((f) => f.question), ['First?', 'Second?', 'Third?']);
  assert.deepEqual(Object.keys(res.body.data.faqs[0]).sort(), ['answer', 'id', 'question'], 'no admin fields');
  assert.equal((await publicList('')).body.data.faqs.length, 3, 'an empty search is everything');
});

test('migrated FAQs keep legacy faq_id order and come before ones created since', async () => {
  await create({ question: 'Made in the portal', answer: 'New' });
  await Faq.create([
    { question: 'Legacy 7', answer: 'x', legacy: { source: 'mysql', faqId: 7 } },
    { question: 'Legacy 2', answer: 'x', legacy: { source: 'mysql', faqId: 2 } },
  ]);
  const order = (await publicList()).body.data.faqs.map((f) => f.question);
  assert.deepEqual(order, ['Legacy 2', 'Legacy 7', 'Made in the portal']);
});

test('search: question or answer, partial and case-insensitive; special characters are literal', async () => {
  await create({ question: 'How much protein per day?', answer: 'About 1.6 g per kg.' });
  await create({ question: 'Can I change my coach?', answer: 'Yes - contact Fitness support.' });
  await create({ question: 'What is (C+) rating?', answer: 'A [beta] score.' });
  const names = async (s) => (await publicList(s)).body.data.faqs.map((f) => f.question);

  assert.deepEqual(await names('protein'), ['How much protein per day?'], 'question');
  assert.deepEqual(await names('FITNESS'), ['Can I change my coach?'], 'answer, any case');
  assert.deepEqual(await names('per'), ['How much protein per day?'], 'partial, both fields');
  assert.deepEqual(await names('(C+)'), ['What is (C+) rating?'], 'regex characters taken literally');
  assert.deepEqual(await names('[beta]'), ['What is (C+) rating?']);
  assert.deepEqual(await names('.*'), [], 'never a pattern');
  assert.deepEqual(await names('zzz-no-match'), []);
  assert.equal((await publicList('x'.repeat(101))).status, 400);
});

test('editing changes the question, the answer or both on the same record', async () => {
  const { id } = (await create({ question: 'Old question?', answer: 'Old answer.' })).body.data.faq;
  const editor = await seedUser('918000000002', ['user', 'admin']);

  let res = await patch(id, { question: 'New question?' }, tokenFor(editor));
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.data.faq.question, res.body.data.faq.answer], ['New question?', 'Old answer.']);
  res = await patch(id, { answer: 'New answer.' });
  assert.deepEqual([res.body.data.faq.question, res.body.data.faq.answer], ['New question?', 'New answer.']);
  res = await patch(id, { question: 'Both?', answer: 'Both.' });
  assert.equal(res.body.data.faq.id, id, 'same identity');

  const docs = await Faq.find({}).lean();
  assert.equal(docs.length, 1, 'never a second record');
  assert.equal(String(docs[0].createdBy), String(admin._id), 'creator kept');
  assert.equal((await patch(id, { question: '  ' })).status, 400, 'cannot blank it');
  assert.equal((await patch(id, {})).status, 400, 'nothing to change');
  assert.equal((await Faq.findById(id).lean()).question, 'Both?');
});

test('admin reads: the list with search, and one by id; bad ids are 404', async () => {
  const { id } = (await create({ question: 'Q1?', answer: 'A1' })).body.data.faq;
  const list = await server.request('GET', '/api/admin/faqs?search=q1', { token: adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 1);
  assert.equal(list.body.data.faqs[0].id, id);
  const one = await server.request('GET', `/api/admin/faqs/${id}`, { token: adminToken });
  assert.equal(one.body.data.faq.answer, 'A1');

  for (const bad of ['64b000000000000000000000', 'not-an-id']) {
    assert.equal((await server.request('GET', `/api/admin/faqs/${bad}`, { token: adminToken })).status, 404);
    const res = await patch(bad, { question: 'X?' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error?.code ?? res.body.code, 'FAQ_NOT_FOUND');
  }
});

test('only an admin can list, read, create or edit through /api/admin', async () => {
  const { id } = (await create({ question: 'Q?', answer: 'A' })).body.data.faq;
  for (const token of [memberToken, null]) {
    const expected = token ? 403 : 401;
    assert.equal((await create({ question: 'X?', answer: 'Y' }, token)).status, expected);
    assert.equal((await patch(id, { question: 'X?' }, token)).status, expected);
    assert.equal((await server.request('GET', '/api/admin/faqs', { token })).status, expected);
    assert.equal((await server.request('GET', `/api/admin/faqs/${id}`, { token })).status, expected);
  }
  assert.equal(await Faq.countDocuments(), 1);
  assert.equal((await Faq.findById(id).lean()).question, 'Q?');
  // The public route has no write methods, and there is no delete anywhere.
  assert.equal((await server.request('POST', '/api/faqs', { body: { question: 'X?', answer: 'Y' } })).status, 404);
  assert.equal((await server.request('DELETE', `/api/admin/faqs/${id}`, { token: adminToken })).status, 404);
});
