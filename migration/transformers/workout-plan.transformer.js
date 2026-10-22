import { WORKOUT_PLAN_MAX_BLOCKS } from '../../src/models/workout-plan.model.js';
import { isCalendarDay, startOfBusinessDay } from '../../src/utils/business-date.js';
import { parseReps, parseSets } from '../../src/utils/workout-prescription.js';
import { legacyInstant } from './diet-plan.transformer.js';

/**
 * Legacy workout plans (m_workout_plan + its linked m_workout_category rows,
 * its r_workout_plan rows and r_workout_plan_dates days) into the
 * `workoutplans` shape: ONE document per legacy plan, blocks and exercises
 * embedded. Pure: no database here - the extractor hands rows in (days as
 * 'YYYY-MM-DD' text, DATE_FORMAT'd at the source so nothing shifts by a
 * timezone), the loader decides what to write.
 *
 * Nothing is dropped or invented in silence: every gap is an issue on the
 * result, with a severity -
 *   blocking - the plan cannot be built (e.g. its client is not a known user)
 *   decision - built, but needs an explicit yes before it is written (no
 *              days, no exercises, over 8 blocks, a missing exercise ...)
 *   info     - built as the legacy app showed it; reported for the record.
 * A client is migration-ready only when every one of its plans is (see
 * clientReadiness). See docs/workout-plans-design.md.
 */

export const SOURCE = 'gogetfit';

export const ISSUE = Object.freeze({
  CLIENT_UNRESOLVED: 'client_unresolved',
  INVALID_DATE: 'invalid_date',
  COACH_UNRESOLVED: 'coach_unresolved',
  COACH_AMBIGUOUS: 'coach_ambiguous',
  EXERCISE_MISSING: 'exercise_missing',
  EXERCISE_ARCHIVED: 'exercise_archived',
  EXERCISE_OUTSIDE_BLOCKS: 'exercise_outside_plan_blocks',
  NO_DATES: 'no_dates',
  NO_BLOCKS: 'no_blocks',
  NO_EXERCISES: 'no_exercises',
  EMPTY_BLOCK: 'empty_block',
  TOO_MANY_BLOCKS: 'too_many_blocks',
  DUPLICATE_DATES: 'duplicate_dates',
  DATES_BEFORE_CREATION: 'dates_before_creation',
  SETS_UNREAD: 'sets_unread',
  REPS_UNREAD: 'reps_unread',
});

const SEVERITY = Object.freeze({
  [ISSUE.CLIENT_UNRESOLVED]: 'blocking',
  [ISSUE.INVALID_DATE]: 'blocking',
  [ISSUE.EXERCISE_MISSING]: 'decision',
  [ISSUE.EXERCISE_OUTSIDE_BLOCKS]: 'decision',
  [ISSUE.NO_DATES]: 'decision',
  [ISSUE.NO_BLOCKS]: 'decision',
  [ISSUE.NO_EXERCISES]: 'decision',
  [ISSUE.TOO_MANY_BLOCKS]: 'decision',
  [ISSUE.COACH_UNRESOLVED]: 'info',
  [ISSUE.COACH_AMBIGUOUS]: 'info',
  [ISSUE.EXERCISE_ARCHIVED]: 'info',
  [ISSUE.EMPTY_BLOCK]: 'info',
  [ISSUE.DUPLICATE_DATES]: 'info',
  [ISSUE.DATES_BEFORE_CREATION]: 'info',
  [ISSUE.SETS_UNREAD]: 'info',
  [ISSUE.REPS_UNREAD]: 'info',
});

const issue = (code, detail = {}) => ({ code, severity: SEVERITY[code], ...detail });

export const planIdOf = (legacyId) => `${SOURCE}:${legacyId}`;
export const blockIdOf = (legacyCategoryId) => `${SOURCE}:cat:${legacyCategoryId}`;

