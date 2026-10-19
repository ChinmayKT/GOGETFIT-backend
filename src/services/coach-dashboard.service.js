import mongoose from 'mongoose';

import Coach from '../models/coach.model.js';
import EnrolledClient, { enrollmentStatus } from '../models/enrolled-client.model.js';
import { GROUP_BY_USER_STAGES, LOOKUP_STAGES, buildMatch, currentFirstStages, escapeRegex } from './enrolled-client.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';

/** How many clients (members) one page of the Clients tab holds. */
export const CLIENTS_PAGE_SIZE = 20;
export const CLIENTS_MAX_PAGE_SIZE = 100;

/** An image the app can load, or null — never a half-filled object. */
const toImageRef = (image) =>
  image?.url ? { url: image.url, storageKey: image.storageKey ?? null } : null;

/**
 * One coach's enrollments - the single definition shared by the Coach
 * Workspace dashboard (GET /api/coach/dashboard) and the Admin Portal coach
 * details (GET /api/admin/coaches/:id/clients), so the two never disagree.
 *
 * The relationship is the enrollment's own `coachId` reference; a user's
 * roles or the legacy coach fields never make someone a coach's client. The
 * counts reuse the admin list's status filters (enrolled-client.service.js
 * buildMatch, the query form of enrollmentStatus):
 *
 *   totalEnrollments - every non-deleted enrollment with the coach: started,
 *                      not started and ended alike (each coaching cycle counts).
 *   uniqueClients    - distinct members among those enrollments.
 *   activeClients    - status 'active': started, end date not passed.
 *   pendingClients   - status 'not_started' (bought, not started), excluding
 *                      any whose end date has already passed.
 *   attention        - 0 for now; the attention rules are not defined yet.
 */
export const countCoachEnrollments = async (coachId, now = new Date()) => {
  const id = String(coachId);
  const notDeleted = { ...buildMatch({ coachId: id }, now), isDeleted: { $ne: true } };
  const notEnded = { $or: [{ endDate: null }, { endDate: { $gte: now } }] };

  const [totalEnrollments, clientIds, activeClients, pendingClients, endedClients] = await Promise.all([
    EnrolledClient.countDocuments(notDeleted),
    EnrolledClient.distinct('userId', notDeleted),
    EnrolledClient.countDocuments(buildMatch({ coachId: id, status: 'active' }, now)),
    EnrolledClient.countDocuments({ ...buildMatch({ coachId: id, status: 'not_started' }, now), ...notEnded }),
    // Started, and the end date has passed: the cycle is over.
    EnrolledClient.countDocuments(buildMatch({ coachId: id, status: 'inactive' }, now)),
  ]);

  return {
    totalEnrollments,
    uniqueClients: clientIds.length,
    activeClients,
    pendingClients,
    endedClients,
    attention: 0,
  };
};

/**
 * The signed-in coach's dashboard. The coach is resolved from the
 * authenticated user id; a coach id is never taken from the request.
 * Returns null when the user has no coach profile.
 */
export const getCoachDashboard = async (userId, now = new Date()) => {
  const coach = await Coach.findOne({ userId }, { _id: 1 }).lean();
  if (!coach) return null;
  const { totalEnrollments, activeClients, pendingClients, attention } = await countCoachEnrollments(coach._id, now);
  return { totalEnrollments, activeClients, pendingClients, attention };
};

/** One enrollment row for the admin coach details: who, which plan, when, status. */
const toCoachClientRow = (doc, now) => ({
  enrollmentId: String(doc._id),
  legacyEnrollmentId: doc.legacy?.enrollmentId ?? null,
  coachId: doc.coachId ? String(doc.coachId) : null,
  status: enrollmentStatus(doc, now),
  hasStarted: Boolean(doc.hasStarted),
  enrollDate: doc.enrollDate ? doc.enrollDate.toISOString() : null,
  startDate: doc.startDate ? doc.startDate.toISOString() : null,
  endDate: doc.endDate ? doc.endDate.toISOString() : null,
  user: doc.user
    ? {
        id: String(doc.user._id),
        name: doc.user.profile?.name ?? null,
        phone: doc.user.phone?.normalized ?? null,
        email: doc.user.profile?.email ?? null,
        legacyUserId: doc.user.legacy?.userId ?? null,
      }
    : { id: String(doc.userId), name: null, phone: null, email: null, legacyUserId: null },
  plan: doc.plan
    ? { id: String(doc.plan._id), name: doc.plan.name ?? null, legacyPackageId: doc.plan.legacy?.packageId ?? null }
    : { id: String(doc.planId), name: null, legacyPackageId: null },
});

