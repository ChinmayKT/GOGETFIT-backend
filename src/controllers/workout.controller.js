import {
  archiveWorkout,
  createWorkout,
  getWorkoutById,
  listWorkouts,
  restoreWorkout,
  updateWorkout,
} from '../services/workout.service.js';
import { removeWorkoutMedia, setWorkoutMedia } from '../services/workout-media.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import {
  validateCreateWorkout,
  validateUpdateWorkout,
  validateWorkoutListQuery,
} from '../validators/workout.validator.js';

const workoutNotFound = () => notFound(ERROR_CODES.WORKOUT_NOT_FOUND, 'Workout not found');

/** GET /api/admin/workouts - paginated, searched, filtered and sorted in MongoDB. */
export const getWorkouts = async (req, res, next) => {
  try {
    const result = await listWorkouts(validateWorkoutListQuery(req.query));
    res.status(200).json({
      success: true,
      data: {
        workouts: result.rows,
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

/** GET /api/admin/workouts/:id - a malformed id is a 404, not a cast error. */
export const getWorkout = async (req, res, next) => {
  try {
    const workout = await getWorkoutById(req.params.id);
    if (!workout) throw workoutNotFound();
    res.status(200).json({ success: true, data: { workout } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/workouts */
export const postWorkout = async (req, res, next) => {
  try {
    const workout = await createWorkout(validateCreateWorkout(req.body), req.user._id);
    res.status(201).json({ success: true, message: 'Workout created', data: { workout } });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT / PATCH /api/admin/workouts/:id
 *
 * Both verbs apply the same partial update: only the fields in the body change,
 * which is what keeps a migrated workout's legacy block and its media intact
 * through a text-only edit. Also restores an archived workout ({ status: "active" }).
 */
export const putWorkout = async (req, res, next) => {
  try {
    const workout = await updateWorkout(req.params.id, validateUpdateWorkout(req.body), req.user._id);
    if (!workout) throw workoutNotFound();
    res.status(200).json({ success: true, message: 'Workout updated', data: { workout } });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/admin/workouts/:id - archives (soft delete); the document is never removed. */
export const deleteWorkout = async (req, res, next) => {
  try {
    const workout = await archiveWorkout(req.params.id, req.user._id);
    if (!workout) throw workoutNotFound();
    res.status(200).json({ success: true, message: 'Workout archived', data: { workout } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/workouts/:id/restore */
export const postWorkoutRestore = async (req, res, next) => {
  try {
    const workout = await restoreWorkout(req.params.id, req.user._id);
    if (!workout) throw workoutNotFound();
    res.status(200).json({ success: true, message: 'Workout restored', data: { workout } });
  } catch (error) {
    next(error);
  }
};

/** PUT /api/admin/workouts/:id/{video,thumbnail} - the raw bytes as the body. */
export const putWorkoutMedia = (slot) => async (req, res, next) => {
  try {
    const workout = await setWorkoutMedia(slot, req.params.id, req.body, req.user._id);
    if (!workout) throw workoutNotFound();
    res.status(200).json({ success: true, message: `Workout ${slot} updated`, data: { workout } });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/admin/workouts/:id/{video,thumbnail} */
export const deleteWorkoutMedia = (slot) => async (req, res, next) => {
  try {
    const workout = await removeWorkoutMedia(slot, req.params.id, req.user._id);
    if (!workout) throw workoutNotFound();
    res.status(200).json({ success: true, message: `Workout ${slot} removed`, data: { workout } });
  } catch (error) {
    next(error);
  }
};
