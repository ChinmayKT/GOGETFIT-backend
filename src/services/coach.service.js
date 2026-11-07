import mongoose from 'mongoose';

import Coach from '../models/coach.model.js';
import CoachMonthlyCapacity from '../models/coach-monthly-capacity.model.js';
import EnrolledClient from '../models/enrolled-client.model.js';
import User from '../models/user.model.js';
import { ROLE_COACH } from '../constants/roles.js';
import { calculateAge } from '../utils/age.js';
import { ERROR_CODES, conflict, notFound } from '../utils/errors.js';
import { businessDayOf } from '../utils/business-date.js';
import { normalizePhone } from '../utils/phone.js';
import { toAdminUser } from './admin.service.js';
import {
  ensureMonthRecord,
  memberAvailability,
  monthOfDay,
  recordCapacityChange,
} from './coach-capacity.service.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SORTABLE = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  level: 'profile.level',
  status: 'status',
};

/** Only the user fields needed to join onto a coach - nothing that could be a
 *  credential is ever projected, so there is nothing to strip afterwards. */
const USER_SUMMARY_PROJECTION = {
  phone: 1,
  'profile.name': 1,
  'profile.email': 1,
  'profile.gender': 1,
  'profile.city': 1,
  'profile.profilePicture': 1,
  roles: 1,
  status: 1,
};

/**
 * The safe user summary that travels with every coach. Allow-listed like
 * toAdminUser: no auth subdocument, no OTP material.
 */
export const toCoachUser = (user) =>
  user
    ? {
        id: String(user._id),
        name: user.profile?.name ?? null,
        phone: user.phone?.normalized ?? null,
        email: user.profile?.email ?? null,
        gender: user.profile?.gender ?? null,
        city: user.profile?.city ?? null,
        profilePicture: user.profile?.profilePicture ?? null,
        roles: Array.isArray(user.roles) ? user.roles : [],
        status: user.status ?? null,
      }
    : null;

const toImageRef = (image) =>
  image?.url ? { url: image.url, storageKey: image.storageKey ?? null } : null;

export const toCoach = (doc, user) => ({
  id: String(doc._id),
  userId: String(doc.userId),
  user: toCoachUser(user),
  profile: {
    profilePicture: toImageRef(doc.profile?.profilePicture),
    coverPicture: toImageRef(doc.profile?.coverPicture),
    level: doc.profile?.level ?? null,
    specialization: doc.profile?.specialization ?? null,
    description: doc.profile?.description ?? null,
    languages: Array.isArray(doc.profile?.languages) ? doc.profile.languages : [],
    facebook: doc.profile?.facebook ?? null,
    instagram: doc.profile?.instagram ?? null,
    linkedin: doc.profile?.linkedin ?? null,
    transformations: doc.profile?.transformations ?? null,
    monthlySlots: doc.profile?.monthlySlots ?? null,
  },
  status: doc.status ?? null,
  createdBy: doc.createdBy ? String(doc.createdBy) : null,
  updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
  createdAt: doc.createdAt ? doc.createdAt.toISOString() : null,
  updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
});

const loadUser = (userId) => User.findById(userId, USER_SUMMARY_PROJECTION).lean();

const alreadyCoach = () => conflict(ERROR_CODES.COACH_ALREADY_EXISTS, 'This user is already a coach');

/**
 * Add Coach, step 1: find the existing user behind a phone number.
 *
 * The phone goes through the same normalizePhone the OTP login uses, so the
 * portal can type it with or without +91, spaces or a trunk 0. An invalid
 * number surfaces as the usual 400 INVALID_PHONE from the error middleware.
 */
export const findUserByPhone = async (phone) => {
  const normalized = normalizePhone(phone);

  const user = await User.findOne({ 'phone.normalized': normalized }).lean();
  if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');

  const coach = await Coach.findOne({ userId: user._id }, { _id: 1, status: 1 }).lean();

  return {
    user: toAdminUser(user, calculateAge(user.profile?.dateOfBirth)),
    // Present when the user already has a coach profile, so the portal can offer
    // View / Edit instead of a second create.
    coach: coach ? { id: String(coach._id), status: coach.status } : null,
  };
};

