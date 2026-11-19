import Faq, { FAQ_ANSWER_MAX, FAQ_QUESTION_MAX } from '../../src/models/faq.model.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * m_faq -> faqs. Identity is (legacy.source, legacy.faqId); FAQs created in
 * the portal (no legacy) are never read or written here. Per legacy row:
 *   - no document yet           -> created;
 *   - document differs          -> updated from legacy, unless an admin has
 *                                  edited it since the migration wrote it
 *                                  (then skipped, never overwritten);
 *   - document already the same -> unchanged;
 *   - blank or too long text    -> failed (reported, nothing written).
 * MySQL is only read. createdBy/updatedBy stay null: legacy's audit columns
 * are legacy login ids (always "123"), kept verbatim under legacy.*.
 */

const text = (value) => (value === null || value === undefined ? '' : String(value).trim());
const dateOrNull = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** One legacy row as the fields a migrated FAQ holds, or { error }. */
export const transformLegacyFaq = (row, source = migrationEnv.source) => {
  const faqId = Number(row.faq_id);
  if (!Number.isInteger(faqId) || faqId <= 0) return { error: 'faq_id is not a positive integer' };
  const question = text(row.question);
  const answer = text(row.answer);
  if (!question) return { faqId, error: 'question is empty' };
  if (!answer) return { faqId, error: 'answer is empty' };
  if (question.length > FAQ_QUESTION_MAX) return { faqId, error: `question longer than ${FAQ_QUESTION_MAX} characters` };
  if (answer.length > FAQ_ANSWER_MAX) return { faqId, error: `answer longer than ${FAQ_ANSWER_MAX} characters` };
  return {
    faqId,
    fields: {
      question,
      answer,
      legacy: {
        source,
        faqId,
        auditCreatedBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
        auditUpdatedBy: row.last_update_by === null || row.last_update_by === undefined ? null : String(row.last_update_by),
        auditUpdatedAt: dateOrNull(row.last_update_date),
      },
    },
  };
};

// migratedAt and updatedAt are stamped together; this absorbs clock jitter.
const EDIT_TOLERANCE_MS = 1000;
export const editedSinceMigration = (doc) =>
  Boolean(doc.migration?.migratedAt && doc.updatedAt) &&
  new Date(doc.updatedAt).getTime() - new Date(doc.migration.migratedAt).getTime() > EDIT_TOLERANCE_MS;

const sameContent = (doc, fields) =>
  doc.question === fields.question &&
  doc.answer === fields.answer &&
  (doc.legacy?.auditCreatedBy ?? null) === fields.legacy.auditCreatedBy &&
  (doc.legacy?.auditUpdatedBy ?? null) === fields.legacy.auditUpdatedBy &&
  (doc.legacy?.auditUpdatedAt ? new Date(doc.legacy.auditUpdatedAt).getTime() : null) ===
    (fields.legacy.auditUpdatedAt ? fields.legacy.auditUpdatedAt.getTime() : null);

export const loadFaqs = async (
  rows,
  { dryRun = true, source = migrationEnv.source, runId = null, version = migrationEnv.version, now = () => new Date() } = {},
) => {
  const s = { read: rows.length, created: 0, updated: 0, unchanged: 0, skipped: [], failed: [], idMap: [] };
  for (const row of rows) {
    const t = transformLegacyFaq(row, source);
    if (t.error) {
      s.failed.push({ faqId: t.faqId ?? row.faq_id ?? null, reason: t.error });
      continue;
    }
    try {
      const existing = await Faq.findOne({ 'legacy.source': source, 'legacy.faqId': t.faqId }).lean();
      if (existing && sameContent(existing, t.fields)) {
        s.unchanged += 1;
        s.idMap.push({ faqId: t.faqId, mongoId: String(existing._id), action: 'unchanged' });
        continue;
      }
      if (existing && editedSinceMigration(existing)) {
        s.skipped.push({ faqId: t.faqId, reason: 'edited in the Admin Portal since migration - not overwritten' });
        s.idMap.push({ faqId: t.faqId, mongoId: String(existing._id), action: 'skipped' });
        continue;
      }
      if (dryRun) {
        if (existing) s.updated += 1;
        else s.created += 1;
        s.idMap.push({ faqId: t.faqId, mongoId: existing ? String(existing._id) : null, action: existing ? 'would update' : 'would create' });
        continue;
      }
      const at = now();
      const migration = { runId, migratedAt: at, version };
      if (existing) {
        await Faq.updateOne(
          { _id: existing._id },
          { $set: { ...t.fields, migration, updatedAt: at } },
          { runValidators: true, timestamps: false },
        );
        s.updated += 1;
        s.idMap.push({ faqId: t.faqId, mongoId: String(existing._id), action: 'updated' });
      } else {
        const doc = new Faq({ ...t.fields, migration });
        doc.createdAt = at;
        doc.updatedAt = at;
        await doc.save({ timestamps: false });
        s.created += 1;
        s.idMap.push({ faqId: t.faqId, mongoId: String(doc._id), action: 'created' });
      }
    } catch (error) {
      s.failed.push({ faqId: t.faqId, reason: error.message });
    }
  }
  return s;
};
