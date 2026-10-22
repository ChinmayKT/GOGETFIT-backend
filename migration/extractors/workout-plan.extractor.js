import { read } from './diet-plan.extractor.js';

/**
 * Read-only extraction of the coach-assigned workout plans:
 * m_workout_plan + r_workout_plan_category/m_workout_category +
 * r_workout_plan + r_workout_plan_dates. Every statement is a SELECT through
 * the read-only pool (migration/config/mariadb.js); `read` retries only on a
 * dropped connection.
 *
 * Also holds the legacy runtime queries (api/ggf.Data/WorkoutDAL.cs),
 * verbatim, so the dry run can ask the legacy database what a member saw.
 * See docs/workout-plans-migration-audit.md.
 */

export { read };

/** Every plan header, by id. Timestamps as IST wall-clock text (dateStrings). */
export const extractWorkoutPlans = () =>
  read(`SELECT workout_plan_id, workout_plan_name, user_id, created_by,
               DATE_FORMAT(create_date, '%Y-%m-%d %H:%i:%s') AS create_date,
               DATE_FORMAT(last_update_date, '%Y-%m-%d %H:%i:%s') AS last_update_date
          FROM m_workout_plan ORDER BY workout_plan_id ASC`);

/**
 * Every plan-block link the legacy read can show: the same inner join and
 * DISTINCT as GetWorkoutPlanCategories (WorkoutDAL.cs:671-681).
 */
export const extractPlanCategories = () =>
  read(`SELECT DISTINCT a.workout_plan_id, a.workout_category_id, b.workout_category_name
          FROM r_workout_plan_category a
          INNER JOIN m_workout_category b ON a.workout_category_id = b.workout_category_id
         ORDER BY a.workout_plan_id, a.workout_category_id`);

/** Links the legacy read can never show (category row gone), for the report. */
export const extractDanglingCategoryLinks = () =>
  read(`SELECT a.workout_plan_id, a.workout_category_id
          FROM r_workout_plan_category a
          LEFT JOIN m_workout_category b ON a.workout_category_id = b.workout_category_id
         WHERE b.workout_category_id IS NULL
         ORDER BY a.workout_plan_id, a.workout_category_id`);

/**
 * Every exercise row, whether or not the legacy read could show it - the
 * transformer reports a row whose block is not linked to its plan, and the
 * loader reports one whose m_workout is gone. `workout_exists` marks the
 * rows GetWorkoutPlanExercises (WorkoutDAL.cs:636-655) hides by inner join.
 */
export const extractPlanExercises = () =>
  read(`SELECT a.workout_plan_id, a.workout_category_id, a.workout_id, a.sets_count, a.reps_count,
               (b.workout_id IS NOT NULL) AS workout_exists
          FROM r_workout_plan a
          LEFT JOIN m_workout b ON a.workout_id = b.workout_id
         ORDER BY a.workout_plan_id, a.workout_category_id, a.workout_id`);

/** Every assigned day as yyyy-mm-dd, repeats and all (there is no PK), plus its time for the midnight check. */
export const extractWorkoutPlanDates = () =>
  read(`SELECT workout_plan_id, DATE_FORMAT(workout_date, '%Y-%m-%d') AS day, TIME(workout_date) AS time
          FROM r_workout_plan_dates ORDER BY workout_plan_id, workout_date`);

/** WorkoutDAL.cs:132-148 GetWorkoutPlanDetails, userId branch, verbatim. */
export const legacyWorkoutDaySql = (userId, date) => `select
    a.workout_plan_id
    , a.workout_plan_name
    , b.workout_date
from
    m_workout_plan a inner join r_workout_plan_dates b
        on a.workout_plan_id = b.workout_plan_id
where
    a.workout_plan_id in (
        select
            c.workout_plan_id
        from
            m_workout_plan c
        where c.user_id = '${Number(userId)}' order by c.create_date desc ) and b.workout_date = STR_TO_DATE('${date}', '%d-%m-%Y %H:%i:%s') order by a.create_date desc limit 1`;

/** WorkoutDAL.cs:671-681 GetWorkoutPlanCategories, verbatim. */
export const legacyCategoriesSql = (planId) => `select distinct

     a.workout_category_id as WorkoutCategoryId,
b.workout_category_name as WorkoutCategoryName

from
    r_workout_plan_category a
    inner join m_workout_category b
on a.workout_category_id = b.workout_category_id
        where a.workout_plan_id = '${Number(planId)}' order by b.workout_category_id`;

/** WorkoutDAL.cs:636-655 GetWorkoutPlanExercises, verbatim (no ORDER BY). */
export const legacyExercisesSql = (planId, categoryId) => `select

     a.workout_id
    , b.workout_name
    , a.sets_count
    , a.reps_count
    , b.video_file_name
    , b.description as video_description
    , b.thumbnail_file_name


from
    r_workout_plan a
    inner join m_workout b
        on a.workout_id = b.workout_id

    inner join m_workout_category c
        on a.workout_category_id = c.workout_category_id
        where a.workout_plan_id = '${Number(planId)}' and a.workout_category_id ='${Number(categoryId)}' `;
