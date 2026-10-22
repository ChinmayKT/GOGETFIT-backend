import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import EnrolledClient from '../../src/models/enrolled-client.model.js';
import Workout from '../../src/models/workout.model.js';
import WorkoutPlan from '../../src/models/workout-plan.model.js';
import { startOfBusinessDay } from '../../src/utils/business-date.js';
import { addDays, legacyInstant } from '../transformers/diet-plan.transformer.js';
import {
  ISSUE,
  clientReadiness,
  competingDays,
  orphanAssignments,
  transformWorkoutPlan,
} from '../transformers/workout-plan.transformer.js';
import { buildReferences as buildDietReferences, businessDayOf } from './diet-plan.loader.js';

/**
 * m_workout_plan (+ blocks, exercises, days) -> workoutplans.
 *
 * buildWorkoutReferences resolves legacy ids by the verified bridges only:
 * users.legacy.userId; the plan author as a Coach exactly as the diet-plan
 * migration verifies it (its buildReferences, reused); the client's migrated
 * enrollments and their coach; workouts.legacy.workoutId. Nothing is guessed.
 *
 * planWorkoutMigration classifies every plan and client; replayWorkoutPlans
 * compares the result with the legacy runtime day by day. See
 * docs/workout-plans-design.md.
 */

export const buildWorkoutReferences = async ({ plans, exercises, legacyUsers, legacyCoaches, source }) => {
  const diet = await buildDietReferences({ plans, legacyUsers, legacyCoaches, foodIds: [], source });

  const coachIdByLegacyUserId = new Map();
  const creatorReasons = new Map();
  for (const [createdBy, c] of diet.creators) {
    if (c.coachId) coachIdByLegacyUserId.set(createdBy, c.coachId);
    creatorReasons.set(createdBy, c.reason);
  }

  const clientIds = [...new Set(plans.map((p) => diet.userByLegacy.get(Number(p.user_id))).filter(Boolean))];
  const enrollments = await EnrolledClient.find({ userId: { $in: clientIds }, isDeleted: { $ne: true } })
    .select('_id userId coachId startDate endDate')
    .lean();
  const enrollmentsByClient = new Map();
  for (const e of enrollments) {
    const key = String(e.userId);
    if (!enrollmentsByClient.has(key)) enrollmentsByClient.set(key, []);
    enrollmentsByClient.get(key).push({ coachId: e.coachId ?? null, from: businessDayOf(e.startDate), to: businessDayOf(e.endDate) });
  }

  const workoutIds = [...new Set(exercises.map((e) => Number(e.workout_id)))];
  const workouts = await Workout.find({ 'legacy.source': source, 'legacy.workoutId': { $in: workoutIds } })
    .select('_id name status legacy')
    .lean();
  const workoutsByLegacyId = new Map(workouts.map((w) => [w.legacy.workoutId, w]));

  return {
    clientIdByLegacyUserId: diet.userByLegacy,
    coachIdByLegacyUserId,
    creatorReasons,
    enrollmentsByClient,
    workoutsByLegacyId,
    legacyUserById: diet.legacyUserById,
  };
};

const group = (rows, key) => {
  const out = new Map();
  for (const r of rows) {
    const id = Number(r[key]);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(r);
  }
  return out;
};

export const UNDATED_REPORT_ONLY = 'undated_report_only';

/**
 * Every plan transformed, then each client decided whole:
 *   - an undated plan applies on no day: reported, never written, and it
 *     holds nobody back (the diet-plan precedent);
 *   - a client migrates only when every dated plan of theirs is ready (or its
 *     decision codes are all in [accepted]) and none of their shared days is
 *     a tie - one held plan holds the client (clientReadiness).
 * Returns the documents that would be written; nothing is written here.
 */
