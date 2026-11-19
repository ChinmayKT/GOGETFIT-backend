/**
 * Migrates the legacy FAQs (m_faq) into the faqs collection.
 *
 *   npm run migrate:faqs              # dry run (report only, nothing written)
 *   npm run migrate:faqs -- --apply   # write
 *
 * MariaDB is read-only throughout and the production-database rail applies
 * (assertMigrationEnv). Safe to re-run: identity is the legacy faq_id; FAQs
 * created in the portal are never touched, and a migrated FAQ edited in the
 * portal is never overwritten.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import Faq from '../../src/models/faq.model.js';
import { closePool } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import { countFaqs, extractFaqs, resolveFaqColumns } from '../extractors/faq.extractor.js';
import { loadFaqs } from '../loaders/faq.loader.js';
import { writeReport } from '../reports/migration-report.js';

const rowsOf = (items) => (items.length ? items.map((i) => `    ${String(i.faqId).padEnd(6)} ${i.reason}`) : ['    -']);

export const runFaqMigration = async ({ apply = false, runId = null } = {}) => {
  const dryRun = !apply;
  const id = runId ?? `faqs-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  logger.info(`FAQ migration (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only] into ${mongoose.connection.name}`);

  const columns = await resolveFaqColumns();
  const sourceCount = await countFaqs();
  const rows = await extractFaqs();
  const before = await Faq.countDocuments();
  const s = await loadFaqs(rows, { dryRun, runId: id });
  const after = await Faq.countDocuments();

  logger.info(
    [
      '',
      '────────── FAQ MIGRATION (m_faq → faqs) ──────────',
      `mode            : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `run id          : ${id}`,
      `source          : ${migrationEnv.mysql.database}.${migrationEnv.faqTable} (${sourceCount} rows)`,
      `target          : ${mongoose.connection.name}.faqs (${before} before → ${after} after)`,
      `read            : ${s.read}`,
      `${dryRun ? 'would create' : 'created     '}    : ${s.created}`,
      `${dryRun ? 'would update' : 'updated     '}    : ${s.updated}`,
      `unchanged       : ${s.unchanged}`,
      `skipped         : ${s.skipped.length}`,
      ...rowsOf(s.skipped),
      `failed          : ${s.failed.length}`,
      ...rowsOf(s.failed),
      columns.missing.length ? `legacy columns ABSENT: ${columns.missing.join(', ')}` : '',
      '───────────────────────────────────────────────────',
    ].filter((l) => l !== '').join('\n'),
  );

  const report = { runId: id, dryRun, source: migrationEnv.source, table: migrationEnv.faqTable, sourceCount, before, after, summary: s, finishedAt: new Date().toISOString() };
  const file = await writeReport(report);
  logger.info(`report (incl. legacy faq_id → Mongo id map): ${file ?? 'migration/reports/runs'}`);
  return report;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('migrate-faqs.js');
if (isEntryPoint) {
  const apply = process.argv.includes('--apply');
  Promise.resolve()
    .then(() => assertMigrationEnv())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => Faq.syncIndexes())
    .then(() => runFaqMigration({ apply }))
    .catch((error) => {
      logger.error(`FAQ migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runFaqMigration;
