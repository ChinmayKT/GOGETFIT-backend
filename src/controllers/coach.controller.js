import {
  createCoach,
  findUserByPhone,
  getCoachById,
  listCoaches,
  updateCoach,
} from '../services/coach.service.js';
import { removeCoachImage, setCoachImage } from '../services/coach-image.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import {
  validateCoachListQuery,
  validateCreateCoach,
  validateUpdateCoach,
  validateUserPhoneSearch,
} from '../validators/coach.validator.js';

const coachNotFound = () => notFound(ERROR_CODES.COACH_NOT_FOUND, 'Coach not found');

/** GET /api/admin/users/search?phone= - Add Coach step 1. */
export const searchUserByPhone = async (req, res, next) => {
  try {
    const { phone } = validateUserPhoneSearch(req.query);
    const result = await findUserByPhone(phone);

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/coaches - paginated, searchable, filterable list. */
export const getCoaches = async (req, res, next) => {
  try {
    const params = validateCoachListQuery(req.query);
    const result = await listCoaches(params);

    res.status(200).json({
      success: true,
      data: {
        coaches: result.rows,
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

/** GET /api/admin/coaches/:id */
export const getCoach = async (req, res, next) => {
  try {
    const coach = await getCoachById(req.params.id);
    if (!coach) throw coachNotFound();

    res.status(200).json({ success: true, data: { coach } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/coaches - creates the profile and grants the "coach" role. */
export const postCoach = async (req, res, next) => {
  try {
    const input = validateCreateCoach(req.body);
    // Audit fields come from the authenticated admin loaded by requireAuth.
    const coach = await createCoach(input, req.user._id);

    res.status(201).json({ success: true, message: 'Coach created', data: { coach } });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/admin/coaches/:id
 *
 * Also the deactivate path ({ status: "inactive" }). Coaches are never hard
 * deleted, so there is no DELETE endpoint.
 */
export const patchCoach = async (req, res, next) => {
  try {
    const patch = validateUpdateCoach(req.body);
    const coach = await updateCoach(req.params.id, patch, req.user._id);
    if (!coach) throw coachNotFound();

    res.status(200).json({ success: true, message: 'Coach updated', data: { coach } });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/admin/coaches/:id/profile-picture and /cover-picture.
 * The body is the raw image, exactly as the member avatar upload takes it.
 */
export const putCoachImage = (slot) => async (req, res, next) => {
  try {
    const coach = await setCoachImage(req.params.id, slot, req.body, req.user._id);
    if (!coach) throw coachNotFound();

    res.status(200).json({ success: true, message: 'Coach picture updated', data: { coach } });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/admin/coaches/:id/profile-picture and /cover-picture. */
export const deleteCoachImage = (slot) => async (req, res, next) => {
  try {
    const coach = await removeCoachImage(req.params.id, slot, req.user._id);
    if (!coach) throw coachNotFound();

    res.status(200).json({ success: true, message: 'Coach picture removed', data: { coach } });
  } catch (error) {
    next(error);
  }
};
