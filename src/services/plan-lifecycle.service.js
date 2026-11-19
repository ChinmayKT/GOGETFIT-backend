import DietPlan from '../models/diet-plan.model.js';
import EnrolledClient, { enrollmentLifecycle } from '../models/enrolled-client.model.js';
import GogetfitPlan from '../models/gogetfit-plan.model.js';
import WorkoutPlan from '../models/workout-plan.model.js';
import { addCalendarDays, businessDayOf, startOfBusinessDay } from '../utils/business-date.js';
import { ERROR_CODES, conflict, forbidden } from '../utils/errors.js';
import { clientOfCoachEnrollment } from './diet-plan.service.js';

/**
 * A member's coaching-plan lifecycle, from their enrollments - the one place
 * the app's plan permissions and the food-log authorization are decided
 * (each enrollment by enrollmentLifecycle: IST calendar days, end inclusive).
 *
 * Buying a plan never makes it active: only the coach's Start does, from the
 * next day, until its last day.
 */

/** 403 INTAKE_PLAN_NOT_ACTIVE - Intake and Daily Update outside an active plan. */
export const planNotActive = (message = 'Food intake submission is available only during an active coaching plan.') =>
  forbidden(ERROR_CODES.INTAKE_PLAN_NOT_ACTIVE, message);

/**
 * The member's plan permissions on [now]'s business day, and the enrollment
 * that authorizes an active plan (null without one).
 *
 *  - Several active plans (legacy overlaps): the latest-starting one.
 *  - A scheduled plan (started, first day ahead) authorizes nothing yet, but
 *    already ends the member's own calorie goal.
 *  - Not started, completed and deleted enrollments authorize nothing.
 */
export const planAccessOf = async (userId, now = new Date()) => {
  const docs = await EnrolledClient.find(
    { userId, hasStarted: true, isDeleted: { $ne: true } },
    { planId: 1, coachId: 1, startDate: 1, endDate: 1, hasStarted: 1, isDeleted: 1 },
  )
    .sort({ startDate: -1, _id: -1 })
    .lean();
  const active = docs.find((d) => enrollmentLifecycle(d, now) === 'active') ?? null;
  const scheduled = docs.find((d) => enrollmentLifecycle(d, now) === 'scheduled') ?? null;
  const current = active ?? scheduled;
  return {
    enrollment: active,
    access: {
      status: active ? 'active' : scheduled ? 'scheduled' : 'none',
      planActive: Boolean(active),
      canSubmitFoodLog: Boolean(active),
      canSetOwnCalorieGoal: !current,
      activeEnrollmentId: active ? String(active._id) : null,
      activePlanId: active?.planId ? String(active.planId) : null,
      // The current (active, else scheduled) plan's days, YYYY-MM-DD in IST.
      planStartDate: current ? businessDayOf(current.startDate) : null,
      planEndDate: current ? businessDayOf(current.endDate) : null,
    },
  };
};

/** The enrollment authorizing an active plan today; 403 without one. */
export const requireActivePlan = async (userId, now = new Date()) => {
  const { enrollment } = await planAccessOf(userId, now);
  if (!enrollment) throw planNotActive();
  return enrollment;
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
 *  - Never overlapping another started plan of the member still running on
 *    or after that first day.
 *
 * ponytail: the overlap check and the start are two writes, not one
 * transaction - two coaches starting two plans of one member in the same
 * instant could both pass. Wrap both in a session if that ever matters.
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

  const others = await EnrolledClient.find(
    { userId: clientId, _id: { $ne: enrollment._id }, hasStarted: true, isDeleted: { $ne: true } },
    { startDate: 1, endDate: 1, hasStarted: 1, isDeleted: 1 },
  ).lean();
  const overlapping = others.some(
    (d) => ['active', 'scheduled'].includes(enrollmentLifecycle(d, now)) && businessDayOf(d.endDate) >= firstDay,
  );
  if (overlapping) {
    throw conflict(ERROR_CODES.PLAN_OVERLAP, "This client's current plan is still running - start this one after it ends");
  }

  // Only an unstarted, live enrollment: a concurrent second Start finds none.
  const started = await EnrolledClient.findOneAndUpdate(
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
    { new: true },
  ).lean();
  if (!started) throw conflict(ERROR_CODES.PLAN_ALREADY_STARTED, 'This plan has already been started');

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

export default { planAccessOf, requireActivePlan, startPlanForCoach, planNotActive };
