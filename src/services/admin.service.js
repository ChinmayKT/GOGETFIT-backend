import mongoose from 'mongoose';

import User from '../models/user.model.js';
import { ROLES } from '../constants/roles.js';
import { calculateAge } from '../utils/age.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Allow-listed projection for the Admin Portal.
 *
 * Built as an explicit allow-list, not by deleting fields from the document: a
 * field added to the schema later is invisible here until someone deliberately
 * exposes it. That is what keeps `auth.passwordHash`, OTP material and every
 * future secret out of the response by construction rather than by vigilance.
 *
 * OTPs are not in this collection at all - they live in `otps` and are hashed -
 * so there is nothing to strip for them here.
 */
export const toAdminUser = (user, age) => ({
  id: String(user._id),
  phone: {
    raw: user.phone?.raw ?? null,
    normalized: user.phone?.normalized ?? null,
  },
  profile: {
    name: user.profile?.name ?? null,
    email: user.profile?.email ?? null,
    isEmailVerified: user.profile?.isEmailVerified ?? false,
    dateOfBirth: user.profile?.dateOfBirth
      ? user.profile.dateOfBirth.toISOString().slice(0, 10)
      : null,
    age: age === undefined ? (user.profile?.age ?? null) : age,
    gender: user.profile?.gender ?? null,
    city: user.profile?.city ?? null,
    profilePicture: user.profile?.profilePicture ?? null,
    // The member's current Free Diet Plan template, as an id only - the
    // template itself is fetched separately and never copied onto the user.
    freeDietPlanId: user.profile?.freeDietPlanId
      ? String(user.profile.freeDietPlanId)
      : null,
    fitnessProfile: {
      height: user.profile?.fitnessProfile?.height ?? null,
      weight: user.profile?.fitnessProfile?.weight ?? null,
      bodyFatPercentage: user.profile?.fitnessProfile?.bodyFatPercentage ?? null,
      activityLevel: user.profile?.fitnessProfile?.activityLevel ?? null,
      foodType: user.profile?.fitnessProfile?.foodType ?? null,
      goal: user.profile?.fitnessProfile?.goal ?? null,
      bmr: user.profile?.fitnessProfile?.bmr ?? null,
      tdee: user.profile?.fitnessProfile?.tdee ?? null,
    },
  },
  profileCompleted: Boolean(user.profileCompleted),
  roles: Array.isArray(user.roles) ? user.roles : [],
  status: user.status ?? null,
  // Migration/debug aid: which legacy MariaDB row this account came from, if any.
  legacy: user.legacy?.userId != null
    ? { source: user.legacy.source ?? null, userId: user.legacy.userId }
    : null,
  createdAt: user.createdAt ? user.createdAt.toISOString() : null,
  updatedAt: user.updatedAt ? user.updatedAt.toISOString() : null,
});

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sort keys the portal may request. An arbitrary client string is never passed
 * to Mongo as a sort field.
 */
const SORTABLE = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  name: 'profile.name',
  email: 'profile.email',
  status: 'status',
};

export const buildUserFilter = ({ search, role, status } = {}) => {
  const filter = {};

  if (status) filter.status = status;
  // Unknown role values are ignored rather than returning everything.
  if (role && ROLES.includes(role)) filter.roles = role;

  const term = String(search ?? '').trim();
  if (term !== '') {
    const rx = new RegExp(escapeRegex(term), 'i');
    filter.$or = [
      { 'profile.name': rx },
      { 'profile.email': rx },
      { 'phone.normalized': rx },
      { 'phone.raw': rx },
      { 'profile.city': rx },
    ];
  }

  return filter;
};

/**
 * One page of users. Always paginated and always capped - the portal can never
 * ask the server to stream the whole collection into a browser.
 */
export const listUsers = async (params = {}) => {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);

  const sortField = SORTABLE[params.sortKey] ?? SORTABLE.createdAt;
  const sortDir = params.sortDir === 'asc' ? 1 : -1;

  const filter = buildUserFilter(params);

  const [docs, total] = await Promise.all([
    User.find(filter)
      .sort({ [sortField]: sortDir })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean({ getters: false }),
    User.countDocuments(filter),
  ]);

  return {
    rows: docs.map((doc) =>
      // lean() gives plain objects, so age is recomputed in memory here rather
      // than written back: a list read must not mutate 435 documents.
      toAdminUser(doc, calculateAge(doc.profile?.dateOfBirth)),
    ),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

export const getUserById = async (id) => {
  // A malformed id is "no such user", not a server error: findById would
  // otherwise raise a CastError and surface as a 500.
  if (!mongoose.isValidObjectId(id)) return null;

  const doc = await User.findById(id).lean({ getters: false });
  if (!doc) return null;
  return toAdminUser(doc, calculateAge(doc.profile?.dateOfBirth));
};
