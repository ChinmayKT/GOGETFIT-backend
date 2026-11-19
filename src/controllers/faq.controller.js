import { createFaq, findFaqs, getFaqById, toAdminFaq, toPublicFaq, updateFaq } from '../services/faq.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { validateCreateFaq, validateFaqSearchQuery, validateUpdateFaq } from '../validators/faq.validator.js';

const faqNotFound = () => notFound(ERROR_CODES.FAQ_NOT_FOUND, 'FAQ not found');

/** GET /api/faqs?search= - public, read-only (as legacy GetFAQ was). */
export const getPublicFaqs = async (req, res, next) => {
  try {
    const rows = await findFaqs(validateFaqSearchQuery(req.query));
    res.status(200).json({ success: true, data: { faqs: rows.map(toPublicFaq) } });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/faqs?search= */
export const getAdminFaqs = async (req, res, next) => {
  try {
    const rows = await findFaqs(validateFaqSearchQuery(req.query));
    res.status(200).json({ success: true, data: { faqs: rows.map(toAdminFaq), total: rows.length } });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/faqs/:id */
export const getAdminFaq = async (req, res, next) => {
  try {
    const faq = await getFaqById(req.params.id);
    if (!faq) throw faqNotFound();
    res.status(200).json({ success: true, data: { faq } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/faqs - the question and answer together; createdBy is the admin. */
export const postFaq = async (req, res, next) => {
  try {
    const faq = await createFaq(validateCreateFaq(req.body), req.user._id);
    res.status(201).json({ success: true, message: 'FAQ created', data: { faq } });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/admin/faqs/:id */
export const patchFaq = async (req, res, next) => {
  try {
    const faq = await updateFaq(req.params.id, validateUpdateFaq(req.body), req.user._id);
    if (!faq) throw faqNotFound();
    res.status(200).json({ success: true, message: 'FAQ updated', data: { faq } });
  } catch (error) {
    next(error);
  }
};
