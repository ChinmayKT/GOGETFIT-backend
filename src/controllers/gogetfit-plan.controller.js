import { archivePlan, createPlan, getPlanById, listPlans, updatePlan } from '../services/gogetfit-plan.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { validateCreatePlan, validatePlanListQuery, validateUpdatePlan } from '../validators/gogetfit-plan.validator.js';

const planNotFound = () => notFound(ERROR_CODES.GOGETFIT_PLAN_NOT_FOUND, 'GoGetFit plan not found');

/** GET /api/admin/gogetfit-plans */
export const getGogetfitPlans = async (req, res, next) => {
  try {
    const result = await listPlans(validatePlanListQuery(req.query));
    res.status(200).json({
      success: true,
      data: {
        plans: result.rows,
        pagination: { page: result.page, pageSize: result.pageSize, total: result.total, totalPages: result.totalPages },
      },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/gogetfit-plans/:id */
export const getGogetfitPlan = async (req, res, next) => {
  try {
    const plan = await getPlanById(req.params.id);
    if (!plan) throw planNotFound();
    res.status(200).json({ success: true, data: { plan } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/gogetfit-plans */
export const postGogetfitPlan = async (req, res, next) => {
  try {
    const plan = await createPlan(validateCreatePlan(req.body), req.user._id);
    res.status(201).json({ success: true, message: 'GoGetFit plan created', data: { plan } });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/admin/gogetfit-plans/:id - also restores an archived plan ({ status: "active" }). */
export const patchGogetfitPlan = async (req, res, next) => {
  try {
    const plan = await updatePlan(req.params.id, validateUpdatePlan(req.body), req.user._id);
    if (!plan) throw planNotFound();
    res.status(200).json({ success: true, message: 'GoGetFit plan updated', data: { plan } });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/admin/gogetfit-plans/:id - archives (soft delete); see the service. */
export const deleteGogetfitPlan = async (req, res, next) => {
  try {
    const plan = await archivePlan(req.params.id, req.user._id);
    if (!plan) throw planNotFound();
    res.status(200).json({ success: true, message: 'GoGetFit plan deleted', data: { plan } });
  } catch (error) {
    next(error);
  }
};