/**
 * Creates the coach profile and grants the "coach" role as ONE unit of work.
 *
 * Both writes run inside a MongoDB transaction (the deployment is an Atlas
 * replica set), so the two failure states - a user with the role but no
 * profile, or a profile whose user lacks the role - cannot be committed. If
 * anything throws, neither write survives.
 *
 * The role is added with $addToSet, never by assigning the array: roles are
 * additive, so ["user", "client"] becomes ["user", "client", "coach"] and an
 * existing "coach" is not duplicated.
 *
 * A user who already holds the "coach" role but has no profile is allowed
 * through: that is exactly the inconsistent state this operation exists to
 * prevent, and creating the profile is what repairs it. The duplicate rule is
 * "one profile per user", enforced here and by the unique index on userId.
 */
export const createCoach = async (input, adminId) => {
  const session = await mongoose.startSession();
  let coachId;

  try {
    await session.withTransaction(async () => {
      const user = await User.findById(input.userId, { _id: 1 }).session(session).lean();
      if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');

      const existing = await Coach.exists({ userId: user._id }).session(session);
      if (existing) throw alreadyCoach();

      const [coach] = await Coach.create(
        [
          {
            userId: user._id,
            profile: input.profile,
            status: input.status ?? 'active',
            createdBy: adminId,
            updatedBy: adminId,
          },
        ],
        { session },
      );

      const monthlySlots = input.profile?.monthlySlots;
      if (monthlySlots !== undefined) {
        await CoachMonthlyCapacity.create(
          [{ coachId: coach._id, month: monthOfDay(businessDayOf(new Date())), capacity: monthlySlots, createdBy: adminId, updatedBy: adminId }],
          { session },
        );
      }

      const granted = await User.updateOne(
        { _id: user._id },
        { $addToSet: { roles: ROLE_COACH } },
        { session },
      );
      if (granted.matchedCount !== 1) {
        // The user vanished mid-transaction; abort rather than leave an orphan.
        throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
      }

      coachId = coach._id;
    });
  } catch (error) {
    // Two admins creating the same coach at once: the unique index decides.
    if (error?.code === 11000) throw alreadyCoach();
    throw error;
  } finally {
    await session.endSession();
  }

  return getCoachById(coachId);
};

export const getCoachById = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const doc = await Coach.findById(id).lean();
  if (!doc) return null;
  return toCoach(doc, await loadUser(doc.userId));
};

/**
 * Controlled update: only validated profile fields and status are $set, each by
 * its own path, so fields the edit did not send are left untouched. userId is
 * never part of the update (the validator refuses it, and the schema marks it
 * immutable). Coach status is independent of User.status and of User.roles:
 * deactivating a coach keeps the "coach" role, which records that the user
 * holds a coach profile.
 */
export const updateCoach = async (id, patch, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const update = { updatedBy: adminId };
  for (const [key, value] of Object.entries(patch.profile ?? {})) {
    update[`profile.${key}`] = value;
  }
  if (patch.status !== undefined) update.status = patch.status;

  const monthlySlots = patch.profile?.monthlySlots;
  const doc = monthlySlots === undefined
    ? await Coach.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true }).lean()
    : await updateCoachWithCapacity(id, update, monthlySlots, adminId);
  if (!doc) return null;

  return toCoach(doc, await loadUser(doc.userId));
};

/**
 * A new allocation applies from now on and is recorded on the current month, in
 * one transaction with the coach. Bookings and earlier months are never touched:
 * capacity below what is already booked simply stops new bookings.
 */
const updateCoachWithCapacity = async (id, update, monthlySlots, adminId, at = new Date()) => {
  const current = await Coach.findById(id, { 'profile.monthlySlots': 1 }).lean();
  if (!current) return null;
  await ensureMonthRecord(id, monthOfDay(businessDayOf(at)), current.profile?.monthlySlots ?? monthlySlots, adminId);

  const session = await mongoose.startSession();
  let doc;
  try {
    await session.withTransaction(async () => {
      const before = await Coach.findById(id, { 'profile.monthlySlots': 1 }).session(session).lean();
      const from = before?.profile?.monthlySlots ?? null;
      doc = await Coach.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true, session }).lean();
      if (doc && from !== monthlySlots) {
        await recordCapacityChange(id, { from, to: monthlySlots, adminId, at }, session);
      }
    });
  } finally {
    await session.endSession();
  }
  return doc;
};

