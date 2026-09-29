import { getCoachForMember, listCoachesForMember } from '../services/coach.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { validateMemberCoachListQuery } from '../validators/coach.validator.js';

/**
 * GET /api/coaches - coach discovery for the app. Authenticated, no role.
 * Only visible (active) coaches, in the member-safe shape; paginated.
 */
export const getCoachesForMember = async (req, res, next) => {
  try {
    const params = validateMemberCoachListQuery(req.query);
    const result = await listCoachesForMember(params);

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

/** GET /api/coaches/:id - one visible coach. Inactive coaches are a 404. */
export const getCoachByIdForMember = async (req, res, next) => {
  try {
    const coach = await getCoachForMember(req.params.id);
    if (!coach) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'Coach not found');

    res.status(200).json({ success: true, data: { coach } });
  } catch (error) {
    next(error);
  }
};