export const planWorkoutMigration = ({ plans, categories, exercises, dateRows, refs, accepted = new Set(), runId = null, version = null, now = new Date() }) => {
  const categoriesByPlan = group(categories, 'workout_plan_id');
  const exercisesByPlan = group(exercises, 'workout_plan_id');
  const daysByPlan = group(dateRows, 'workout_plan_id');

  const results = plans.map((plan) => {
    const id = Number(plan.workout_plan_id);
    const result = transformWorkoutPlan(
      {
        plan,
        categories: categoriesByPlan.get(id) ?? [],
        exercises: exercisesByPlan.get(id) ?? [],
        days: (daysByPlan.get(id) ?? []).map((r) => r.day),
      },
      refs,
      { runId, version, now },
    );
    const undated = result.issues.some((i) => i.code === ISSUE.NO_DATES) && result.status !== 'blocked';
    return { ...result, legacyWorkoutPlanId: id, legacyUserId: Number(plan.user_id), undated };
  });

  const dated = results.filter((r) => !r.undated);
  const ties = competingDays(dated.filter((r) => r.document).map((r) => r.document));
  const readiness = clientReadiness(dated, { accepted, ties });
  const readyClients = new Set(readiness.filter((c) => c.ready).map((c) => c.client));
  const documents = dated.filter((r) => r.document && readyClients.has(String(r.document.clientId))).map((r) => r.document);

  const disposition = (r) => {
    if (r.status === 'blocked') return 'blocked';
    if (r.undated) return UNDATED_REPORT_ONLY;
    if (readyClients.has(String(r.document.clientId))) return 'migrate';
    if (r.status === 'needs_decision' && r.issues.some((i) => i.severity === 'decision' && !accepted.has(i.code))) return 'held_needs_decision';
    return 'held_by_client';
  };
  const heldByClient = new Map(readiness.map((c) => [c.client, c]));
  const classified = results.map((r) => {
    const d = disposition(r);
    const client = r.document ? heldByClient.get(String(r.document.clientId)) : null;
    return { ...r, disposition: d, ...(d === 'held_by_client' ? { heldBy: client.heldBy, tied: client.tied } : {}) };
  });
  const orphans = orphanAssignments(dateRows, new Set(plans.map((p) => Number(p.workout_plan_id))));
  return { results: classified, documents, readiness, ties, orphans };
};

/** Runs every document through the Mongoose schema without saving. */
export const validateWorkoutPlans = async (documents) => {
  const errors = [];
  for (const d of documents) {
    try {
      await new WorkoutPlan(d).validate();
    } catch (error) {
      errors.push({ workoutPlanId: d.legacy.workoutPlanId, error: error.message });
    }
  }
  return errors;
};

/** Every document's header fields against its m_workout_plan row and distinct date rows. */
export const verifyWorkoutPlanFields = (documents, plans, dateRows) => {
  const planById = new Map(plans.map((p) => [Number(p.workout_plan_id), p]));
  const daysByPlan = group(dateRows, 'workout_plan_id');
  const mismatches = [];
  const checked = {};
  const iso = (d) => d?.toISOString() ?? null;
  for (const d of documents) {
    const id = d.legacy.workoutPlanId;
    const plan = planById.get(id);
    const days = [...new Set((daysByPlan.get(id) ?? []).map((r) => r.day))].sort();
    const pairs = [
      ['workout_plan_id -> planId', `${d.legacy.source}:${plan.workout_plan_id}`, d.planId],
      ['workout_plan_name -> name', plan.workout_plan_name ?? '', d.name],
      ['user_id -> legacy.clientId', Number(plan.user_id), d.legacy.clientId],
      ['created_by -> legacy.createdBy', Number(plan.created_by), d.legacy.createdBy],
      ['create_date -> assignedAt', iso(legacyInstant(plan.create_date)), iso(d.assignedAt)],
      ['create_date -> legacy.createDate', iso(legacyInstant(plan.create_date)), iso(d.legacy.createDate)],
      ['last_update_date -> legacy.lastUpdateDate', iso(legacyInstant(plan.last_update_date)), iso(d.legacy.lastUpdateDate)],
      ['workout_date (distinct) -> selectedDates', days.map((day) => iso(startOfBusinessDay(day))).join(','), d.selectedDates.map(iso).join(',')],
    ];
    for (const [field, legacy, mongo] of pairs) {
      checked[field] = (checked[field] ?? 0) + 1;
      if (!Object.is(legacy, mongo)) mismatches.push({ workoutPlanId: id, field, legacy, mongo });
    }
  }
  return { documents: documents.length, checked, mismatches };
};

/** The new runtime rule over in-memory documents - identical to WorkoutPlan.findForDay. */
export const selectWorkoutPlanForDay = (documents, clientId, day) => {
  const at = startOfBusinessDay(day).getTime();
  let best = null;
  for (const d of documents) {
    if (String(d.clientId) !== String(clientId) || d.status !== 'active') continue;
    if (!d.selectedDates.some((s) => s.getTime() === at)) continue;
    if (
      !best ||
      d.assignedAt > best.assignedAt ||
      (d.assignedAt.getTime() === best.assignedAt.getTime() && d.legacy.workoutPlanId > best.legacy.workoutPlanId)
    ) best = d;
  }
  return best;
};

