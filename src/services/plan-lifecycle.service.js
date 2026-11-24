import mongoose from 'mongoose';

import DietPlan from '../models/diet-plan.model.js';
import EnrolledClient, { currentEnrollmentOf, enrollmentLifecycle } from '../models/enrolled-client.model.js';
import GogetfitPlan from '../models/gogetfit-plan.model.js';
import WorkoutPlan from '../models/workout-plan.model.js';
import { addCalendarDays, businessDayOf, startOfBusinessDay } from '../utils/business-date.js';
import { AppError, ERROR_CODES, conflict, forbidden } from '../utils/errors.js';
import { clientOfCoachEnrollment } from './diet-plan.service.js';

/**
 * A member's coaching-plan lifecycle, from their enrollments - the one place
 * the app's plan permissions and the food-log authorization are decided
 * (each enrollment by enrollmentLifecycle: IST calendar days, end inclusive).
 *
 * Buying a plan never unlocks anything: only the coach's Start does - the
 * features at once, the official days (duration, weeks, expiry) from the
 * next IST day until its last day.
 */

/** 403 INTAKE_PLAN_NOT_ACTIVE - Intake and Daily Update outside an active plan. */
export const planNotActive = (message = 'Food intake submission is available only during an active coaching plan.') =>
  forbidden(ERROR_CODES.INTAKE_PLAN_NOT_ACTIVE, message);

/**
 * The member's plan permissions at [now], and the enrollment that authorizes
 * them (null without one) - unlocksPlan.
 *
 *  - Several active plans (legacy overlaps): the latest-starting one.
 *  - A scheduled plan the coach has started (first official day tomorrow)
 *    authorizes everything at once; its dates are not moved.
 *  - Not started, completed and deleted enrollments authorize nothing.
 */
export const planAccessOf = async (userId, now = new Date()) => {
  const docs = await EnrolledClient.find(
    { userId, hasStarted: true, isDeleted: { $ne: true } },
    { planId: 1, coachId: 1, startDate: 1, endDate: 1, startedAt: 1, hasStarted: 1, isDeleted: 1 },
  )
    .sort({ startDate: -1, _id: -1 })
    .lean();
  const active = docs.find((d) => enrollmentLifecycle(d, now) === 'active') ?? null;
  const scheduled = docs.find((d) => enrollmentLifecycle(d, now) === 'scheduled') ?? null;
  const current = active ?? scheduled;
  // The enrollment unlocking the plan features now (currentEnrollmentOf).
  const unlocked = currentEnrollmentOf(docs, now);
  return {
    enrollment: unlocked,
    access: {
      // The official lifecycle (dates); planActive is the access decision.
      status: active ? 'active' : scheduled ? 'scheduled' : 'none',
      planActive: Boolean(unlocked),
      canSubmitFoodLog: Boolean(unlocked),
      canSetOwnCalorieGoal: !current,
      activeEnrollmentId: unlocked ? String(unlocked._id) : null,
      activePlanId: unlocked?.planId ? String(unlocked.planId) : null,
      // The current (active, else scheduled) plan's days, YYYY-MM-DD in IST.
      planStartDate: current ? businessDayOf(current.startDate) : null,
      planEndDate: current ? businessDayOf(current.endDate) : null,
    },
  };
};

/**
 * The member's enrollments the coach has not started (bought, waiting).
 * Their diet and workout plans - assigned ahead, as Start requires - are
 * never the member's plan of the day: a plan bought during another, or
 * after it, shows nothing until its Start.
 */
export const unstartedEnrollmentIds = (userId) =>
  EnrolledClient.distinct('_id', { userId, hasStarted: { $ne: true } });

/** The enrollment authorizing the plan features now; 403 without one. */
export const requireActivePlan = async (userId, now = new Date()) => {
  const { enrollment } = await planAccessOf(userId, now);
  if (!enrollment) throw planNotActive();
  return enrollment;
};

/**
 * One document per member (planstartlocks, _id = the member's user id) that
 * every plan start writes inside its transaction - nothing else reads it.
 * Two transactions starting plans for one member both write it, so MongoDB
 * lets only one commit: the other gets a WriteConflict (a transient error)
 * and withTransaction re-runs it from the start, now reading what the first
 * committed - and refusing. Members never block each other.
 */
const PlanStartLock =
  mongoose.models.PlanStartLock ??
  mongoose.model(
    'PlanStartLock',
    new mongoose.Schema({ _id: mongoose.Schema.Types.ObjectId, seq: { type: Number, default: 0 } }, { versionKey: false, collection: 'planstartlocks' }),
  );

/**
 * Creates the member's lock document if missing. Call BEFORE the
 * transaction: created inside it, two first-ever starts could both insert
 * (a duplicate key is not a retryable conflict). Concurrent creators race
 * harmlessly - the loser's duplicate key means it exists.
 */
