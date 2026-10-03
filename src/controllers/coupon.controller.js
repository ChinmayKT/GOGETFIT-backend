import { createCoupon, getCouponById, listCoupons, updateCoupon } from '../services/coupon.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { validateCouponListQuery, validateCreateCoupon, validateUpdateCoupon } from '../validators/coupon.validator.js';

const couponNotFound = () => notFound(ERROR_CODES.COUPON_NOT_FOUND, 'Coupon not found');

/** GET /api/admin/coupons */
export const getCoupons = async (req, res, next) => {
  try {
    const result = await listCoupons(validateCouponListQuery(req.query));
    res.status(200).json({
      success: true,
      data: {
        coupons: result.rows,
        pagination: { page: result.page, pageSize: result.pageSize, total: result.total, totalPages: result.totalPages },
      },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/coupons/:id */
export const getCoupon = async (req, res, next) => {
  try {
    const coupon = await getCouponById(req.params.id);
    if (!coupon) throw couponNotFound();
    res.status(200).json({ success: true, data: { coupon } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/coupons - createdBy/updatedBy come from the authenticated admin. */
export const postCoupon = async (req, res, next) => {
  try {
    const coupon = await createCoupon(validateCreateCoupon(req.body), req.user._id);
    res.status(201).json({ success: true, message: 'Coupon created', data: { coupon } });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/admin/coupons/:id */
export const patchCoupon = async (req, res, next) => {
  try {
    const coupon = await updateCoupon(req.params.id, validateUpdateCoupon(req.body), req.user._id);
    if (!coupon) throw couponNotFound();
    res.status(200).json({ success: true, message: 'Coupon updated', data: { coupon } });
  } catch (error) {
    next(error);
  }
};
