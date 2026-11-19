import mongoose from 'mongoose';

/** Upper bounds for one FAQ (legacy m_faq had none; these are generous). */
export const FAQ_QUESTION_MAX = 500;
export const FAQ_ANSWER_MAX = 5000;

/**
 * Historical identity of an FAQ migrated from legacy m_faq. Absent on FAQs
 * created in the new portal - never invented. faq_id is also the legacy
 * display order (the old app listed m_faq in table order).
 */
const legacySchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    faqId: { type: Number, required: true },
    /** m_faq's own audit columns, verbatim (legacy login ids, not User ids). */
    auditCreatedBy: { type: String, default: null },
    auditUpdatedBy: { type: String, default: null },
    auditUpdatedAt: { type: Date, default: null },
  },
  { _id: false },
);

/** Which migration run wrote a migrated FAQ. Absent on portal FAQs. */
const migrationSchema = new mongoose.Schema(
  {
    runId: { type: String, default: null },
    migratedAt: { type: Date, default: null },
    version: { type: Number, default: null },
  },
  { _id: false },
);

/**
 * One FAQ: a question and its answer, always together in one document (the
 * new home of legacy m_faq). Plain text, as legacy. No categories, status or
 * ordering - legacy had none.
 */
const faqSchema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true, maxlength: FAQ_QUESTION_MAX },
    answer: { type: String, required: true, trim: true, maxlength: FAQ_ANSWER_MAX },
    legacy: { type: legacySchema, default: undefined },
    migration: { type: migrationSchema, default: undefined },
    /** The authenticated administrator - never a value supplied by the browser. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, immutable: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false, collection: 'faqs' },
);

/** One document per legacy row: what makes the migration re-runnable. */
faqSchema.index(
  { 'legacy.source': 1, 'legacy.faqId': 1 },
  { unique: true, name: 'uniq_legacy_faq', partialFilterExpression: { 'legacy.faqId': { $exists: true } } },
);

export const Faq = mongoose.model('Faq', faqSchema);
export default Faq;
