import { getCoachForMember, listCoachesForMember } from '../services/coach.service.js';
import { listActivePlansForLevel } from '../services/gogetfit-plan.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { validateCoachPlansQuery, validateMemberCoachListQuery } from '../validators/coach.validator.js';

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

/**
 * GET /api/coaches/:id/plans - the GoGetFit Plans this coach offers.
 *
 * Eligibility is derived, not stored: a coach offers every active plan whose
 * level equals the coach's level. The coach is resolved with the same
 * visibility rule as the profile (active coach, active account), so an
 * inactive coach's plans are a 404 like the coach itself. The level is read
 * from that coach document - never from the request.
 */
export const getCoachPlansForMember = async (req, res, next) => {
  try {
    const params = validateCoachPlansQuery(req.query);
    const coach = await getCoachForMember(req.params.id);
    if (!coach) throw notFound(ERROR_CODES.COACH_NOT_FOUND, 'Coach not found');

    const result = await listActivePlansForLevel(coach.profile.level, params);

    res.status(200).json({
      success: true,
      data: {
        coach: { id: coach.id, name: coach.user.name, level: coach.profile.level },
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
