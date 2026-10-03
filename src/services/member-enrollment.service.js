import EnrolledClient, { enrollmentStatus } from '../models/enrolled-client.model.js';
import { PLAN_CURRENCY } from '../models/gogetfit-plan.model.js';
import { toMemberCoach } from './coach.service.js';
import { toMemberPlan } from './gogetfit-plan.service.js';

/**
 * The member's own coaching history: every plan they have bought, newest first.
 *
 * Deliberately separate from the admin enrolled-client service. That one joins
 * the member, the coupon and the legacy block for a sales screen; this one is
 * what a member may see about themselves — their plan, their coach, their
 * dates and what they paid, and nothing about anyone else.
 *
 * Scoped by the caller's own id in the query itself, so there is no parameter a
 * client could use to read another member's purchases.
 */

const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * One enrollment as the member sees it. The coach and the plan are served in
 * the same shapes `GET /coaches` and `GET /coaches/:id/plans` use, so the app
 * parses them with the models it already has.
 */
export const toMemberEnrollment = (doc, now = new Date()) => ({
  id: String(doc._id),
  status: enrollmentStatus(doc, now),
  plan: doc.planId && typeof doc.planId === 'object' ? toMemberPlan(doc.planId) : null,
  coach:
    doc.coachId && typeof doc.coachId === 'object'
      ? toMemberCoach(doc.coachId, doc.coachId.userId)
      : null,

  enrollDate: iso(doc.enrollDate),
  startDate: iso(doc.startDate),
  endDate: iso(doc.endDate),
  hasStarted: Boolean(doc.hasStarted),

  payment: {
    /** What was actually charged, in whole rupees. */
    amount: doc.payment?.amount ?? null,
    currency: doc.payment?.currency ?? PLAN_CURRENCY,
    originalAmount: doc.payment?.originalAmount ?? null,
    discountPercent: doc.payment?.discountPercent ?? null,
    status: doc.payment?.status ?? null,
    paidAt: iso(doc.payment?.paidAt),
    /** The gateway reference, so a member can quote it to support. */
    reference: doc.payment?.transactionId ?? null,
  },

  createdAt: iso(doc.createdAt),
});

const POPULATE = [
  { path: 'planId' },
  { path: 'coachId', populate: { path: 'userId', select: 'profile.name profile.gender profile.city profile.email phone' } },
];

/**
 * Every enrollment the member owns, newest purchase first.
 *
 * Soft-deleted rows are left out: they are an admin correction, not something
 * the member bought. Everything else is kept, including expired cycles — the
 * history is the point.
 */
export const listMemberEnrollments = async (userId, now = new Date()) => {
  const docs = await EnrolledClient.find({ userId, isDeleted: { $ne: true } })
    .sort({ enrollDate: -1, createdAt: -1, _id: -1 })
    .populate(POPULATE)
    .lean();

  const enrollments = docs.map((doc) => toMemberEnrollment(doc, now));

  return {
    enrollments,
    total: enrollments.length,
    /**
     * The one the app treats as "my current plan", by the same rule the rest of
     * the system uses: `active` means started and not past its end date. A
     * member with two running cycles gets the most recently bought one, which
     * is also the order the list is in.
     */
    current: enrollments.find((e) => e.status === 'active') ?? null,
  };
};

/**
 * The member's current coach — the coach on their active enrollment.
 *
 * Null when there is no active enrollment, which is a normal state (never
 * bought, or the last plan has ended) and not an error.
 */
export const getMemberCoach = async (userId, now = new Date()) => {
  const { current } = await listMemberEnrollments(userId, now);
  if (!current?.coach) return null;
  return { coach: current.coach, enrollment: { id: current.id, endDate: current.endDate, plan: current.plan } };
};
