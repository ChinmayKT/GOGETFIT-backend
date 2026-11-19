import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import Faq from '../../src/models/faq.model.js';
import { findFaqs } from '../../src/services/faq.service.js';
import { loadFaqs, transformLegacyFaq } from '../../migration/loaders/faq.loader.js';
import { clearTestDb, connectTestDb, disconnectTestDb } from '../helpers/test-server.js';

/**
 * The m_faq -> faqs loader, fed legacy-shaped rows (MySQL itself is never
 * touched here): created once, re-runnable without duplicates, legacy edits
 * flow in, portal edits and portal-created FAQs are never overwritten, bad
 * rows are reported, a dry run writes nothing, and faq_id order is kept.
 */
const row = (id, question, answer, extra = {}) => ({
  faq_id: id,
  question,
  answer,
  created_by: 123,
  last_update_date: '2023-05-01 10:00:00',
  last_update_by: 123,
  ...extra,
});

before(connectTestDb);
beforeEach(clearTestDb);
after(disconnectTestDb);

test('transform: trimmed text, legacy id and audit columns; blank rows are errors', () => {
  const t = transformLegacyFaq(row(4, '  What is GOGETFIT?  ', ' A fitness app. '), 'gogetfit');
  assert.deepEqual(
    { faqId: t.faqId, q: t.fields.question, a: t.fields.answer, src: t.fields.legacy.source, by: t.fields.legacy.auditCreatedBy },
    { faqId: 4, q: 'What is GOGETFIT?', a: 'A fitness app.', src: 'gogetfit', by: '123' },
  );
  assert.match(transformLegacyFaq(row(5, ' ', 'x')).error, /question is empty/);
  assert.match(transformLegacyFaq(row(6, 'x', null)).error, /answer is empty/);
  assert.match(transformLegacyFaq(row('abc', 'x', 'y')).error, /faq_id/);
});

test('a dry run reports and writes nothing', async () => {
  const s = await loadFaqs([row(1, 'Q1', 'A1'), row(2, 'Q2', 'A2')], { dryRun: true, source: 'gogetfit' });
  assert.deepEqual([s.read, s.created, s.updated, s.unchanged], [2, 2, 0, 0]);
  assert.equal(await Faq.countDocuments(), 0);
});

test('apply creates one FAQ per row; a re-run changes nothing and never duplicates', async () => {
  const rows = [row(3, 'Q3', 'A3'), row(1, 'Q1', 'A1'), row(2, 'Q2', 'A2')];
  let s = await loadFaqs(rows, { dryRun: false, source: 'gogetfit', runId: 'r1' });
  assert.deepEqual([s.read, s.created, s.updated, s.unchanged, s.skipped.length, s.failed.length], [3, 3, 0, 0, 0, 0]);
  s = await loadFaqs(rows, { dryRun: false, source: 'gogetfit', runId: 'r2' });
  assert.deepEqual([s.created, s.updated, s.unchanged], [0, 0, 3]);
  assert.equal(await Faq.countDocuments(), 3);
  const doc = await Faq.findOne({ 'legacy.faqId': 1 }).lean();
  assert.equal(doc.legacy.source, 'gogetfit');
  assert.equal(doc.createdBy, null, 'no invented admin');
  assert.equal(doc.migration.runId, 'r1');
  // Listed in legacy faq_id order, whatever order they were loaded in.
  assert.deepEqual((await findFaqs()).map((f) => f.question), ['Q1', 'Q2', 'Q3']);
});

test('a legacy change flows in; a portal edit is never overwritten; portal FAQs are never touched', async () => {
  const t0 = new Date('2026-11-01T10:00:00Z');
  await loadFaqs([row(1, 'Q1', 'A1'), row(2, 'Q2', 'A2')], { dryRun: false, source: 'gogetfit', now: () => t0 });
  const portal = await Faq.create({ question: 'Made in the portal?', answer: 'Yes.' });
  // An admin edits FAQ 2 later in the portal.
  await Faq.updateOne({ 'legacy.faqId': 2 }, { $set: { answer: 'Edited by admin', updatedAt: new Date('2026-11-05T10:00:00Z') } }, { timestamps: false });

  const s = await loadFaqs(
    [row(1, 'Q1 (fixed in legacy)', 'A1'), row(2, 'Q2', 'A2 changed in legacy'), row(9, '', 'no question')],
    { dryRun: false, source: 'gogetfit', now: () => new Date('2026-11-10T10:00:00Z') },
  );
  assert.deepEqual([s.read, s.created, s.updated, s.unchanged], [3, 0, 1, 0]);
  assert.deepEqual(s.skipped.map((x) => x.faqId), [2]);
  assert.deepEqual(s.failed.map((x) => x.faqId), [9]);

  assert.equal((await Faq.findOne({ 'legacy.faqId': 1 }).lean()).question, 'Q1 (fixed in legacy)');
  assert.equal((await Faq.findOne({ 'legacy.faqId': 2 }).lean()).answer, 'Edited by admin', 'portal edit kept');
  const untouched = await Faq.findById(portal._id).lean();
  assert.deepEqual([untouched.question, untouched.answer, untouched.legacy], ['Made in the portal?', 'Yes.', undefined]);
  assert.equal(await Faq.countDocuments(), 3, 'the bad row wrote nothing');
});
