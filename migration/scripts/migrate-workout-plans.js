/**
 * Legacy coach-assigned workout plans (m_workout_plan + blocks, exercises,
 * days) -> workoutplans: DRY RUN. See docs/workout-plans-design.md.
 *
 *   npm run migration:workout-plans:dry-run -- --source=staging [--report=<dir>] [--accept=code,code]
 *
 * Reads the legacy database through the read-only pool, resolves references
 * from MongoDB (reads only), transforms, validates against the schema,
 * checks the target for documents already there, and replays the legacy
 * runtime (verbatim WorkoutDAL SQL) for every client that would be migrated.
 * Writes nothing to either database: only a JSON and a Markdown report on
 * local disk. Writing is apply-workout-plans.js, which requires a fresh
 * passing report from this command.
 *
 * --source must be "staging", and the configured legacy database must be the
 * staging snapshot. Exit code 1 when a gate fails (validation, plan fields,
 * replay mismatches, target conflicts) or on any error.
 *
 * Never logged: credentials, hosts, plan names (they often hold a client's
 * name). Clients and plans appear by legacy id only.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import { closePool } from '../config/mariadb.js';
import { assertDevelopmentConnection, assertDevelopmentTarget } from '../config/dev-target.js';
import { assertMigrationEnv, migrationEnv } from '../config/migration.env.js';
import { extractLegacyCoaches, extractLegacyUsers, legacyAppDate } from '../extractors/diet-plan.extractor.js';
import {
  extractDanglingCategoryLinks,
  extractPlanCategories,
  extractPlanExercises,
  extractWorkoutPlanDates,
  extractWorkoutPlans,
  legacyCategoriesSql,
  legacyExercisesSql,
  legacyWorkoutDaySql,
  read,
} from '../extractors/workout-plan.extractor.js';
import {
  buildWorkoutReferences,
  classifyAgainstExisting,
  documentsFingerprint,
  existingMigratedPlans,
  fingerprint,
  planWorkoutMigration,
  replayWorkoutPlans,
  targetFingerprint,
  validateWorkoutPlans,
  verifyWorkoutPlanFields,
} from '../loaders/workout-plan.loader.js';

const LABEL = 'dry-run workout plans';
/** The only legacy source this migration may read (user decision, 2026-10-20). */
export const SOURCES = Object.freeze({ staging: 'staging-ggf' });

