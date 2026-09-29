import { ROLES } from '../constants/roles.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

export const validateAdminLogin = (body = {}) => {
  if (typeof body.email !== 'string' || body.email.trim() === '') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'email is required');
  }
  if (typeof body.password !== 'string' || body.password === '') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'password is required');
  }
  // No length/format rule on the way in: rejecting a short password here would
  // only tell an attacker their guess was the wrong shape. Verification decides.
  return { email: body.email.trim(), password: body.password };
};

const STATUSES = ['active', 'inactive', 'blocked'];

export const validateUserListQuery = (query = {}) => {
  const out = {};

  if (query.page !== undefined) {
    const page = Number.parseInt(query.page, 10);
    if (Number.isNaN(page) || page < 1) {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'page must be a positive integer');
    }
    out.page = page;
  }

  if (query.pageSize !== undefined) {
    const pageSize = Number.parseInt(query.pageSize, 10);
    if (Number.isNaN(pageSize) || pageSize < 1) {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'pageSize must be a positive integer');
    }
    // Not an error when too large - the service clamps it to MAX_PAGE_SIZE.
    out.pageSize = pageSize;
  }

  if (query.role !== undefined && query.role !== '') {
    if (!ROLES.includes(query.role)) {
      throw badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        `role must be one of: ${ROLES.join(', ')}`,
      );
    }
    out.role = query.role;
  }

  if (query.status !== undefined && query.status !== '') {
    if (!STATUSES.includes(query.status)) {
      throw badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        `status must be one of: ${STATUSES.join(', ')}`,
      );
    }
    out.status = query.status;
  }

  if (query.search !== undefined) out.search = String(query.search);
  if (query.sortKey !== undefined) out.sortKey = String(query.sortKey);
  if (query.sortDir !== undefined) out.sortDir = query.sortDir === 'asc' ? 'asc' : 'desc';

  return out;
};
