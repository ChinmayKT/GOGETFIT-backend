import { query } from '../config/mariadb.js';

/**
 * Read-only extraction of the coach-assigned diet plans:
 * m_diet_plan + r_diet_plan_meal + r_diet_plan_dates (+ m_food, m_user, m_coach
 * for references). Every statement is a SELECT through the read-only pool.
 *
 * Also holds the two legacy runtime queries, verbatim, so the dry run can ask
 * the legacy database what a member would have seen.
 */

/** A read retried on a dropped connection - safe, because every statement here is a SELECT. */
export const read = async (sql, params = [], attempts = 4) => {
  for (let i = 1; ; i += 1) {
    try {
      return await query(sql, params);
    } catch (error) {
      if (i >= attempts || !/ETIMEDOUT|ECONNRESET|PROTOCOL_CONNECTION_LOST|closed/i.test(`${error.code} ${error.message}`)) {
        throw error;
      }
    }
  }
};

/** Every plan header, by id. */
export const extractDietPlans = () => read('SELECT * FROM m_diet_plan ORDER BY diet_plan_id ASC');

/**
 * Every meal row the legacy member screen can show: the same inner joins as
 * DietDAL.GetDietPlanMeals (m_meal, m_food) and the same 1..8 meal loop as
 * DietService.GetDietPlanMeals. Ordered by the legacy (meal_id, food_id), then
 * by row create_date and quantity - the legacy order has no tie-break for the
 * same food twice in a meal, so a deterministic one is added.
 *
 * The food master's unit and CAST(qty AS INT) come along: the legacy screen
 * divides by that CAST, so it is the snapshot `portion`.
 */
export const extractVisibleMealRows = () =>
  read(`SELECT a.diet_plan_id, a.meal_id, a.food_id, a.quantity, a.calories, a.fats, a.carbs, a.proteins,
               a.create_date, CAST(c.qty AS INT) AS originalqty, c.unit, c.qty AS raw_qty
          FROM r_diet_plan_meal a
          INNER JOIN m_meal b ON a.meal_id = b.meal_id
          INNER JOIN m_food c ON a.food_id = c.food_id
         WHERE a.meal_id BETWEEN 1 AND 8
         ORDER BY a.diet_plan_id, a.meal_id, a.food_id, a.create_date, a.quantity`);

/** Meal rows the legacy screen can never show, for the report. */
export const extractHiddenMealRows = () =>
  read(`SELECT a.diet_plan_id, a.meal_id, a.food_id,
               (b.meal_id IS NULL) AS no_meal, (c.food_id IS NULL) AS no_food, (p.diet_plan_id IS NULL) AS no_plan
          FROM r_diet_plan_meal a
          LEFT JOIN m_meal b ON a.meal_id = b.meal_id
          LEFT JOIN m_food c ON a.food_id = c.food_id
          LEFT JOIN m_diet_plan p ON a.diet_plan_id = p.diet_plan_id
         WHERE b.meal_id IS NULL OR c.food_id IS NULL OR p.diet_plan_id IS NULL OR a.meal_id NOT BETWEEN 1 AND 8
         ORDER BY a.diet_plan_id, a.meal_id, a.food_id`);

/** Every assigned day, as yyyy-mm-dd (all legacy diet_date values are midnight). */
export const extractDietPlanDates = () =>
  read(`SELECT diet_plan_id, DATE_FORMAT(diet_date, '%Y-%m-%d') AS day, TIME(diet_date) AS time
          FROM r_diet_plan_dates ORDER BY diet_plan_id, diet_date`);

/** The m_user rows behind plan owners and creators, for existence and email checks. */
export const extractLegacyUsers = (userIds) =>
  userIds.length
    ? read('SELECT user_id, first_name, email_id, user_type FROM m_user WHERE user_id IN (?)', [userIds])
    : Promise.resolve([]);

export const extractLegacyCoaches = () => read('SELECT coach_id, first_name, last_name, email FROM m_coach ORDER BY coach_id');

/** api/ggf.Data/WorkoutDAL.cs:162 GetDietPlanDetails, userId branch, verbatim. */
export const legacySelectSql = (userId, date) => `select
    a.diet_plan_id
    , a.diet_plan_name
    , b.diet_date
    , a.total_calories
    , a.fat
    , a.carbs
    , a.protein


from
    m_diet_plan a inner join r_diet_plan_dates b
        on a.diet_plan_id = b.diet_plan_id
where
    a.diet_plan_id in (
        select
            c.diet_plan_id
        from
            m_diet_plan c
        where  c.user_id = '${Number(userId)}' order by c.create_date desc )  and b.diet_date = STR_TO_DATE('${date}', '%d-%m-%Y %H:%i:%s') order by a.create_date desc limit 1`;

/** api/ggf.Data/DietDAL.cs:376 GetDietPlanMeals, verbatim. */
export const legacyMealsSql = (planId, mealId) => `select

     a.food_id
    , c.food_name
    , c.brand_name
    , a.quantity
    , CAST(c.qty as INT) as originalqty
    , c.unit
    , c.image_file_name
    , a.calories
    , a.fats
    , a.carbs
    , a.proteins
from
    r_diet_plan_meal a
    inner join m_meal b
        on a.meal_id = b.meal_id

    inner join m_food c
        on a.food_id = c.food_id
        where diet_plan_id = '${Number(planId)}' and a.meal_id ='${Number(mealId)}' order by a.meal_id, a.food_id`;

/** The date string the legacy Flutter app sends: day-month-year, unpadded, no time (view_plans.dart). */
export const legacyAppDate = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return `${d}-${m}-${y}`;
};
