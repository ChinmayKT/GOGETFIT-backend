import mongoose from 'mongoose';

import Coach from '../models/coach.model.js';
import EnrolledClient from '../models/enrolled-client.model.js';
import Questionnaire from '../models/questionnaire.model.js';
import User from '../models/user.model.js';
import {
  FEMALE_GENDER,
  QUESTIONNAIRE_QUESTIONS,
  QUESTIONNAIRE_SCHEMA_VERSION,
} from '../constants/questionnaire-definition.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { validateQuestionnaireSave } from '../validators/questionnaire.validator.js';

/**
 * The member's own questionnaire, one per enrollment.
 *
 * The ownership chain is the whole security model and it only ever runs one way:
 *
 *   authenticated JWT user -> owns this EnrolledClient -> that enrollment names
 *   the coach -> the questionnaire belongs to that enrollment
 *
 * Nothing here reads a userId or a coachId from a caller. `userId` is always the
 * token's subject, passed in by the controller from `req.user`, and `coachId` is
 * read off the enrollment document. An enrollment that is not the caller's is
 * indistinguishable from one that does not exist, so probing ids tells an
 * attacker nothing.
 */

const iso = (date) => (date ? new Date(date).toISOString() : null);

/** Mongoose Maps come back as a Map on a document and a plain object from lean(). */
const answersToObject = (answers) => {
  if (!answers) return {};
  if (answers instanceof Map) return Object.fromEntries(answers);
  return { ...answers };
};

/** An ObjectId, or a populated document - the id either way. */
const idOf = (value) => {
  if (!value) return null;
  return String(value._id ?? value);
};

/**
 * One questionnaire as the member sees it.
 *
 * `plan` and `coach` are only present when the caller populated the enrollment
 * and the coach - the history list does, the single read does not. They are a
 * summary for a list row, never a second copy of the plan: the ids are there for
 * anything that needs the real records.
 */
export const toQuestionnaire = (doc) => {
  const enrollment = doc.enrollmentId && typeof doc.enrollmentId === 'object' ? doc.enrollmentId : null;
  const plan = enrollment?.planId && typeof enrollment.planId === 'object' ? enrollment.planId : null;
  const coach = doc.coachId && typeof doc.coachId === 'object' ? doc.coachId : null;
  const coachUser = coach?.userId && typeof coach.userId === 'object' ? coach.userId : null;

  return {
    questionnaireId: String(doc._id),
    enrollmentId: idOf(doc.enrollmentId),
    coachId: idOf(doc.coachId),
    schemaVersion: doc.schemaVersion,
    answers: answersToObject(doc.answers),
    status: doc.status,
    submittedAt: iso(doc.submittedAt),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),

    ...(enrollment
      ? {
          enrollment: {
            id: String(enrollment._id),
            enrollDate: iso(enrollment.enrollDate),
            startDate: iso(enrollment.startDate),
            endDate: iso(enrollment.endDate),
          },
        }
      : {}),
    ...(plan
      ? {
          plan: {
            id: String(plan._id),
            name: plan.name ?? null,
            planType: plan.planType ?? null,
            durationWeeks: plan.durationWeeks ?? null,
          },
        }
      : {}),
    ...(coach
      ? {
          coach: {
            id: String(coach._id),
            // From the coach's User - a Coach document has no name of its own.
            name: coachUser?.profile?.name ?? null,
            level: coach.profile?.level ?? null,
          },
        }
      : {}),
  };
};

/**
 * The caller's own enrollment, or a 404.
 *
 * Both the ownership check and the soft-delete check are part of the QUERY, not
 * an `if` after the fact: there is no code path that can read an enrollment and
 * then forget to check whose it is. A malformed id is also a 404 rather than a
 * cast error - "no such enrollment of yours" is the truthful answer either way.
 */
const findOwnedEnrollment = async (userId, enrollmentId) => {
  if (!mongoose.isValidObjectId(enrollmentId)) {
    throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrollment not found');
  }

  const enrollment = await EnrolledClient.findOne({
    _id: enrollmentId,
    userId,
    isDeleted: { $ne: true },
  }).lean();

  if (!enrollment) {
    throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrollment not found');
  }
  return enrollment;
};

/**
 * GET - the questionnaire for one of the caller's enrollments.
 *
 * 404 when none has been started: an untouched enrollment genuinely has no
 * questionnaire, and an empty draft is not invented to paper over that.
 */