/**
 * One legacy plan.
 *
 * @param {object} rows
 * @param rows.plan        m_workout_plan row ({workout_plan_id, workout_plan_name, user_id, created_by, create_date, last_update_date})
 * @param rows.categories  its linked m_workout_category rows ({workout_category_id, workout_category_name})
 * @param rows.exercises   its r_workout_plan rows ({workout_category_id, workout_id, sets_count, reps_count})
 * @param rows.days        its r_workout_plan_dates days, 'YYYY-MM-DD', as stored (repeats and all)
 * @param {object} refs
 * @param refs.clientIdByLegacyUserId   Map<number, ObjectId> - verified users only
 * @param refs.coachIdByLegacyUserId    Map<number, ObjectId> - verified coaches only (the plan's author)
 * @param refs.enrollmentsByClient      Map<string clientId, [{coachId, from, to}]> - the client's
 *                                      migrated enrollments (from/to 'YYYY-MM-DD' or null) - their coach in the old app
 * @param refs.workoutsByLegacyId       Map<number, {_id, name, status}>
 * @returns {{ planId, document, status, issues }}  status: 'ready' | 'needs_decision' | 'blocked'
 */
export const transformWorkoutPlan = (rows, refs, { runId = null, version = null, now = new Date() } = {}) => {
  const { plan } = rows;
  const legacyId = Number(plan.workout_plan_id);
  const planId = planIdOf(legacyId);
  const issues = [];

  // The client: a verified user, or the plan cannot be built. Never guessed.
  const clientId = refs.clientIdByLegacyUserId.get(Number(plan.user_id)) ?? null;
  if (!clientId) issues.push(issue(ISSUE.CLIENT_UNRESOLVED, { legacyUserId: Number(plan.user_id) }));
  // Days: distinct, ascending, as calendar days -> the start of each business day.
  const rawDays = rows.days ?? [];
  const badDays = rawDays.filter((d) => !isCalendarDay(d));
  if (badDays.length) issues.push(issue(ISSUE.INVALID_DATE, { count: badDays.length }));
  const days = [...new Set(rawDays.filter(isCalendarDay))].sort();
  if (rawDays.length - badDays.length > days.length) {
    issues.push(issue(ISSUE.DUPLICATE_DATES, { duplicates: rawDays.length - badDays.length - days.length }));
  }
  if (!days.length) issues.push(issue(ISSUE.NO_DATES));
  const createDate = legacyInstant(plan.create_date);
  const createdDay = typeof plan.create_date === 'string' ? plan.create_date.slice(0, 10) : null;
  const early = createdDay ? days.filter((d) => d < createdDay).length : 0;
  if (early) issues.push(issue(ISSUE.DATES_BEFORE_CREATION, { count: early }));

  // Blocks: each linked category, deep-copied into this plan, in legacy
  // display order (category id ascending - the order the app showed).
  const categories = [...(rows.categories ?? [])].sort((a, b) => a.workout_category_id - b.workout_category_id);
  if (!categories.length) issues.push(issue(ISSUE.NO_BLOCKS));
  if (categories.length > WORKOUT_PLAN_MAX_BLOCKS) {
    issues.push(issue(ISSUE.TOO_MANY_BLOCKS, { blocks: categories.length, max: WORKOUT_PLAN_MAX_BLOCKS }));
  }
  const inPlan = new Set(categories.map((c) => c.workout_category_id));
  const outside = (rows.exercises ?? []).filter((e) => !inPlan.has(e.workout_category_id));
  if (outside.length) {
    issues.push(issue(ISSUE.EXERCISE_OUTSIDE_BLOCKS, {
      rows: outside.map((e) => ({ legacyCategoryId: e.workout_category_id, legacyWorkoutId: e.workout_id })),
    }));
  }

  let exerciseCount = 0;
  const blocks = categories.map((c, order) => {
    // Exercise order: legacy stored none; workout id ascending is the
    // primary-key order the legacy read returned (inferred, not guaranteed).
    const rowsHere = (rows.exercises ?? [])
      .filter((e) => e.workout_category_id === c.workout_category_id)
      .sort((a, b) => a.workout_id - b.workout_id);
    if (!rowsHere.length) issues.push(issue(ISSUE.EMPTY_BLOCK, { legacyCategoryId: c.workout_category_id }));
    const exercises = rowsHere.map((e) => {
      exerciseCount += 1;
      const workout = refs.workoutsByLegacyId.get(Number(e.workout_id)) ?? null;
      if (!workout) {
        issues.push(issue(ISSUE.EXERCISE_MISSING, { legacyWorkoutId: Number(e.workout_id), legacyCategoryId: c.workout_category_id }));
      } else if (workout.status === 'archived') {
        issues.push(issue(ISSUE.EXERCISE_ARCHIVED, { legacyWorkoutId: Number(e.workout_id) }));
      }
      const setsRaw = e.sets_count ?? null;
      const repsRaw = e.reps_count ?? null;
      const sets = parseSets(setsRaw);
      const reps = parseReps(repsRaw);
      if (setsRaw != null && sets == null) issues.push(issue(ISSUE.SETS_UNREAD, { legacyWorkoutId: Number(e.workout_id), setsRaw }));
      if (repsRaw != null && reps.amount == null) issues.push(issue(ISSUE.REPS_UNREAD, { legacyWorkoutId: Number(e.workout_id), repsRaw }));
      return {
        workoutId: workout?._id ?? null,
        legacyWorkoutId: Number(e.workout_id),
        name: workout?.name ?? null,
        setsRaw,
        repsRaw,
        sets,
        ...reps,
        note: null,
      };
    });
    return {
      blockId: blockIdOf(c.workout_category_id),
      legacyCategoryId: c.workout_category_id,
      name: c.workout_category_name ?? '',
      order,
      exercises,
    };
  });
  // A dated plan with blocks but no exercises is kept as it was: the legacy
  // day query still selected it (newest wins), and the member saw it empty
  // (staging plan 60). Dropping it would hand its days to an older plan.
  // Undated, it stays a decision - and is report-only anyway.
  if (categories.length && !exerciseCount) {
    issues.push({ ...issue(ISSUE.NO_EXERCISES), ...(days.length ? { severity: 'info' } : {}) });
  }

  // The coach: the diet-plan rule (the verified author), else the client's
  // own coach in the old app as their migrated enrollments hold it - never
  // guessed.
  const coach = clientId
    ? coachFor({
        enrollments: refs.enrollmentsByClient?.get(String(clientId)) ?? [],
        days: [createdDay, days[0]].filter(Boolean),
        creatorCoachId: refs.coachIdByLegacyUserId.get(Number(plan.created_by)) ?? null,
      })
    : { coachId: null, source: null, ambiguous: [] };
  if (coach.ambiguous.length) {
    issues.push(issue(ISSUE.COACH_AMBIGUOUS, { coachIds: coach.ambiguous.map(String) }));
  }
  if (!coach.coachId) issues.push(issue(ISSUE.COACH_UNRESOLVED, { legacyCreatedBy: Number(plan.created_by) }));

  const selectedDates = days.map((d) => startOfBusinessDay(d));
  const status = issues.some((i) => i.severity === 'blocking')
    ? 'blocked'
    : issues.some((i) => i.severity === 'decision')
      ? 'needs_decision'
      : 'ready';
  const document = clientId
    ? {
        planId,
        clientId,
        coachId: coach.coachId,
        enrollmentId: null,
        name: plan.workout_plan_name ?? '',
        blocks,
        selectedDates,
        fromDate: selectedDates[0] ?? null,
        toDate: selectedDates[selectedDates.length - 1] ?? null,
        // The legacy precedence: the plan's own creation time.
        assignedAt: createDate ?? now,
        status: 'active',
        legacy: {
          source: SOURCE,
          workoutPlanId: legacyId,
          clientId: Number(plan.user_id),
          createdBy: Number(plan.created_by),
          coachSource: coach.source,
          createDate,
          lastUpdateDate: legacyInstant(plan.last_update_date),
        },
        migration: { runId, migratedAt: null, version },
      }
    : null;
  return { planId, document, status, issues };
};

