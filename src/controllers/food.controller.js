import { archiveFood, createFood, getFoodById, listFoods, updateFood } from '../services/food.service.js';
import { removeFoodImage, setFoodImage } from '../services/food-image.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { validateCreateFood, validateFoodListQuery, validateUpdateFood } from '../validators/food.validator.js';

const foodNotFound = () => notFound(ERROR_CODES.FOOD_NOT_FOUND, 'Food not found');

/** GET /api/admin/foods - paginated, searched, filtered and sorted in MongoDB. */
export const getFoods = async (req, res, next) => {
  try {
    const result = await listFoods(validateFoodListQuery(req.query));
    res.status(200).json({
      success: true,
      data: {
        foods: result.rows,
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

/** GET /api/admin/foods/:id - a malformed id is a 404, not a cast error. */
export const getFood = async (req, res, next) => {
  try {
    const food = await getFoodById(req.params.id);
    if (!food) throw foodNotFound();
    res.status(200).json({ success: true, data: { food } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/foods */
export const postFood = async (req, res, next) => {
  try {
    const food = await createFood(validateCreateFood(req.body), req.user._id);
    res.status(201).json({ success: true, message: 'Food created', data: { food } });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT / PATCH /api/admin/foods/:id
 *
 * Both verbs apply the same partial update: only the fields in the body change,
 * which is what keeps a migrated food's legacy block intact through an edit.
 * Also restores an archived food ({ status: "active" }).
 */
export const putFood = async (req, res, next) => {
  try {
    const food = await updateFood(req.params.id, validateUpdateFood(req.body), req.user._id);
    if (!food) throw foodNotFound();
    res.status(200).json({ success: true, message: 'Food updated', data: { food } });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/admin/foods/:id - archives (soft delete); the document is never removed. */
export const deleteFood = async (req, res, next) => {
  try {
    const food = await archiveFood(req.params.id, req.user._id);
    if (!food) throw foodNotFound();
    res.status(200).json({ success: true, message: 'Food archived', data: { food } });
  } catch (error) {
    next(error);
  }
};

/** PUT /api/admin/foods/:id/image - the raw image bytes as the body. */
export const putFoodImage = async (req, res, next) => {
  try {
    const food = await setFoodImage(req.params.id, req.body, req.user._id);
    if (!food) throw foodNotFound();
    res.status(200).json({ success: true, message: 'Food image updated', data: { food } });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/admin/foods/:id/image */
export const deleteFoodImage = async (req, res, next) => {
  try {
    const food = await removeFoodImage(req.params.id, req.user._id);
    if (!food) throw foodNotFound();
    res.status(200).json({ success: true, message: 'Food image removed', data: { food } });
  } catch (error) {
    next(error);
  }
};
