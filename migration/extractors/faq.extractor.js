import { query } from '../config/mariadb.js';
import { migrationEnv } from '../config/migration.env.js';

/** Read-only extraction of m_faq: question, answer and its audit columns. */
export const FAQ_COLUMNS = ['faq_id', 'question', 'answer', 'created_by', 'last_update_date', 'last_update_by'];

export const resolveFaqColumns = async (table = migrationEnv.faqTable) => {
  const available = new Set((await query('SHOW COLUMNS FROM ??', [table])).map((row) => row.Field));
  for (const required of ['faq_id', 'question', 'answer']) {
    if (!available.has(required)) throw new Error(`Legacy table "${table}" has no ${required} column`);
  }
  return {
    present: FAQ_COLUMNS.filter((c) => available.has(c)),
    missing: FAQ_COLUMNS.filter((c) => !available.has(c)),
  };
};

export const countFaqs = async (table = migrationEnv.faqTable) =>
  Number((await query('SELECT COUNT(*) AS total FROM ??', [table]))[0].total);

/** faq_id order - the legacy display order, and a reproducible run. */
export const extractFaqs = async (table = migrationEnv.faqTable) => {
  const { present } = await resolveFaqColumns(table);
  return query('SELECT ?? FROM ?? ORDER BY faq_id ASC', [present, table]);
};