/**
 * Search is over the joined user (name, email, phone) as well as the coach's
 * own specialization. User matches are resolved to ids first; there are a few
 * hundred users, so the id list stays small.
 */
const buildCoachFilter = async ({ search, status, level } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (level) filter['profile.level'] = level;

  const term = String(search ?? '').trim();
  if (term !== '') {
    const rx = new RegExp(escapeRegex(term), 'i');
    const userOr = [{ 'profile.name': rx }, { 'profile.email': rx }, { 'phone.raw': rx }];

    // Digits typed in any format (+91 98..., 098...) match the stored normalized phone.
    const digits = term.replace(/\D/g, '');
    if (digits !== '') userOr.push({ 'phone.normalized': new RegExp(escapeRegex(digits)) });

    const userIds = await User.find({ $or: userOr }).distinct('_id');
    filter.$or = [{ userId: { $in: userIds } }, { 'profile.specialization': rx }];
  }

  return filter;
};

export const listCoaches = async (params = {}) => {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);

  const sortField = SORTABLE[params.sortKey] ?? SORTABLE.createdAt;
  const sortDir = params.sortDir === 'asc' ? 1 : -1;

  const filter = await buildCoachFilter(params);

  const [docs, total] = await Promise.all([
    Coach.find(filter)
      .sort({ [sortField]: sortDir, _id: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Coach.countDocuments(filter),
  ]);

  // One query for the page's users, joined in memory.
  const users = await User.find(
    { _id: { $in: docs.map((doc) => doc.userId) } },
    USER_SUMMARY_PROJECTION,
  ).lean();
  const byId = new Map(users.map((user) => [String(user._id), user]));

  return {
    rows: docs.map((doc) => toCoach(doc, byId.get(String(doc.userId)))),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

/*
 * ---------------------------------------------------------------------------
 * Member-facing reads (GET /api/coaches). Read-only coach discovery for the app.
 * ---------------------------------------------------------------------------
 */

/**
 * The member-facing coach. Its own allow-list, not the admin shape with fields
 * deleted, so an administrative or personal field added later stays invisible
 * here until someone deliberately exposes it.
 *
 * The coach's phone and email are included: the coach profile offers members
 * WhatsApp, call and email buttons, and these are the coach's contact channels.
 *
 * Deliberately left out:
 *   - the user's own avatar (User.profile.profilePicture): the coach is shown
 *     with the coach's own pictures only, so the app cannot mix the two up;
 *   - status (always "active" here), audit fields and roles;
 *   - the monthly capacity: customers only ever see what has been released.
 *
 * [availability] comes from memberAvailability. Without it (a cart line, the
 * coach's own record) no slots are claimed. [clientsCoachedCount] comes from
 * countClientsCoached and is likewise only worked out for the coach reads.
 */
export const toMemberCoach = (doc, user, availability = null, clientsCoachedCount = 0) => ({
  id: String(doc._id),
  user: {
    id: String(doc.userId),
    name: user?.profile?.name ?? null,
    gender: user?.profile?.gender ?? null,
    city: user?.profile?.city ?? null,
    /** Normalized digits with country code, e.g. "919876543210". */
    phone: user?.phone?.normalized ?? null,
    email: user?.profile?.email ?? null,
  },
  profile: {
    profilePicture: toImageRef(doc.profile?.profilePicture),
    coverPicture: toImageRef(doc.profile?.coverPicture),
    level: doc.profile?.level ?? null,
    specialization: doc.profile?.specialization ?? null,
    description: doc.profile?.description ?? null,
    languages: Array.isArray(doc.profile?.languages) ? doc.profile.languages : [],
    facebook: doc.profile?.facebook ?? null,
    instagram: doc.profile?.instagram ?? null,
    linkedin: doc.profile?.linkedin ?? null,
    transformations: doc.profile?.transformations ?? 0,
    availableSlots: availability?.availableSlots ?? 0,
    slotStatus: availability?.slotStatus ?? null,
    clientsCoachedCount,
  },
});

/**
 * Lifetime distinct clients per coach, keyed by coach id, in one query. A coach
 * with none has no entry. Derived from the enrollments, like the monthly slots,
 * so there is no counter to drift and repeat or concurrent purchases by one
 * client cannot inflate it.
 *
 * A client counts when they have a non-deleted enrollment with a successful
 * payment. A cart item or a failed purchase never produces such a row. This is
 * independent of the slot count in coach-capacity.service.js, which has its own
 * rule and resets by month.
 */
export const countClientsCoached = async (coachIds) => {
  const rows = await EnrolledClient.aggregate([
    { $match: { coachId: { $in: coachIds }, isDeleted: { $ne: true }, 'payment.status': 'Success' } },
    { $group: { _id: { coachId: '$coachId', userId: '$userId' } } },
    { $group: { _id: '$_id.coachId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count]));
};

const MEMBER_USER_PROJECTION = {
  'profile.name': 1,
  'profile.gender': 1,
  'profile.city': 1,
  'profile.email': 1,
  'phone.normalized': 1,
};

/**
 * Visibility rule, enforced here rather than in the app: a coach is listed only
 * while the coach profile is active AND the underlying account is active. A
 * blocked or deactivated account must not keep advertising itself as a coach.
 */
const visibleCoachFilter = async (search) => {
  const filter = { status: 'active' };

  // Search covers what a member can see on a card: the coach's name and city,
  // and the coach's specialization and languages.
  const term = String(search ?? '').trim();
  if (term !== '') {
    const rx = new RegExp(escapeRegex(term), 'i');
    const matchingUserIds = await User.find(
      { status: 'active', $or: [{ 'profile.name': rx }, { 'profile.city': rx }] },
      { _id: 1 },
    ).distinct('_id');
    filter.$or = [
      { userId: { $in: matchingUserIds } },
      { 'profile.specialization': rx },
      { 'profile.languages': rx },
    ];
  }

  filter.userId = { $in: await User.find({ status: 'active' }, { _id: 1 }).distinct('_id') };
  return filter;
};

export const listCoachesForMember = async (params = {}) => {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);

  const filter = await visibleCoachFilter(params.search);

  const [docs, total] = await Promise.all([
    Coach.find(filter)
      .sort({ createdAt: -1, _id: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Coach.countDocuments(filter),
  ]);

  const users = await User.find({ _id: { $in: docs.map((d) => d.userId) } }, MEMBER_USER_PROJECTION).lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const [availability, clientsCoached] = await Promise.all([
    memberAvailability(docs),
    countClientsCoached(docs.map((doc) => doc._id)),
  ]);

  return {
    rows: docs.map((doc) => {
      const id = String(doc._id);
      return toMemberCoach(doc, byId.get(String(doc.userId)), availability.get(id), clientsCoached.get(id) ?? 0);
    }),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

/** One visible coach, or null - inactive and unknown coaches are indistinguishable. */
/**
 * The coach record belonging to [userId] - what a signed-in coach sees of
 * themselves in the Coach Workspace.
 *
 * Resolved from the account, never from a request parameter, so a coach can
 * only ever read their own record here. The coach's own professional photo
 * lives on this document; the account avatar is a different picture and is
 * never substituted for it.
 */
export const getCoachForUser = async (userId) => {
  if (!mongoose.isValidObjectId(userId)) return null;

  const doc = await Coach.findOne({ userId }).lean();
  if (!doc) return null;

  const user = await User.findOne({ _id: doc.userId }, MEMBER_USER_PROJECTION).lean();
  return user ? toMemberCoach(doc, user) : null;
};

export const getCoachForMember = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const doc = await Coach.findOne({ _id: id, status: 'active' }).lean();
  if (!doc) return null;

  const user = await User.findOne({ _id: doc.userId, status: 'active' }, MEMBER_USER_PROJECTION).lean();
  if (!user) return null;
  const key = String(doc._id);
  const [availability, clientsCoached] = await Promise.all([memberAvailability([doc]), countClientsCoached([doc._id])]);
  return toMemberCoach(doc, user, availability.get(key), clientsCoached.get(key) ?? 0);
};