/**
 * One client row for the Coach Workspace: who they are, which plan they are
 * on, and where that cycle stands.
 *
 * Keyed by `enrollmentId`, not by user: a member who enrolls with the same
 * coach twice has two cycles, and every screen below this one is scoped to one
 * of them. The relationship itself is the enrollment's own `coachId` - a user's
 * roles never make them somebody's client.
 */
const toWorkspaceClientRow = (doc, now) => ({
  enrollmentId: String(doc._id),
  status: enrollmentStatus(doc, now),
  hasStarted: Boolean(doc.hasStarted),
  enrollDate: doc.enrollDate ? doc.enrollDate.toISOString() : null,
  startDate: doc.startDate ? doc.startDate.toISOString() : null,
  endDate: doc.endDate ? doc.endDate.toISOString() : null,
  client: {
    userId: doc.user ? String(doc.user._id) : String(doc.userId),
    name: doc.user?.profile?.name ?? null,
    profilePicture: doc.user?.profile?.profilePicture ?? null,
    phone: doc.user?.phone?.normalized ?? null,
    email: doc.user?.profile?.email ?? null,
  },
  plan: {
    id: doc.plan ? String(doc.plan._id) : (doc.planId ? String(doc.planId) : null),
    name: doc.plan?.name ?? null,
    image: toImageRef(doc.plan?.image),
  },
  // Whether the member has submitted this cycle's questionnaire (status
  // "submitted" - a draft does not count). Drives Client Details' attention dot.
  questionnaireSubmitted: (doc.submittedQuestionnaires?.length ?? 0) > 0,
  // Whether this cycle's Body Metrics are submitted (drafts do not count).
  bodyMetricsSubmitted: (doc.submittedBodyMetrics?.length ?? 0) > 0,
});

/** Joins only this enrollment's SUBMITTED Body Metrics (one at most, by the unique index). */
const SUBMITTED_BODY_METRICS_LOOKUP = {
  $lookup: {
    from: 'bodymetrics',
    let: { enrollmentId: '$_id', userId: '$userId' },
    pipeline: [
      {
        $match: {
          $expr: { $and: [{ $eq: ['$enrollmentId', '$$enrollmentId'] }, { $eq: ['$userId', '$$userId'] }] },
          status: 'submitted',
        },
      },
      { $project: { _id: 1 } },
      { $limit: 1 },
    ],
    as: 'submittedBodyMetrics',
  },
};

/** Joins only this enrollment's SUBMITTED questionnaire (one at most, by the unique index). */
const SUBMITTED_QUESTIONNAIRE_LOOKUP = {
  $lookup: {
    from: 'questionnaires',
    let: { enrollmentId: '$_id', userId: '$userId' },
    pipeline: [
      {
        $match: {
          $expr: { $and: [{ $eq: ['$enrollmentId', '$$enrollmentId'] }, { $eq: ['$userId', '$$userId'] }] },
          status: 'submitted',
        },
      },
      { $project: { _id: 1 } },
      { $limit: 1 },
    ],
    as: 'submittedQuestionnaires',
  },
};

/**
 * The signed-in coach's own clients: one row per MEMBER, carrying that
 * member's current/latest enrollment with this coach (currentFirstStages) and
 * how many enrollments they have with this coach. Earlier cycles are reached
 * through getClientEnrollmentsForCoachUser, never dropped.
 *
 * The coach's enrollments are filtered first, then grouped by userId, then
 * searched, sorted and paged - so paging and `pagination.total` count people,
 * not purchases. Rows are ordered by the current enrollment's enrollDate,
 * newest first (the order the per-enrollment list had), userId breaking ties.
 *
 * The coach is resolved from the authenticated user id - a coach id is never
 * taken from the request, so a coach can only ever read their own clients.
 * Returns null when the user has no coach profile.
 */
