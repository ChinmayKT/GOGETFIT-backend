/**
 * Imports the legacy FAQs through the legacy app's own public read endpoint
 * (GET <legacy api>/api/GetFAQ) - for when the legacy MySQL (m_faq) cannot be
 * reached. That endpoint returns question and answer only, in table order
 * (the order the old app showed), without faq_id; so each FAQ's position
 * (1, 2, ...) stands in for it, under its own legacy source "<source>-api" so
 * it can never be mistaken for a real m_faq id.
 *
 *   node migration/scripts/import-faqs-from-legacy-api.js            # dry run
 *   node migration/scripts/import-faqs-from-legacy-api.js --apply    # write
 *   ... --file <saved GetFAQ response.json>   # the same, from a saved response
 *
 * Same loader as migrate-faqs.js: re-runnable without duplicates; portal FAQs
 * and portal edits are never overwritten.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import Faq from '../../src/models/faq.model.js';
import { migrationEnv } from '../config/migration.env.js';
import { loadFaqs } from '../loaders/faq.loader.js';
import { writeReport } from '../reports/migration-report.js';

const LEGACY_API = (process.env.MIGRATION_LEGACY_API_BASE_URL || 'https://apitest.gogetfitonline.com/').replace(/\/?$/, '/');

const run = async ({ apply, file }) => {
  const dryRun = !apply;
  const source = `${migrationEnv.source}-api`;
  const runId = `faqs-api-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  const url = file ? `file:${file}` : `${LEGACY_API}api/GetFAQ`;
  let body;
  if (file) {
    body = JSON.parse(await readFile(file, 'utf8'));
  } else {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Legacy FAQ endpoint answered HTTP ${res.status}`);
    body = await res.json();
  }
  const list = body.faq ?? body.FAQ;
  if (!Array.isArray(list)) throw new Error('Legacy FAQ endpoint returned no faq list');
  const rows = list.map((f, i) => ({ faq_id: i + 1, question: f.question, answer: f.answer }));

  const before = await Faq.countDocuments();
  const s = await loadFaqs(rows, { dryRun, source, runId });
  const after = await Faq.countDocuments();
  logger.info(
    [
      '',
      '────────── FAQ IMPORT (legacy GetFAQ → faqs) ──────────',
      `mode      : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `source    : ${url} (legacy.source "${source}", position as id)`,
      `target    : ${mongoose.connection.name}.faqs (${before} before → ${after} after)`,
      `read      : ${s.read}`,
      `${dryRun ? 'would create' : 'created     '}: ${s.created}`,
      `${dryRun ? 'would update' : 'updated     '}: ${s.updated}`,
      `unchanged : ${s.unchanged}`,
      `skipped   : ${s.skipped.length}${s.skipped.length ? ` -> ${s.skipped.map((x) => `#${x.faqId}`).join(', ')}` : ''}`,
      `failed    : ${s.failed.length}${s.failed.length ? ` -> ${s.failed.map((x) => `#${x.faqId} ${x.reason}`).join('; ')}` : ''}`,
      '────────────────────────────────────────────────────────',
    ].join('\n'),
  );
  await writeReport({ runId, dryRun, source, url, before, after, summary: s, finishedAt: new Date().toISOString() });
};

const apply = process.argv.includes('--apply');
const fileAt = process.argv.indexOf('--file');
const file = fileAt > -1 ? process.argv[fileAt + 1] : null;
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => Faq.syncIndexes())
  .then(() => run({ apply, file }))
  .catch((error) => {
    logger.error(`FAQ import failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
