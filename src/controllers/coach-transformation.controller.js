import { listCoachTransformations, submitCoachTransformation } from '../services/coach-transformation.service.js';

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/coach/clients/:userId/transformations?title=... - the body is the
 * raw image, as every image upload here takes it. The coach is the token's.
 */
export const postCoachTransformation = handle(async (req, res) => {
  const transformation = await submitCoachTransformation(req.user._id, req.params.userId, {
    title: req.query.title,
    buffer: req.body,
  });
  res.status(201).json({ success: true, message: 'Transformation submitted', data: { transformation } });
});

/** GET /api/admin/transformations?page&pageSize - newest first. */
export const getAdminTransformations = handle(async (req, res) => {
  const data = await listCoachTransformations({ page: req.query.page, pageSize: req.query.pageSize });
  res.status(200).json({ success: true, data });
});