export const getMemberQuestionnaire = async (userId, enrollmentId) => {
  await findOwnedEnrollment(userId, enrollmentId);

  // Scoped by userId as well as the enrollment, so even a mismatched pair cannot
  // return someone else's answers.
  const doc = await Questionnaire.findOne({ userId, enrollmentId }).lean();
  if (!doc) {
    throw notFound(ERROR_CODES.QUESTIONNAIRE_NOT_FOUND, 'No questionnaire has been started for this enrollment');
  }
  return toQuestionnaire(doc);
};

/**
 * POST - creates the enrollment's questionnaire, or updates the one that exists.
 *
 * Never a second document for the same enrollment: the upsert is matched on
 * `(userId, enrollmentId)`, which is also a unique index, so two simultaneous
 * saves cannot both insert.
 *
 * `answers` is REPLACED, not merged. The app always sends the full answer map it
 * is holding, and merging would make a removed answer impossible to clear.
 *
 * THE STATUS ONLY EVER MOVES FORWARD: draft -> submitted, never back. A `draft`
 * save arriving for an already-submitted questionnaire keeps it submitted and
 * only updates the answers.
 *
 * That guard is not theoretical. The app autosaves a draft whenever a step is
 * finished or the form is left, and any such save that lands after the
 * submission - a slow request overtaken by the submit, or simply the member
 * reopening the form later - used to flip a finished questionnaire back to
 * `draft`. One document in the development database was found in exactly that
 * state: `submittedAt` set, status `draft`, answers intact. Everything
 * downstream then disagreed with itself, because a questionnaire that is
 * submitted and a questionnaire that is a draft are read in different places.
 *
 * `submittedAt` is stamped the first time the status becomes `submitted` and then
 * left alone: a later correction moves `updatedAt`, and when the member finished
 * stays on the record.
 */
