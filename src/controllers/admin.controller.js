import { loginWithPassword } from '../services/admin-auth.service.js';
import { createUserByAdmin, getUserById, listUsers, toAdminUser, updateUserByAdmin } from '../services/admin.service.js';
import { refreshAge } from '../services/user.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { validateAdminLogin, validateCreateUser, validateUpdateUser, validateUserListQuery } from '../validators/admin.validator.js';

/** POST /api/auth/admin/login - public, rate limited by the route. */
export const postAdminLogin = async (req, res, next) => {
  try {
    const { email, password } = validateAdminLogin(req.body);
    const result = await loginWithPassword(email, password);

    res.status(200).json({
      success: true,
      message: 'Logged in',
      data: { token: result.token, user: result.user },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/me - the authenticated administrator.
 * req.user was loaded from MongoDB by requireAuth, so this reflects the stored
 * roles and status, not anything the client claimed.
 */
export const getAdminMe = async (req, res, next) => {
  try {
    const age = await refreshAge(req.user);
    res.status(200).json({ success: true, data: { user: toAdminUser(req.user, age) } });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/users - paginated, filterable list. */
export const getAdminUsers = async (req, res, next) => {
  try {
    const params = validateUserListQuery(req.query);
    const result = await listUsers(params);

    res.status(200).json({
      success: true,
      data: {
        users: result.rows,
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

/** GET /api/admin/users/:id */
export const getAdminUserById = async (req, res, next) => {
  try {
    const user = await getUserById(req.params.id);
    if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');

    res.status(200).json({ success: true, data: { user } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/users - onboard a normal user (role "user" only). */
export const postAdminUser = async (req, res, next) => {
  try {
    const input = validateCreateUser(req.body);
    const result = await createUserByAdmin(input);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/admin/users/:id - edit a user's profile with the Add User form. */
export const patchAdminUser = async (req, res, next) => {
  try {
    const input = validateUpdateUser(req.body);
    const result = await updateUserByAdmin(req.params.id, input);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
