import {
  createManualEnrollment,
  getEnrolledClientById,
  listEnrolledClients,
} from '../services/enrolled-client.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { validateEnrolledClientListQuery, validateManualEnrollment } from '../validators/enrolled-client.validator.js';

/** GET /api/admin/enrolled-clients - paginated, filterable, sortable. */
export const getEnrolledClients = async (req, res, next) => {
  try {
    const params = validateEnrolledClientListQuery(req.query);
    const result = await listEnrolledClients(params);

    res.status(200).json({
      success: true,
      data: {
        enrolledClients: result.rows,
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

/** GET /api/admin/enrolled-clients/:id */
export const getEnrolledClient = async (req, res, next) => {
  try {
    const enrolledClient = await getEnrolledClientById(req.params.id);
    if (!enrolledClient) {
      throw notFound(ERROR_CODES.ENROLLED_CLIENT_NOT_FOUND, 'Enrolled client not found');
    }

    res.status(200).json({ success: true, data: { enrolledClient } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/enrolled-clients - an admin enrolls an existing user (Add Client).
 * createdBy is always the authenticated admin, never a value from the body.
 */
export const postEnrolledClient = async (req, res, next) => {
  try {
    const input = validateManualEnrollment(req.body);
    const result = await createManualEnrollment(input, req.user._id);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
