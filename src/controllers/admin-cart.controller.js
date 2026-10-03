import { listCartItems, SORT_KEYS } from '../services/admin-cart.service.js';
import { ERROR_CODES, badRequest } from '../utils/errors.js';

/**
 * GET /api/admin/cart-items - the "In cart" sales follow-up list.
 *
 * Active cart items only. A purchased item leaves this list on its own, because
 * the purchase flips its status inside the same transaction that creates the
 * enrollment.
 */

const fail = (message) => {
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, message);
};

const validateQuery = (query = {}) => {
  const out = {};

  if (query.page !== undefined) {
    const page = Number.parseInt(query.page, 10);
    if (Number.isNaN(page) || page < 1) fail('page must be a positive integer');
    out.page = page;
  }
  const rawPageSize = query.pageSize ?? query.limit;
  if (rawPageSize !== undefined) {
    const pageSize = Number.parseInt(rawPageSize, 10);
    if (Number.isNaN(pageSize) || pageSize < 1) fail('pageSize must be a positive integer');
    out.pageSize = pageSize;
  }

  if (query.search !== undefined) out.search = String(query.search);
  if (query.coachId !== undefined && query.coachId !== '') out.coachId = String(query.coachId);
  if (query.planId !== undefined && query.planId !== '') out.planId = String(query.planId);

  for (const key of ['addedFrom', 'addedTo']) {
    if (query[key] !== undefined && query[key] !== '') {
      const date = new Date(query[key]);
      if (Number.isNaN(date.getTime())) fail(`${key} must be a date`);
      out[key] = date;
    }
  }

  const rawSortKey = query.sortKey ?? query.sortBy;
  if (rawSortKey !== undefined && rawSortKey !== '') {
    if (!SORT_KEYS.includes(rawSortKey)) fail(`sortKey must be one of: ${SORT_KEYS.join(', ')}`);
    out.sortKey = rawSortKey;
  }
  const rawSortDir = query.sortDir ?? query.sortOrder;
  if (rawSortDir !== undefined) out.sortDir = rawSortDir === 'asc' ? 'asc' : 'desc';

  return out;
};

export const getAdminCartItems = async (req, res, next) => {
  try {
    const result = await listCartItems(validateQuery(req.query));
    res.status(200).json({
      success: true,
      data: {
        cartItems: result.rows,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages: result.totalPages,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
