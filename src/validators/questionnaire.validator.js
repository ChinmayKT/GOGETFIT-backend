import { ERROR_CODES, badRequest } from '../utils/errors.js';
import {
  FEMALE_GENDER,
  QUESTION_BY_KEY,
  QUESTION_TYPES,
  REQUIRED_QUESTION_KEYS,
  SLIDER_RANGE,
} from '../constants/questionnaire-definition.js';
import { QUESTIONNAIRE_STATUSES } from '../models/questionnaire.model.js';

/**
 * Validates a questionnaire save against the definition - and against nothing
 * else. Every rule enforced here exists in the app's fill flow:
 *
 *   - the key must be one of the 38 questions;
 *   - a choice must be one of that question's options;
 *   - a wheel value must be one of that wheel's values;
 *   - a slider must be a whole number in 0..10;
 *   - text must be a string within the question's character cap, where it has one;
 *   - the two female-only questions exist only when the answered gender is Female;
 *   - a SUBMITTED questionnaire must carry the eight answers the app's own step
 *     gate refuses to advance past.
 *
 * A draft is held to everything except that last rule: a half-filled draft is
 * the normal state while a member works through five steps, but a key the app
 * could never have produced is a bug or an attack either way.
 */

const invalid = (message) => badRequest(ERROR_CODES.VALIDATION_ERROR, message);

/** Unanswered, in the shape the app uses: the key is simply absent. */
const isBlank = (value) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

const validateOneAnswer = (question, value) => {
  switch (question.type) {
    case QUESTION_TYPES.SINGLE_CHOICE:
    case QUESTION_TYPES.WHEEL: {
      if (typeof value !== 'string') {
        throw invalid(`${question.key} must be a string`);
      }
      if (!question.options.includes(value)) {
        // Wheels have hundreds of values; naming them all would be unreadable
        // and would leak nothing useful. Choices are short, so they are listed.
        const detail =
          question.type === QUESTION_TYPES.SINGLE_CHOICE
            ? ` (expected one of: ${question.options.join(', ')})`
            : '';
        throw invalid(`${question.key} is not one of the allowed values${detail}`);
      }
      return value;
    }

    case QUESTION_TYPES.SLIDER: {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw invalid(`${question.key} must be a whole number`);
      }
      if (value < SLIDER_RANGE.min || value > SLIDER_RANGE.max) {
        throw invalid(`${question.key} must be between ${SLIDER_RANGE.min} and ${SLIDER_RANGE.max}`);
      }
      return value;
    }

    case QUESTION_TYPES.SHORT_TEXT:
    case QUESTION_TYPES.LONG_TEXT: {
      if (typeof value !== 'string') {
        throw invalid(`${question.key} must be a string`);
      }
      // The app trims before storing, and never stores an empty answer.
      const text = value.trim();
      if (question.maxLength !== undefined && text.length > question.maxLength) {
        throw invalid(`${question.key} must be at most ${question.maxLength} characters`);
      }
      return text;
    }

    default:
      // Unreachable: the definition's types are a closed set.
      throw invalid(`${question.key} has an unsupported answer type`);
  }
};

export const validateStatus = (value) => {
  if (value === undefined) return 'draft';
  if (!QUESTIONNAIRE_STATUSES.includes(value)) {
    throw invalid(`status must be one of: ${QUESTIONNAIRE_STATUSES.join(', ')}`);
  }
  return value;
};

/**
 * Validates the body of a questionnaire save and returns the answers exactly as
 * they should be stored.
 *
 * Blank answers are dropped rather than stored: the app's own contract is that
 * an unanswered question has no key at all, so accepting `''` would create a
 * second way to say "not answered".
 */
export const validateQuestionnaireSave = (body = {}) => {
  const allowed = ['answers', 'status'];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    // userId, coachId and enrollmentId are resolved from the token and the
    // enrollment. Being sent one is a sign the caller believes it decides them.
    throw invalid(`Unknown field(s): ${unknown.join(', ')}. Only answers and status are accepted`);
  }

  const status = validateStatus(body.status);

  const { answers } = body;
  if (answers === undefined || answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw invalid('answers must be an object');
  }

  const unknownKeys = Object.keys(answers).filter((key) => !QUESTION_BY_KEY.has(key));
  if (unknownKeys.length > 0) {
    throw invalid(`Unknown question key(s): ${unknownKeys.join(', ')}`);
  }

  // Gender decides whether the two female-only questions exist at all - read
  // from the answers, which is where the app reads it from too.
  const isFemale = answers.gender === FEMALE_GENDER;

  const clean = {};
  for (const [key, value] of Object.entries(answers)) {
    const question = QUESTION_BY_KEY.get(key);

    if (question.femaleOnly && !isFemale) {
      throw invalid(`${key} is only asked when gender is ${FEMALE_GENDER}`);
    }

    if (isBlank(value)) continue;
    clean[key] = validateOneAnswer(question, value);
  }

  if (status === 'submitted') {
    const missing = REQUIRED_QUESTION_KEYS.filter((key) => clean[key] === undefined);
    if (missing.length > 0) {
      throw badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        `Cannot submit: missing required answer(s): ${missing.join(', ')}`,
        { missing },
      );
    }
  }

  return { answers: clean, status };
};

export default { validateQuestionnaireSave, validateStatus };
