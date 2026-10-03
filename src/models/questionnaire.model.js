import mongoose from 'mongoose';

import { QUESTIONNAIRE_SCHEMA_VERSION } from '../constants/questionnaire-definition.js';

/**
 * The onboarding questionnaire a member fills in for ONE enrollment.
 *
 * Enrollment-scoped by design: a member who buys a second plan answers a second
 * questionnaire, and the first one is never touched. The unique index below is
 * what makes "one enrollment, one questionnaire" a database fact rather than a
 * convention the service has to remember.
 *
 * The questions themselves are NOT stored here. A document keeps the answers
 * plus the `schemaVersion` they were given against, so re-wording a question
 * later cannot retroactively change what a member said. The wording lives in
 * `src/constants/questionnaire-definition.js`, which is also the only validation
 * authority.
 *
 * `coachId` is a copy of the enrollment's coach, taken server-side at save time
 * so a coach-facing read never has to join through the enrollment. It is never
 * accepted from a client.
 */

export const QUESTIONNAIRE_STATUSES = ['draft', 'submitted'];

const questionnaireSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** The enrollment these answers belong to. One questionnaire per enrollment. */
    enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnrolledClient', required: true },
    /** Resolved from the enrollment, never from the request body. */
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', required: true },
    /**
     * Which definition these answers were given against. Required and defaulted
     * so no document can exist without saying what its keys mean.
     */
    schemaVersion: { type: Number, required: true, default: QUESTIONNAIRE_SCHEMA_VERSION },
    /**
     * Question key -> answer. A Map rather than a fixed sub-schema: the keys are
     * owned by the definition file, and pinning 38 paths here would mean a
     * migration every time the app adds a question.
     *
     * Values are what the app's fill flow produces - a String for choices,
     * wheels and text, an int for sliders - and an ABSENT key for anything
     * unanswered. Nothing is ever stored as null or an empty string.
     */
    answers: { type: Map, of: mongoose.Schema.Types.Mixed, default: () => new Map() },
    status: { type: String, enum: QUESTIONNAIRE_STATUSES, required: true, default: 'draft' },
    /**
     * When the member first submitted. Kept once set: a later edit updates
     * `updatedAt`, and the record of when they finished stays intact.
     */
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// One questionnaire per enrollment - a hard database constraint, so two
// concurrent saves cannot produce a duplicate.
questionnaireSchema.index(
  { userId: 1, enrollmentId: 1 },
  { unique: true, name: 'uniq_questionnaire_user_enrollment' },
);

// A member's questionnaires, newest first (their own history screen).
questionnaireSchema.index({ userId: 1, createdAt: -1 }, { name: 'questionnaire_user_created' });
// Every questionnaire belonging to one coach's clients, for the coach read that
// comes next.
questionnaireSchema.index({ coachId: 1, createdAt: -1 }, { name: 'questionnaire_coach_created' });

const Questionnaire = mongoose.model('Questionnaire', questionnaireSchema);

export default Questionnaire;
