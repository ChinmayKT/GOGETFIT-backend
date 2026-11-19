import { FAQ_ANSWER_MAX, FAQ_QUESTION_MAX } from '../models/faq.model.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A required, trimmed, non-blank string of at most [max] characters. */
const requiredText = (value, label, max) => {
  if (typeof value !== 'string') fail(`${label} is required`);
  const text = value.trim();
  if (text === '') fail(`${label} cannot be empty`);
  if (text.length > max) fail(`${label} must be at most ${max} characters`);
  return text;
};

/** POST: the question and its answer, together. */
export const validateCreateFaq = (body = {}) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  return {
    question: requiredText(body.question, 'question', FAQ_QUESTION_MAX),
    answer: requiredText(body.answer, 'answer', FAQ_ANSWER_MAX),
  };
};

/** PATCH: either or both; neither may be blanked. */
export const validateUpdateFaq = (body = {}) => {
  if (!isPlainObject(body)) fail('A JSON body is required');
  const patch = {};
  if (body.question !== undefined) patch.question = requiredText(body.question, 'question', FAQ_QUESTION_MAX);
  if (body.answer !== undefined) patch.answer = requiredText(body.answer, 'answer', FAQ_ANSWER_MAX);
  if (Object.keys(patch).length === 0) fail('No editable fields supplied');
  return patch;
};

/** ?search= - optional, at most 100 characters. */
export const validateFaqSearchQuery = (query = {}) => {
  const raw = query.search;
  if (raw === undefined) return { search: '' };
  if (typeof raw !== 'string') fail('search must be a string');
  const search = raw.trim();
  if (search.length > 100) fail('search must be at most 100 characters');
  return { search };
};