export const ensureMemberLock = async (userId) => {
  try {
    await PlanStartLock.updateOne({ _id: userId }, { $setOnInsert: { seq: 0 } }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
};

/** Takes the member's lock in [session] (after ensureMemberLock). */
export const lockMemberPlans = async (userId, session) => {
  const { matchedCount } = await PlanStartLock.updateOne({ _id: userId }, { $inc: { seq: 1 } }, { session });
  // Never proceed unlocked: a missing lock document would let two starts pass.
  if (matchedCount !== 1) throw new Error(`Plan start lock missing for member ${userId}`);
};

/** 409 ACTIVE_PLAN_EXISTS - a plan of the member has not expired yet. */
export const activePlanExists = (live) =>
  new AppError(
    409,
    ERROR_CODES.ACTIVE_PLAN_EXISTS,
    "The client's current plan is still active. You can start this plan only after the current plan expires.",
    { currentPlanEndDate: live?.endDate ? businessDayOf(live.endDate) : null },
  );

/**
 * The member's started plan that has not expired yet (active, or started
 * with its first day ahead) other than [exceptId], or null. One rule for
 * every Start: a member has at most one such plan.
 */
const livePlanOf = async (userId, exceptId, now, session) => {
  const docs = await EnrolledClient.find(
    { userId, _id: { $ne: exceptId }, hasStarted: true, isDeleted: { $ne: true } },
    { startDate: 1, endDate: 1, startedAt: 1, hasStarted: 1, isDeleted: 1 },
  )
    .session(session)
    .lean();
  return docs.find((d) => ['active', 'scheduled'].includes(enrollmentLifecycle(d, now))) ?? null;
};

/**
 * Coach Start: the signed-in coach starts one of their own enrollments.
 *
 *  - Ownership from the token and the enrollment (clientOfCoachEnrollment).
 *  - Ready: an active diet plan AND an active workout plan assigned to this
 *    enrollment - every coaching plan includes both (agreed 2026-11-18; the
 *    plans data has no per-plan component list or "ready" state).
 *  - Duration: the plan's durationWeeks from the Plans database.
 *  - Dates: first day = tomorrow (IST); last day = first + weeks x 7 - 1.
 *  - One plan at a time: refused (409 ACTIVE_PLAN_EXISTS) while any other
 *    started plan of the member has not expired - including on its last day,
 *    until 00:00 IST after it. Nothing is queued or started later by itself.
 *  - The check and the write run in one transaction under the member's lock
 *    (lockMemberPlans), so two Starts for one member never both succeed, and
 *    a refused Start writes nothing.
 */
export const startPlanForCoach = async (coachUserId, enrollmentId, { now = new Date() } = {}) => {
  const clientId = await clientOfCoachEnrollment(coachUserId, enrollmentId);
  const enrollment = await EnrolledClient.findById(enrollmentId, { planId: 1, hasStarted: 1 }).lean();
  if (enrollment.hasStarted) throw conflict(ERROR_CODES.PLAN_ALREADY_STARTED, 'This plan has already been started');

  const [hasDiet, hasWorkout, plan] = await Promise.all([
    DietPlan.exists({ enrollmentId, status: 'active' }),
    WorkoutPlan.exists({ enrollmentId, status: 'active' }),
    GogetfitPlan.findById(enrollment.planId, { durationWeeks: 1 }).lean(),
  ]);
  const missing = [!hasDiet && 'diet plan', !hasWorkout && 'workout plan'].filter(Boolean);
  if (missing.length) {
    throw conflict(ERROR_CODES.PLAN_NOT_READY, `Assign the client's ${missing.join(' and ')} before starting the plan`);
  }
  const weeks = plan?.durationWeeks;
  if (!Number.isInteger(weeks) || weeks <= 0) {
    throw conflict(ERROR_CODES.PLAN_DURATION_MISSING, 'This plan has no duration set - contact the admin');
  }

  const firstDay = addCalendarDays(businessDayOf(now), 1);
  const lastDay = addCalendarDays(firstDay, weeks * 7 - 1);

  await ensureMemberLock(clientId);
  const session = await mongoose.startSession();
  let started;
  try {
    await session.withTransaction(async () => {
      await lockMemberPlans(clientId, session);
      const live = await livePlanOf(clientId, enrollment._id, now, session);
      if (live) throw activePlanExists(live);
      // Only an unstarted, live enrollment: a second Start of it finds none.
      started = await EnrolledClient.findOneAndUpdate(
        { _id: enrollment._id, hasStarted: { $ne: true }, isDeleted: { $ne: true } },
        {
          $set: {
            hasStarted: true,
            startDate: startOfBusinessDay(firstDay),
            endDate: startOfBusinessDay(lastDay),
            startedAt: now,
            updatedBy: coachUserId,
          },
        },
        { new: true, session },
      ).lean();
      if (!started) throw conflict(ERROR_CODES.PLAN_ALREADY_STARTED, 'This plan has already been started');
    });
  } finally {
    await session.endSession();
  }

  return {
    enrollmentId: String(started._id),
    lifecycle: enrollmentLifecycle(started, now),
    durationWeeks: weeks,
    startedAt: started.startedAt.toISOString(),
    startDate: started.startDate.toISOString(),
    endDate: started.endDate.toISOString(),
    planStartDate: firstDay,
    planEndDate: lastDay,
  };
};

/**
 * Admin manual enrollment with dates: refused (409 PLAN_OVERLAP) when its
 * days [startDay, endDay] meet the days of another started plan of the
 * member - a coach-started plan's days counting from its Start day (its
 * immediate access). A past, non-overlapping cycle (history) is allowed.
 * Run inside the caller's transaction, after lockMemberPlans (and
 * ensureMemberLock before that transaction).
 */
export const assertNoOverlappingPlan = async (userId, startDay, endDay, session) => {
  const docs = await EnrolledClient.find(
    { userId, hasStarted: true, isDeleted: { $ne: true } },
    { startDate: 1, endDate: 1, startedAt: 1 },
  )
    .session(session)
    .lean();
  const overlapping = docs.some((d) => {
    if (!d.startDate || !d.endDate) return false;
    const from = [businessDayOf(d.startDate), d.startedAt && businessDayOf(d.startedAt)].filter(Boolean).sort()[0];
    return from <= endDay && startDay <= businessDayOf(d.endDate);
  });
  if (overlapping) {
    throw conflict(ERROR_CODES.PLAN_OVERLAP, "These dates overlap another plan of this client - a client can have only one plan at a time");
  }
};

export default { planAccessOf, requireActivePlan, startPlanForCoach, planNotActive, ensureMemberLock, lockMemberPlans, assertNoOverlappingPlan };
