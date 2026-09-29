import {
  createPlan,
  deletePlan,
  getPlanById,
  listPlans,
  updatePlan,
} from '../services/free-diet-plan.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import {
  validateCreatePlan,
  validatePlanListQuery,
  validateUpdatePlan,
} from '../validators/free-diet-plan.validator.js';

const planNotFound = () => notFound(ERROR_CODES.PLAN_NOT_FOUND, 'Free diet plan not found');

/** GET /api/admin/free-diet-plans - paginated, filterable, sortable list. */
export const getFreeDietPlans = async (req, res, next) => {
  try {
    const params = validatePlanListQuery(req.query);
    const result = await listPlans(params);

    res.status(200).json({
      success: true,
      data: {
        plans: result.rows,
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

/** GET /api/admin/free-diet-plans/:id */
export const getFreeDietPlan = async (req, res, next) => {
  try {
    const plan = await getPlanById(req.params.id);
    if (!plan) throw planNotFound();

    res.status(200).json({ success: true, data: { plan } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/free-diet-plans */
export const postFreeDietPlan = async (req, res, next) => {
  try {
    const input = validateCreatePlan(req.body);
    // req.user is the MongoDB document loaded by requireAuth, so the audit trail
    // records the real administrator rather than anything the browser claimed.
    const plan = await createPlan(input, req.user._id);

    res.status(201).json({ success: true, message: 'Free diet plan created', data: { plan } });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/admin/free-diet-plans/:id */
export const patchFreeDietPlan = async (req, res, next) => {
  try {
    const patch = validateUpdatePlan(req.body);
    const plan = await updatePlan(req.params.id, patch, req.user._id);
    if (!plan) throw planNotFound();

    res.status(200).json({ success: true, message: 'Free diet plan updated', data: { plan } });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/admin/free-diet-plans/:id
 *
 * Archives the template rather than removing the document - see the note on
 * deletePlan in the service for why.
 */
export const deleteFreeDietPlan = async (req, res, next) => {
  try {
    const plan = await deletePlan(req.params.id, req.user._id);
    if (!plan) throw planNotFound();

    res.status(200).json({ success: true, message: 'Free diet plan deleted', data: { plan } });
  } catch (error) {
    next(error);
  }
};