export const saveMemberQuestionnaire = async (userId, enrollmentId, body) => {
  const enrollment = await findOwnedEnrollment(userId, enrollmentId);
  const { answers, status: requested } = validateQuestionnaireSave(body);

  const existing = await Questionnaire.findOne({ userId, enrollmentId });

  // Submitted is terminal. Nothing a client sends can un-submit a questionnaire.
  const status = existing?.status === 'submitted' ? 'submitted' : requested;

  const submittedAt =
    status === 'submitted' ? (existing?.submittedAt ?? new Date()) : (existing?.submittedAt ?? null);

  const doc = await Questionnaire.findOneAndUpdate(
    { userId, enrollmentId },
    {
      $set: {
        answers,
        status,
        submittedAt,
        // From the enrollment, every time, so a questionnaire follows a coach
        // reassignment rather than keeping a stale copy.
        coachId: enrollment.coachId,
        schemaVersion: QUESTIONNAIRE_SCHEMA_VERSION,
      },
      $setOnInsert: { userId, enrollmentId },
    },
    { returnDocument: 'after', upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );

  return { questionnaire: toQuestionnaire(doc), created: !existing };
};

/**
 * Every questionnaire the member owns, newest submission first.
 *
 * Scoped by `userId` in the query itself - there is no parameter with which one
 * member could ask for another's history. `status` narrows it; History asks for
 * `submitted`, so a draft the member is still working on never appears there.
 *
 * Questionnaires whose enrollment has been soft-deleted are left out, matching
 * the single read, which refuses a deleted enrollment outright.
 *
 * The enrollment, its plan and the coach are joined for the list row. They are
 * read through, never copied onto the questionnaire.
 */
export const listMemberQuestionnaires = async (userId, { status } = {}) => {
  const query = { userId };
  if (status) query.status = status;

  const docs = await Questionnaire.find(query)
    // Newest SUBMISSION first; a draft has no submittedAt, so creation order
    // decides among those rather than leaving them in an arbitrary order.
    .sort({ submittedAt: -1, createdAt: -1, _id: -1 })
    .populate([
      { path: 'enrollmentId', select: 'planId enrollDate startDate endDate isDeleted', populate: { path: 'planId', select: 'name planType durationWeeks' } },
      { path: 'coachId', select: 'profile.level userId', populate: { path: 'userId', select: 'profile.name' } },
    ])
    .lean();

  const questionnaires = docs
    .filter((doc) => !(doc.enrollmentId && typeof doc.enrollmentId === 'object' && doc.enrollmentId.isDeleted))
    .map(toQuestionnaire);

  return { questionnaires, total: questionnaires.length };
};

/** Section titles as the app's fill flow shows them. */
export const QUESTIONNAIRE_STEP_TITLES = {
  basics: 'Basic Information',
  nutrition: 'Nutrition',
  fitness: 'Fitness & Lifestyle',
  health: 'Health',
  goals: 'Goals & Motivation',
};

/**
 * Every question the member was asked, in fill-flow order, with their answer
 * (null when left unanswered). Female-only questions are listed only when the
 * member answered Female - the app never showed them otherwise.
 */
export const toQuestionAnswers = (answers) => {
  const female = answers.gender === FEMALE_GENDER;
  return QUESTIONNAIRE_QUESTIONS.filter((q) => !q.femaleOnly || female).map((q) => ({
    key: q.key,
    step: q.step,
    stepTitle: QUESTIONNAIRE_STEP_TITLES[q.step],
    question: q.label,
    type: q.type,
    answer: answers[q.key] ?? null,
  }));
};

/**
 * Admin read: one member's SUBMITTED questionnaires, newest submission first,
 * each with its enrollment, plan, coach and the question/answer list. Only
 * status "submitted" is shown; a draft is the member's work in progress.
 */
export const listQuestionnairesForAdmin = async (userId) => {
  if (!mongoose.isValidObjectId(userId) || !(await User.exists({ _id: userId }))) {
    throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  }

  const docs = await Questionnaire.find({ userId, status: 'submitted' })
    .sort({ submittedAt: -1, createdAt: -1, _id: -1 })
    .populate([
      { path: 'enrollmentId', select: 'planId enrollDate startDate endDate isDeleted', populate: { path: 'planId', select: 'name planType durationWeeks' } },
      { path: 'coachId', select: 'profile.level userId', populate: { path: 'userId', select: 'profile.name' } },
    ])
    .lean();

  const questionnaires = docs.map((doc) => {
    const q = toQuestionnaire(doc);
    return { ...q, questions: toQuestionAnswers(q.answers) };
  });
  return { questionnaires, total: questionnaires.length };
};

/**
 * Coach read: the SUBMITTED questionnaire of one enrollment the signed-in coach
 * owns.
 *
 *   authenticated user -> their Coach -> EnrolledClient { _id, coachId: that
 *   coach, not deleted } -> Questionnaire { enrollmentId, status: submitted }
 *
 * The coach is resolved from the token's user, never from the request. An
 * enrollment that is not this coach's (another coach's, deleted, unknown or a
 * malformed id) is a 404 indistinguishable from one that does not exist.
 *
 * `null` when the member has not submitted a questionnaire for that enrollment
 * - a draft is the member's work in progress and is never shown to the coach.
 *
 * @returns {Promise<object|null>} the questionnaire in the member API's shape
 */
export const getSubmittedQuestionnaireForCoach = async (coachUserId, enrollmentId) => {
  const coach = await Coach.findOne({ userId: coachUserId }, { _id: 1 }).lean();
  if (!coach) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'You do not have a coach profile');

  if (!mongoose.isValidObjectId(enrollmentId)) {
    throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrollment not found');
  }
  const enrollment = await EnrolledClient.findOne(
    { _id: enrollmentId, coachId: coach._id, isDeleted: { $ne: true } },
    { _id: 1, userId: 1 },
  ).lean();
  if (!enrollment) throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrollment not found');

  // Scoped by the enrollment's member too, so a mismatched record can never leak.
  const doc = await Questionnaire.findOne({
    enrollmentId: enrollment._id,
    userId: enrollment.userId,
    status: 'submitted',
  })
    .populate([
      { path: 'enrollmentId', select: 'planId enrollDate startDate endDate', populate: { path: 'planId', select: 'name planType durationWeeks' } },
      { path: 'coachId', select: 'profile.level userId', populate: { path: 'userId', select: 'profile.name' } },
    ])
    .lean();
  return doc ? toQuestionnaire(doc) : null;
};

export default {
  getSubmittedQuestionnaireForCoach,
  listQuestionnairesForAdmin,
  getMemberQuestionnaire,
  saveMemberQuestionnaire,
  listMemberQuestionnaires,
  toQuestionnaire,
};