export const parseArgs = (argv) => {
  const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  if (argv.includes('--apply')) throw new Error('This command is dry-run only; writing is apply-workout-plans.js');
  const source = value('source');
  if (!source || !SOURCES[source]) throw new Error(`--source must be one of: ${Object.keys(SOURCES).join(', ')}`);
  return {
    source,
    reportDir: value('report'),
    accepted: new Set((value('accept') ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  };
};

/** The configured legacy database must be the one --source names; otherwise nothing is read. */
export const assertSource = (source, database = migrationEnv.mysql.database) => {
  if (database !== SOURCES[source]) {
    throw new Error(`Refusing to ${LABEL}: --source=${source} expects legacy database "${SOURCES[source]}", configured is "${database}"`);
  }
};

/** Every legacy row the migration reads. SELECT only, through the read-only pool. */
export const extractAll = async () => {
  const plans = await extractWorkoutPlans();
  const personIds = [...new Set(plans.flatMap((p) => [Number(p.user_id), Number(p.created_by)]))];
  return {
    plans,
    categories: await extractPlanCategories(),
    dangling: await extractDanglingCategoryLinks(),
    exercises: await extractPlanExercises(),
    dateRows: await extractWorkoutPlanDates(),
    legacyUsers: await extractLegacyUsers(personIds),
    legacyCoaches: await extractLegacyCoaches(),
  };
};

/** The legacy runtime: what a member saw, by the verbatim WorkoutDAL queries. */
export const legacyRuntime = {
  legacySelect: async (userId, day) => (await read(legacyWorkoutDaySql(userId, legacyAppDate(day))))[0] ?? null,
  legacyContent: async (planId) => {
    const out = [];
    for (const b of await read(legacyCategoriesSql(planId))) {
      out.push({ id: Number(b.WorkoutCategoryId), name: b.WorkoutCategoryName, exercises: await read(legacyExercisesSql(planId, b.WorkoutCategoryId)) });
    }
    return out;
  },
};

const countBy = (list, key) => list.reduce((acc, x) => ({ ...acc, [key(x)]: (acc[key(x)] ?? 0) + 1 }), {});

/** A document as the report holds it: no plan name (often a client's name). */
const redact = ({ name, ...d }) => ({ ...d, name: `<${String(name ?? '').length} chars>` });
const redactMismatch = (m) => (m.field === 'name' || m.field === 'workout_plan_name -> name' ? { ...m, legacy: '<redacted>', mongo: '<redacted>' } : m);

/**
 * Everything up to - never including - a write: extract, resolve, plan,
 * validate, check fields, replay, compare with the target. Shared by the dry
 * run and the apply, so the apply re-proves what it writes.
 */
export const prepareWorkoutPlanRun = async ({ source, accepted = new Set(), runId, targetDatabase, extract = extractAll, runtime = legacyRuntime }) => {
  const rows = await extract();
  const { plans, categories, dangling, exercises, dateRows, legacyUsers, legacyCoaches } = rows;
  const nonMidnight = dateRows.filter((r) => r.time != null && r.time !== '00:00:00');
  if (nonMidnight.length) throw new Error(`${nonMidnight.length} workout_date value(s) are not midnight; the date-only rule does not hold`);

  const refs = await buildWorkoutReferences({ plans, exercises, legacyUsers, legacyCoaches, source: migrationEnv.source });
  const { results, documents, readiness, ties, orphans } = planWorkoutMigration({
    plans, categories, exercises, dateRows, refs, accepted, runId, version: migrationEnv.version,
  });

  const validationErrors = await validateWorkoutPlans(documents);
  const planFields = verifyWorkoutPlanFields(documents, plans, dateRows);

  // Replay every client that would be migrated, over all their dated days.
  const planById = new Map(plans.map((p) => [Number(p.workout_plan_id), p]));
  const clientOfLegacyUser = new Map(documents.map((d) => [d.legacy.clientId, d.clientId]));
  const daysByUser = new Map();
  for (const r of dateRows) {
    const userId = Number(planById.get(Number(r.workout_plan_id))?.user_id);
    if (!clientOfLegacyUser.has(userId)) continue;
    if (!daysByUser.has(userId)) daysByUser.set(userId, new Set());
    daysByUser.get(userId).add(r.day);
  }
  const shownInLegacy = new Set(exercises.filter((e) => Number(e.workout_exists) === 1).map((e) => Number(e.workout_id)));
  const replay = await replayWorkoutPlans({
    documents,
    clients: [...daysByUser].map(([legacyUserId, days]) => ({ legacyUserId, clientId: clientOfLegacyUser.get(legacyUserId), days: [...days] })),
    ...runtime,
    shownInLegacy,
  });

  const existing = await existingMigratedPlans(migrationEnv.source);
  const againstTarget = classifyAgainstExisting(documents, existing);

  const issues = results.flatMap((r) => r.issues.map((i) => ({ ...i, workoutPlanId: r.legacyWorkoutPlanId })));
  const byDisposition = countBy(results, (r) => r.disposition);
  const accountedFor = Object.values(byDisposition).reduce((a, b) => a + b, 0) === plans.length;
  const pass = accountedFor && validationErrors.length === 0 && planFields.mismatches.length === 0
    && replay.mismatches.length === 0 && againstTarget.conflicts.length === 0;

  const report = {
    kind: 'workout-plans-dry-run',
    runId,
    dryRun: true,
    source,
    legacyDatabase: SOURCES[source],
    target: { database: targetDatabase, existingMigratedPlans: existing.length },
    acceptedDecisionCodes: [...accepted],
    fingerprints: {
      source: fingerprint(rows),
      documents: documentsFingerprint(documents),
      target: targetFingerprint(existing),
    },
    counts: {
      legacyPlans: plans.length,
      accountedFor,
      blockLinks: categories.length,
      danglingBlockLinks: dangling.length,
      exerciseRows: exercises.length,
      exerciseRowsHiddenInLegacy: exercises.filter((e) => Number(e.workout_exists) !== 1).length,
      dateRows: dateRows.length,
      orphanDateRows: orphans.length,
      documentsPlanned: documents.length,
      wouldCreate: againstTarget.toCreate.length,
      alreadyPresent: againstTarget.alreadyPresent.length,
      targetConflicts: againstTarget.conflicts.length,
      blocks: documents.reduce((n, d) => n + d.blocks.length, 0),
      exercises: documents.reduce((n, d) => n + d.blocks.reduce((m, b) => m + b.exercises.length, 0), 0),
      emptyDatedPlans: documents.filter((d) => d.blocks.every((b) => b.exercises.length === 0)).length,
      archivedExerciseRefs: issues.filter((i) => i.code === 'exercise_archived').length,
      assignedDays: documents.reduce((n, d) => n + d.selectedDates.length, 0),
      clients: readiness.length,
      clientsReady: readiness.filter((c) => c.ready).length,
      competingDays: ties.length,
      tiedDays: ties.filter((t) => t.tie).length,
    },
    byDisposition,
    issuesByCode: countBy(issues, (i) => `${i.severity}:${i.code}`),
    coachSources: countBy(documents, (d) => d.legacy.coachSource ?? 'null'),
    enrollmentIdSet: documents.filter((d) => d.enrollmentId).length,
    validationErrors,
    planFields: { ...planFields, mismatches: planFields.mismatches.map(redactMismatch) },
    replay: { ...replay, mismatches: replay.mismatches.map(redactMismatch), nameDiffs: replay.nameDiffs.length },
    targetConflicts: againstTarget.conflicts,
    plans: results.map((r) => ({
      workoutPlanId: r.legacyWorkoutPlanId,
      legacyUserId: r.legacyUserId,
      status: r.status,
      disposition: r.disposition,
      ...(r.heldBy ? { heldBy: r.heldBy, tied: r.tied } : {}),
      issues: r.issues,
    })),
    ties: ties.filter((t) => t.tie),
    orphanDateRows: orphans.map((r) => ({ workoutPlanId: Number(r.workout_plan_id), day: r.day })),
    danglingBlockLinks: dangling,
    documents: documents.map(redact),
    result: pass ? 'DRY RUN PASS' : 'DRY RUN FAIL',
    finishedAt: new Date().toISOString(),
  };
  return { report, documents, pass };
};

export const writeDryRunReport = async (report, reportDir = null) => {
  const dir = reportDir ?? path.join(process.cwd(), 'migration', 'reports', 'runs');
  await fs.mkdir(dir, { recursive: true });
  const jsonFile = path.join(dir, `${report.runId}.json`);
  const mdFile = path.join(dir, `${report.runId}.md`);
  await fs.writeFile(jsonFile, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(mdFile, humanReport(report), 'utf8');
  return { jsonFile, mdFile };
};

export const runWorkoutPlanDryRun = async ({
  source, reportDir = null, accepted = new Set(), runId = null,
  extract, runtime, assertTarget = (l) => assertDevelopmentConnection(undefined, l),
} = {}) => {
  const target = assertTarget(LABEL);
  const id = runId ?? `workout-plans-dry-run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  logger.info(`Workout plan migration DRY RUN: legacy ${SOURCES[source]} [read-only] -> MongoDB ${target.database} [reads only]`);
  const { report } = await prepareWorkoutPlanRun({ source, accepted, runId: id, targetDatabase: target.database, extract, runtime });
  const { jsonFile, mdFile } = await writeDryRunReport(report, reportDir);
  logger.info(`\n${humanReport(report)}\nreports: ${jsonFile}\n         ${mdFile}`);
  return { ...report, reportFile: jsonFile };
};

const list = (obj) => Object.entries(obj).sort().map(([k, v]) => `| ${k} | ${v} |`).join('\n');
const idsOf = (plans, disposition) => plans.filter((p) => p.disposition === disposition).map((p) => p.workoutPlanId);

export const humanReport = (r) => `# Workout plan migration — dry run

- Run: \`${r.runId}\`
- Source: ${r.source} (legacy \`${r.legacyDatabase}\`, read-only) → MongoDB \`${r.target.database}\` (reads only)
- **Writes: none.** Result: **${r.result}**
- Accepted decision codes: ${r.acceptedDecisionCodes.length ? r.acceptedDecisionCodes.join(', ') : 'none'}
- Fingerprints: source \`${r.fingerprints?.source?.slice(0, 12)}\`, documents \`${r.fingerprints?.documents?.slice(0, 12)}\`, target \`${r.fingerprints?.target?.slice(0, 12)}\`

## Counts

| | |
|---|---|
${list(r.counts)}

## Plans by disposition

| disposition | plans |
|---|---|
${list(r.byDisposition)}

- held_needs_decision: ${idsOf(r.plans, 'held_needs_decision').join(', ') || 'none'}
- held_by_client: ${r.plans.filter((p) => p.disposition === 'held_by_client').map((p) => `${p.workoutPlanId} (held by ${p.heldBy?.join('/') || ''}${p.tied ? ', tie' : ''})`).join(', ') || 'none'}
- blocked: ${idsOf(r.plans, 'blocked').join(', ') || 'none'}

## Issues by code

| severity:code | occurrences |
|---|---|
${list(r.issuesByCode)}

## Coach source (documents planned)

| source | documents |
|---|---|
${list(r.coachSources)}

enrollmentId set: ${r.enrollmentIdSet} (left unset until a verified mapping exists)

## Gates

| gate | result |
|---|---|
| every source plan accounted for | ${r.counts.accountedFor ? 'yes' : 'NO'} |
| schema validation errors | ${r.validationErrors.length} |
| plan-field mismatches | ${r.planFields.mismatches.length} |
| replay mismatches | ${r.replay.mismatches.length} |
| conflicts with documents already in the target | ${r.targetConflicts?.length ?? 0} |

Replay: ${r.replay.days} client-days (${r.replay.assignedDays} with a plan, ${r.replay.emptyDays} without), ${r.replay.plansCompared} plans' content, ${r.replay.exercisesCompared} exercises.
Exercise order as the legacy read returned it equals the stored order in ${r.replay.orderAsReturnedAgrees} blocks, differs in ${r.replay.orderAsReturnedDiffers} (legacy had no ORDER BY; not gating).
Exercise names differing from the Workout master snapshot: ${r.replay.nameDiffs} (not gating).

${r.replay.mismatches.slice(0, 30).map((m) => `- user ${m.legacyUserId} ${m.day} ${m.field}: legacy ${JSON.stringify(m.legacy)} / new ${JSON.stringify(m.mongo)}`).join('\n')}

## Reported, never attached

- Orphan date rows (no such plan): ${r.orphanDateRows.length}
- Block links to a missing category: ${r.danglingBlockLinks.length}
- Tied days (equal create_date): ${r.ties.length}
`;

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('migrate-workout-plans.js');
if (isEntryPoint) {
  let options;
  Promise.resolve()
    .then(() => { options = parseArgs(process.argv.slice(2)); })
    .then(() => assertMigrationEnv())
    .then(() => assertSource(options.source))
    .then(() => assertDevelopmentTarget(process.env, LABEL))
    // No implicit collection or index creation: a dry run must leave MongoDB exactly as it was.
    .then(() => mongoose.connect(process.env.MONGODB_URI, { autoCreate: false, autoIndex: false }))
    .then(() => runWorkoutPlanDryRun(options))
    .then((report) => { if (report.result !== 'DRY RUN PASS') process.exitCode = 1; })
    .catch((error) => {
      logger.error(`Workout plan dry run failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      await mongoose.connection.close().catch(() => {});
    });
}

export default runWorkoutPlanDryRun;