/**
 * The plan's coach - the diet-plan rule first, then the client's own coach:
 *   1. creator            - the plan's author, verified as a coach exactly as
 *      the diet-plan migration verifies it (creatorCoachId: user path and
 *      legacy-coach mapping agree - migration/loaders/diet-plan.loader.js);
 *   2. client_enrollment  - else the coach of the client's enrollment covering
 *      the plan's day (its creation day, else its first assigned day);
 *   3. client_only_coach  - else the client's only coach across their
 *      enrollments;
 *   else null. Two different coaches covering the day is ambiguous: no pick,
 *   reported.
 */
export const coachFor = ({ enrollments, days, creatorCoachId }) => {
  if (creatorCoachId) return { coachId: creatorCoachId, source: 'creator', ambiguous: [] };
  const withCoach = enrollments.filter((e) => e.coachId);
  for (const day of days) {
    const covering = [...new Set(
      withCoach.filter((e) => e.from && e.to && e.from <= day && day <= e.to).map((e) => String(e.coachId)),
    )];
    if (covering.length === 1) {
      return { coachId: withCoach.find((e) => String(e.coachId) === covering[0]).coachId, source: 'client_enrollment', ambiguous: [] };
    }
    if (covering.length > 1) return { coachId: null, source: null, ambiguous: covering };
  }
  const all = [...new Set(withCoach.map((e) => String(e.coachId)))];
  if (all.length === 1) return { coachId: withCoach[0].coachId, source: 'client_only_coach', ambiguous: [] };
  return { coachId: null, source: null, ambiguous: [] };
};

