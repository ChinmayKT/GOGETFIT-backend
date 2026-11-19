import mongoose from 'mongoose';

import Faq from '../models/faq.model.js';
import { escapeRegex } from './enrolled-client.service.js';

const iso = (date) => (date ? new Date(date).toISOString() : null);

/** What members read: the question and its answer. */
export const toPublicFaq = (doc) => ({ id: String(doc._id), question: doc.question, answer: doc.answer });

/** What the Admin Portal reads. */
export const toAdminFaq = (doc) => ({
  ...toPublicFaq(doc),
  legacyFaqId: doc.legacy?.faqId ?? null,
  createdBy: doc.createdBy ? String(doc.createdBy) : null,
  updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
  createdAt: iso(doc.createdAt),
  updatedAt: iso(doc.updatedAt),
});

/**
 * Every FAQ matching [search] (case-insensitive, anywhere in the question or
 * the answer; the text is escaped, never a pattern), oldest first: migrated
 * FAQs in legacy faq_id order (how the old app listed them), then the ones
 * created since, by creation time.
 */
export const findFaqs = async ({ search = '' } = {}) => {
  const term = String(search).trim();
  const match = term === ''
    ? {}
    : (() => {
        const rx = new RegExp(escapeRegex(term), 'i');
        return { $or: [{ question: rx }, { answer: rx }] };
      })();
  return Faq.aggregate([
    { $match: match },
    { $addFields: { _new: { $cond: [{ $ifNull: ['$legacy.faqId', false] }, 0, 1] } } },
    { $sort: { _new: 1, 'legacy.faqId': 1, createdAt: 1, _id: 1 } },
    { $project: { _new: 0 } },
  ]);
};

export const getFaqById = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await Faq.findById(id).lean();
  return doc ? toAdminFaq(doc) : null;
};

/** One FAQ: the question and answer saved together. */
export const createFaq = async ({ question, answer }, adminId) => {
  const doc = await Faq.create({ question, answer, createdBy: adminId, updatedBy: adminId });
  return toAdminFaq(doc.toObject());
};

/** Changes only the given fields of an existing FAQ; null when there is none. */
export const updateFaq = async (id, patch, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await Faq.findByIdAndUpdate(
    id,
    { $set: { ...patch, updatedBy: adminId } },
    { new: true, runValidators: true },
  ).lean();
  return doc ? toAdminFaq(doc) : null;
};