export const getClientsForCoachUser = async (userId, params = {}, now = new Date()) => {
  const coach = await Coach.findOne({ userId }, { _id: 1 }).lean();
  if (!coach) return null;

  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || CLIENTS_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), CLIENTS_MAX_PAGE_SIZE);
  const term = String(params.search ?? '').trim();

  const pipeline = [
    { $match: { coachId: coach._id, isDeleted: { $ne: true } } },
    ...currentFirstStages(now),
    ...GROUP_BY_USER_STAGES,
  ];
  if (term !== '') {
    // Searched on the member, after grouping: a member matches once however
    // many enrollments they have.
    const rx = new RegExp(escapeRegex(term), 'i');
    pipeline.push(
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'searchUser',
          pipeline: [{ $project: { 'profile.name': 1, 'phone.normalized': 1 } }],
        },
      },
      { $match: { $or: [{ 'searchUser.profile.name': rx }, { 'searchUser.phone.normalized': rx }] } },
    );
  }
  pipeline.push({
    $facet: {
      // Sort is total (userId is unique per row), so a member can never appear
      // on two pages or fall between them. Joins run on the page only.
      rows: [
        { $sort: { enrollDate: -1, userId: 1 } },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        ...LOOKUP_STAGES,
        SUBMITTED_QUESTIONNAIRE_LOOKUP,
        SUBMITTED_BODY_METRICS_LOOKUP,
      ],
      total: [{ $count: 'count' }],
    },
  });

  const [summary, [result]] = await Promise.all([
    countCoachEnrollments(coach._id, now),
    EnrolledClient.aggregate(pipeline),
  ]);

  const total = result?.total?.[0]?.count ?? 0;
  return {
    summary: {
      // Enrollments (coaching cycles); uniqueClients counts the people.
      total: summary.totalEnrollments,
      uniqueClients: summary.uniqueClients,
      active: summary.activeClients,
      pending: summary.pendingClients,
      ended: summary.endedClients,
    },
    // Unique members matching the query - what the list pages over.
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
    clients: (result?.rows ?? []).map((doc) => ({
      ...toWorkspaceClientRow(doc, now),
      enrollmentCount: doc.enrollmentCount,
    })),
  };
};

/**
 * One member's enrollment history with the signed-in coach: every
 * non-deleted enrollment of [clientUserId] assigned to THIS coach,
 * current/latest first, older ones after (currentFirstStages). Enrollments the
 * member has with other coaches are never included.
 *
 * Each entry has the same shape as a Clients row (so the app can open any
 * cycle in Client Details), plus its coach and `isCurrent` (true only for the
 * first entry, and only when it is active).
 *
 * Returns null when the user has no coach profile; 404 when the member has no
 * enrollment with this coach (or the id is not a valid id).
 */
export const getClientEnrollmentsForCoachUser = async (userId, clientUserId, now = new Date()) => {
  const coach = await Coach.findOne({ userId }, { _id: 1 }).lean();
  if (!coach) return null;

  const notFoundError = notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'This member is not one of your clients');
  if (!mongoose.isValidObjectId(clientUserId)) throw notFoundError;

  const docs = await EnrolledClient.aggregate([
    {
      $match: {
        coachId: coach._id,
        userId: new mongoose.Types.ObjectId(clientUserId),
        isDeleted: { $ne: true },
      },
    },
    ...currentFirstStages(now),
    ...LOOKUP_STAGES,
    SUBMITTED_QUESTIONNAIRE_LOOKUP,
    SUBMITTED_BODY_METRICS_LOOKUP,
  ]);
  if (docs.length === 0) throw notFoundError;

  const enrollments = docs.map((doc, index) => {
    const row = toWorkspaceClientRow(doc, now);
    return {
      ...row,
      coach: doc.coach ? { id: String(doc.coach._id), name: doc.coach.user?.profile?.name ?? null } : null,
      isCurrent: index === 0 && row.status === 'active',
    };
  });
  return { client: enrollments[0].client, enrollments };
};

/**
 * Admin: a coach's statistics and every non-deleted enrollment they have,
 * newest first. Several enrollments of one member are all kept - they are
 * separate coaching cycles; `uniqueClients` counts the people.
 * Returns null when there is no such coach.
 */
export const getCoachClients = async (coachId, now = new Date()) => {
  if (!mongoose.isValidObjectId(coachId)) return null;
  const coach = await Coach.findById(coachId, { _id: 1 }).lean();
  if (!coach) return null;

  const [summary, docs] = await Promise.all([
    countCoachEnrollments(coach._id, now),
    EnrolledClient.aggregate([
      { $match: { coachId: coach._id, isDeleted: { $ne: true } } },
      ...LOOKUP_STAGES,
      { $sort: { enrollDate: -1, _id: 1 } },
    ]),
  ]);

  return { coachId: String(coach._id), summary, enrollments: docs.map((doc) => toCoachClientRow(doc, now)) };
};

export default {
  countCoachEnrollments,
  getCoachDashboard,
  getCoachClients,
  getClientsForCoachUser,
  getClientEnrollmentsForCoachUser,
};