/**
 * Days on which one client has more than one plan: which wins (newest
 * assignedAt, then higher legacy id - WorkoutPlan.findForDay), and any day
 * where the winner is not certain (equal assignedAt) - a tie the legacy
 * query left to the database, so it is reported, never guessed.
 */
export const competingDays = (documents) => {
  const byClientDay = new Map();
  for (const d of documents) {
    for (const day of d.selectedDates) {
      const key = `${d.clientId}|${day.toISOString()}`;
      if (!byClientDay.has(key)) byClientDay.set(key, []);
      byClientDay.get(key).push(d);
    }
  }
  const out = [];
  for (const [key, plans] of byClientDay) {
    if (plans.length < 2) continue;
    const sorted = [...plans].sort(
      (a, b) => b.assignedAt - a.assignedAt || b.legacy.workoutPlanId - a.legacy.workoutPlanId,
    );
    const [clientId, day] = key.split('|');
    out.push({
      clientId,
      day,
      planIds: sorted.map((p) => p.planId),
      winner: sorted[0].planId,
      tie: sorted[0].assignedAt.getTime() === sorted[1].assignedAt.getTime(),
    });
  }
  return out;
};

/**
 * Per client: ready only when every one of its plans is - 'ready', or
 * 'needs_decision' with each decision code listed in [accepted] (the
 * documented exception policy) - and no competing day is a tie. One plan
 * held back holds the client back: migrating a client's plans in part would
 * let an older plan show on a day a newer one won.
 */
export const clientReadiness = (results, { accepted = new Set(), ties = [] } = {}) => {
  const byClient = new Map();
  for (const r of results) {
    const key = r.document ? String(r.document.clientId) : `legacy:${r.issues.find((i) => i.code === ISSUE.CLIENT_UNRESOLVED)?.legacyUserId}`;
    if (!byClient.has(key)) byClient.set(key, []);
    byClient.get(key).push(r);
  }
  const tiedClients = new Set(ties.filter((t) => t.tie).map((t) => t.clientId));
  return [...byClient].map(([client, plans]) => {
    const holding = plans.filter(
      (p) => p.status === 'blocked' || p.issues.some((i) => i.severity === 'decision' && !accepted.has(i.code)),
    );
    return {
      client,
      plans: plans.map((p) => p.planId),
      ready: holding.length === 0 && !tiedClients.has(client),
      heldBy: holding.map((p) => p.planId),
      tied: tiedClients.has(client),
    };
  });
};

/** Assignment rows pointing at no known plan (e.g. workout_plan_id 0): reported, never attached. */
export const orphanAssignments = (dateRows, knownPlanIds) =>
  dateRows.filter((r) => !knownPlanIds.has(Number(r.workout_plan_id)));

export default { transformWorkoutPlan, competingDays, clientReadiness, orphanAssignments, planIdOf, blockIdOf };