const legacyPrescription = (r) => JSON.stringify([Number(r.workout_id), r.sets_count ?? null, r.reps_count ?? null]);
const mongoPrescription = (e) => JSON.stringify([e.legacyWorkoutId, e.setsRaw, e.repsRaw]);

/**
 * Day-by-day comparison with the legacy runtime, for every client that would
 * be migrated.
 *
 * Days: every assigned day of the client and the day either side of it. The
 * legacy query can only return a plan on a day one of the client's plans has
 * a date row, so these are the only days where the two can differ (gaps
 * longer than a day are covered by the empty neighbours).
 *
 * Gating mismatches: the selected plan, its name, its blocks (id, name, order)
 * and each block's exercises (workout, sets, reps - as a set, because the
 * legacy read has no ORDER BY). Reported, not gating: whether the legacy
 * order as returned equals the stored order (workout id ascending), and
 * exercise display names that differ from the Workout master snapshot.
 *
 * @param legacySelect  (legacyUserId, yyyy-mm-dd) -> legacy row or null (verbatim E10)
 * @param legacyContent (workoutPlanId) -> [{ id, name, exercises: rows }] (verbatim E3)
 * @param shownInLegacy legacy workout ids with an m_workout row (the legacy read hides the rest)
 */
export const replayWorkoutPlans = async ({ documents, clients, legacySelect, legacyContent, shownInLegacy, concurrency = 4 }) => {
  const jobs = [];
  for (const c of clients) {
    const days = new Set();
    for (const day of c.days) for (const n of [-1, 0, 1]) days.add(addDays(day, n));
    for (const day of [...days].sort()) jobs.push({ c, day });
  }

  const contentCache = new Map();
  const contentOf = (id) => {
    if (!contentCache.has(id)) contentCache.set(id, legacyContent(id));
    return contentCache.get(id);
  };

  const result = { days: 0, assignedDays: 0, emptyDays: 0, plansCompared: new Set(), exercisesCompared: 0, orderAsReturnedAgrees: 0, orderAsReturnedDiffers: 0, nameDiffs: [], mismatches: [] };
  const fail = (job, field, legacy, mongo) => result.mismatches.push({ legacyUserId: job.c.legacyUserId, day: job.day, field, legacy, mongo });
  const compared = new Set();

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const legacyRow = await legacySelect(job.c.legacyUserId, job.day);
      const doc = selectWorkoutPlanForDay(documents, job.c.clientId, job.day);
      result.days += 1;
      if (legacyRow) result.assignedDays += 1;
      else result.emptyDays += 1;

      const legacyId = legacyRow ? Number(legacyRow.workout_plan_id) : null;
      const mongoId = doc ? doc.legacy.workoutPlanId : null;
      if (legacyId !== mongoId) { fail(job, 'selectedPlan', legacyId, mongoId); continue; }
      if (!doc) continue;
      if (legacyRow.workout_plan_name !== doc.name) fail(job, 'name', legacyRow.workout_plan_name, doc.name);

      // Content is per plan, not per day: compare it once.
      if (compared.has(legacyId)) continue;
      compared.add(legacyId);
      result.plansCompared.add(legacyId);
      const blocks = await contentOf(legacyId);
      const legacyBlocks = blocks.map((b) => `${b.id}|${b.name}`);
      const mongoBlocks = doc.blocks.map((b) => `${b.legacyCategoryId}|${b.name}`);
      if (!isDeepStrictEqual(legacyBlocks, mongoBlocks)) { fail(job, 'blocks', legacyBlocks, mongoBlocks); continue; }
      for (const [i, block] of blocks.entries()) {
        const visible = doc.blocks[i].exercises.filter((e) => shownInLegacy.has(e.legacyWorkoutId));
        const legacyRows = block.exercises.map(legacyPrescription);
        const mongoRows = visible.map(mongoPrescription);
        result.exercisesCompared += legacyRows.length;
        if (!isDeepStrictEqual([...legacyRows].sort(), [...mongoRows].sort())) {
          fail(job, `block ${block.id} exercises`, legacyRows, mongoRows);
          continue;
        }
        if (isDeepStrictEqual(legacyRows, mongoRows)) result.orderAsReturnedAgrees += 1;
        else result.orderAsReturnedDiffers += 1;
        for (const row of block.exercises) {
          const mine = visible.find((e) => e.legacyWorkoutId === Number(row.workout_id));
          if (mine && mine.name !== row.workout_name) result.nameDiffs.push({ workoutPlanId: legacyId, legacyWorkoutId: Number(row.workout_id), legacy: row.workout_name, mongo: mine.name });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  result.plansCompared = result.plansCompared.size;
  result.mismatches.sort((a, b) => a.legacyUserId - b.legacyUserId || a.day.localeCompare(b.day));
  return result;
};

// ─── Apply (create-only) and rollback ────────────────────────────────────────

const SOURCE_OF = (documents) => documents[0]?.legacy.source;

/** sha256 of a value's JSON - Dates as ISO, ObjectIds as hex. */
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A document as compared between runs: no run tag, no database-assigned fields. */
const comparable = (d) => {
  const { _id, createdAt, updatedAt, migration, ...rest } = d;
  return JSON.parse(JSON.stringify(rest));
};
export const documentsFingerprint = (documents) => fingerprint(documents.map((d) => comparable(new WorkoutPlan(d).toObject())));

/** The migrated workout plans already in the target, keyed by legacy id. Read only. */
export const existingMigratedPlans = (source, workoutPlanIds = null) =>
  WorkoutPlan.find({
    $or: [
      { 'legacy.source': source, ...(workoutPlanIds ? { 'legacy.workoutPlanId': { $in: workoutPlanIds } } : {}) },
      ...(workoutPlanIds ? [{ planId: { $in: workoutPlanIds.map((id) => `${source}:${id}`) } }] : []),
    ],
  }).lean();

/** The target state the dry run saw: which legacy plans exist, as which documents. */
export const targetFingerprint = (existing) =>
  fingerprint(existing.map((d) => `${d.legacy?.workoutPlanId ?? d.planId}:${d._id}`).sort());

/**
 * Each planned document against what the target already holds: absent ->
 * create; present and identical (apart from its run tag) -> already present,
 * left alone (an idempotent rerun); present and different -> conflict, never
 * touched. A legacy id planned twice is refused outright.
 */
export const classifyAgainstExisting = (documents, existing) => {
  const ids = documents.map((d) => d.legacy.workoutPlanId);
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (twice.length) throw new Error(`Duplicate legacy workout plan id(s) in the batch: ${[...new Set(twice)].join(', ')}`);

  const source = SOURCE_OF(documents);
  const byLegacy = new Map(existing.filter((e) => e.legacy?.source === source).map((e) => [e.legacy.workoutPlanId, e]));
  const byPlanId = new Map(existing.map((e) => [e.planId, e]));
  const toCreate = [];
  const alreadyPresent = [];
  const conflicts = [];
  for (const d of documents) {
    // Same legacy plan, or any document already using its planId.
    const found = byLegacy.get(d.legacy.workoutPlanId) ?? byPlanId.get(d.planId);
    if (!found) toCreate.push(d);
    else if (isDeepStrictEqual(comparable(found), comparable(new WorkoutPlan(d).toObject()))) {
      alreadyPresent.push({ workoutPlanId: d.legacy.workoutPlanId, _id: String(found._id), runId: found.migration?.runId ?? null });
    } else conflicts.push({ workoutPlanId: d.legacy.workoutPlanId, existingId: String(found._id) });
  }
  return { toCreate, alreadyPresent, conflicts };
};

/**
 * Inserts the documents that do not exist yet, one by one, each tagged with
 * [runId]. Never updates, replaces or deletes. Stops before writing anything
 * when a conflict exists; stops at the first failed insert and reports what
 * was inserted, what failed and what was not attempted. A rerun skips what
 * is already present (identical), so it is safe after a partial failure.
 * [onProgress] receives the state after every insert (the manifest writer).
 */
export const applyWorkoutPlans = async (documents, { runId, version = null, now = new Date(), onProgress = async () => {} }) => {
  if (!runId) throw new Error('applyWorkoutPlans needs a run id');
  if (!documents.length) {
    const empty = { status: 'complete', inserted: [], alreadyPresent: [], conflicts: [], failed: [], notAttempted: [] };
    await onProgress(empty);
    return empty;
  }
  const existing = await existingMigratedPlans(SOURCE_OF(documents), documents.map((d) => d.legacy.workoutPlanId));
  const { toCreate, alreadyPresent, conflicts } = classifyAgainstExisting(documents, existing);
  const state = { status: 'running', inserted: [], alreadyPresent, conflicts, failed: [], notAttempted: [] };
  if (conflicts.length) {
    state.status = 'refused_conflicts';
    state.notAttempted = toCreate.map((d) => d.legacy.workoutPlanId);
    await onProgress(state);
    return state;
  }
  await onProgress(state);
  for (const [i, d] of toCreate.entries()) {
    try {
      const created = await WorkoutPlan.create({ ...d, migration: { runId, migratedAt: now, version } });
      state.inserted.push({ _id: String(created._id), workoutPlanId: d.legacy.workoutPlanId, planId: d.planId });
      await onProgress(state);
    } catch (error) {
      state.failed.push({ workoutPlanId: d.legacy.workoutPlanId, code: error.code ?? error.name, error: error.message });
      state.notAttempted = toCreate.slice(i + 1).map((x) => x.legacy.workoutPlanId);
      state.status = 'partial';
      await onProgress(state);
      return state;
    }
  }
  state.status = 'complete';
  await onProgress(state);
  return state;
};

/**
 * Why a dry-run report may not authorise an apply now (empty = it may):
 * it must be a passing workout-plan dry run, of the same source snapshot,
 * planning the same documents against the same target state, and recent.
 */
export const staleReportReasons = (report, current, { now = new Date(), maxAgeHours = 24 } = {}) => {
  const reasons = [];
  if (report?.kind !== 'workout-plans-dry-run' || report.dryRun !== true) reasons.push('not a workout-plan dry-run report');
  if (report?.result !== 'DRY RUN PASS') reasons.push(`report result is ${report?.result}`);
  for (const k of ['source', 'legacyDatabase']) if (report?.[k] !== current[k]) reasons.push(`${k} differs`);
  if (report?.target?.database !== current.target.database) reasons.push('target database differs');
  for (const k of ['source', 'documents', 'target']) {
    if (report?.fingerprints?.[k] !== current.fingerprints[k]) reasons.push(`${k} fingerprint differs (re-run the dry run)`);
  }
  const age = (now - new Date(report?.finishedAt)) / 3_600_000;
  if (!(age >= 0 && age <= maxAgeHours)) reasons.push(`report is ${Number.isFinite(age) ? `${age.toFixed(1)} h` : 'of unknown age'} old (max ${maxAgeHours} h)`);
  return reasons;
};

/**
 * Removes exactly the documents one apply run created - only after the
 * manifest and the database agree: every manifest document exists, carries
 * this run id and its legacy id, and was not modified since; and no other
 * document carries this run id. Anything else refuses, deleting nothing.
 * Without [confirm] it only reports what it would delete.
 */
export const rollbackWorkoutPlanRun = async ({ runId, manifest, confirm = false }) => {
  const problems = [];
  if (!runId || manifest?.runId !== runId) problems.push('manifest run id does not match');
  const listed = manifest?.inserted ?? [];
  const tagged = await WorkoutPlan.find({ 'migration.runId': runId }).select('_id legacy.workoutPlanId createdAt updatedAt').lean();
  const taggedById = new Map(tagged.map((d) => [String(d._id), d]));
  for (const m of listed) {
    const d = taggedById.get(String(m._id));
    if (!d) problems.push(`manifest document ${m._id} (plan ${m.workoutPlanId}) is not in the database with this run id`);
    else if (d.legacy?.workoutPlanId !== m.workoutPlanId) problems.push(`document ${m._id} holds plan ${d.legacy?.workoutPlanId}, manifest says ${m.workoutPlanId}`);
    else if (d.updatedAt?.getTime() !== d.createdAt?.getTime()) problems.push(`document ${m._id} (plan ${m.workoutPlanId}) was modified after the run`);
  }
  const listedIds = new Set(listed.map((m) => String(m._id)));
  const unlisted = tagged.filter((d) => !listedIds.has(String(d._id)));
  if (unlisted.length) problems.push(`${unlisted.length} document(s) carry this run id but are not in the manifest: ${unlisted.map((d) => d._id).join(', ')}`);

  const result = { runId, wouldDelete: problems.length ? 0 : listed.length, deleted: 0, problems };
  if (problems.length || !confirm) return result;
  const { deletedCount } = await WorkoutPlan.deleteMany({ _id: { $in: listed.map((m) => m._id) }, 'migration.runId': runId });
  result.deleted = deletedCount;
  return result;
};
