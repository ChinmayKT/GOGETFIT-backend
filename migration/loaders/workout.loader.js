import Workout from '../../src/models/workout.model.js';
import User from '../../src/models/user.model.js';
import { ROLE_ADMIN } from '../../src/constants/roles.js';
import { migrationEnv } from '../config/migration.env.js';
import { transformLegacyWorkout } from '../transformers/workout.transformer.js';

/**
 * m_workout -> workouts.
 *
 * Identity is (legacy.source, legacy.workoutId) - never the name, which legacy
 * never kept unique. Each legacy workout becomes exactly one Workout document.
 *
 * Rules:
 *   - a row that does not map cleanly is skipped and reported by workout_id
 *     with the reason - never repaired, never partially written;
 *   - delete_flg = 1 is migrated as `archived`, not dropped: those rows are
 *     real data and plans may still reference them;
 *   - an already-migrated workout is left exactly as it is. This loader
 *     creates; it never updates and never deletes.
 *
 * createdBy/updatedBy are a real admin, resolved before anything is written.
 * Legacy's own created_by is the literal string "123" on all 188 rows and maps
 * to no user, so it is dropped rather than carried over.
 */

export class WorkoutOwnerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkoutOwnerError';
  }
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The admin every migrated legacy workout is attributed to - the same one the coupons use. */
export const LEGACY_WORKOUT_OWNER_EMAIL = 'prajwal@gogetfitonline.com';

/**
 * Looks up the admin who will own the migrated workouts. Never creates one and
 * never guesses: throws - stopping the run before any write - when the email
 * matches no user, several users, or a user without the admin role.
 */
export const resolveWorkoutOwner = async (email = LEGACY_WORKOUT_OWNER_EMAIL) => {
  const matches = await User.find(
    { 'profile.email': new RegExp(`^${escapeRegex(String(email).trim())}$`, 'i') },
    { _id: 1, 'profile.email': 1, 'profile.name': 1, roles: 1 },
  ).lean();

  if (matches.length === 0) throw new WorkoutOwnerError(`No user has the email ${email}; stopping - nothing was written`);
  if (matches.length > 1) {
    throw new WorkoutOwnerError(
      `${matches.length} users have the email ${email} (${matches.map((u) => u._id).join(', ')}); resolve the duplicate first`,
    );
  }
  const [user] = matches;
  if (!Array.isArray(user.roles) || !user.roles.includes(ROLE_ADMIN)) {
    throw new WorkoutOwnerError(`User ${user._id} (${email}) is not an admin; stopping - nothing was written`);
  }
  return { id: user._id, email: user.profile?.email ?? email, name: user.profile?.name ?? null, roles: user.roles };
};

/** The migrated fields as plain comparable values, for verification. */
export const comparable = (w) => ({
  name: w.name ?? null,
  type: w.type ?? null,
  equipment: w.equipment ?? null,
  primaryMuscle: w.primaryMuscle ?? null,
  secondaryMuscle: w.secondaryMuscle ?? null,
  level: w.level ?? null,
  description: w.description ?? null,
  youtubeUrl: w.youtubeUrl ?? null,
  status: w.status ?? null,
});

export const diffFields = (a, b) => {
  const left = comparable(a);
  const right = comparable(b);
  return Object.keys(left).filter((k) => left[k] !== right[k]);
};

export const loadWorkouts = async (
  rows,
  { ownerId, dryRun = true, source = migrationEnv.source, runId = null, version = migrationEnv.version } = {},
) => {
  if (!ownerId) throw new WorkoutOwnerError('ownerId is required: resolve the workout owner first');

  const summary = {
    legacyRows: rows.length,
    eligible: 0,
    toCreate: 0,
    created: 0,
    alreadyMigrated: 0,
    invalid: [],
    duplicateSourceIds: [],
    errors: [],
    counts: { active: 0, archived: 0 },
    byType: {},
    byEquipment: {},
    byLevel: {},
    withLegacyVideo: 0,
    withLegacyThumbnail: 0,
    withYoutube: 0,
    /** legacy workout_id -> the media filenames, for the separate media pass. */
    mediaMap: [],
    idMap: [],
  };

  const seen = new Set();

  for (const row of rows) {
    const t = transformLegacyWorkout(row, { source });
    const ref = { workoutId: t.workoutId ?? row.workout_id, name: t.name ?? row.workout_name ?? null };

    if (t.workoutId !== null && seen.has(t.workoutId)) {
      summary.duplicateSourceIds.push({ ...ref, reason: 'duplicate workout_id in the source rows' });
      continue;
    }
    if (t.workoutId !== null) seen.add(t.workoutId);

    if (t.problems.length > 0) {
      summary.invalid.push({ ...ref, reason: t.problems.join('; ') });
      continue;
    }

    const { workout } = t;
    summary.eligible += 1;
    summary.counts[workout.status] += 1;
    summary.byType[workout.type] = (summary.byType[workout.type] ?? 0) + 1;
    summary.byEquipment[workout.equipment] = (summary.byEquipment[workout.equipment] ?? 0) + 1;
    summary.byLevel[workout.level] = (summary.byLevel[workout.level] ?? 0) + 1;
    if (t.legacyVideoFileName) summary.withLegacyVideo += 1;
    if (t.legacyThumbnailFileName) summary.withLegacyThumbnail += 1;
    if (workout.youtubeUrl) summary.withYoutube += 1;

    try {
      const existing = await Workout.findOne(
        { 'legacy.source': source, 'legacy.workoutId': t.workoutId },
        { _id: 1 },
      ).lean();

      if (existing) {
        summary.alreadyMigrated += 1;
        summary.idMap.push({ workoutId: t.workoutId, name: workout.name, mongoId: String(existing._id), action: 'already migrated' });
        summary.mediaMap.push({ workoutId: t.workoutId, mongoId: String(existing._id), video: t.legacyVideoFileName, thumbnail: t.legacyThumbnailFileName });
        continue;
      }

      summary.toCreate += 1;
      let id = null;
      if (!dryRun) {
        const created = await Workout.create({
          ...workout,
          archivedAt: workout.status === 'archived' ? new Date() : null,
          archivedBy: null,
          createdBy: ownerId,
          updatedBy: ownerId,
          migration: { runId, migratedAt: new Date(), version },
        });
        await Workout.collection.updateOne(
          { _id: created._id },
          { $set: { 'migration.migratedAt': created.updatedAt } },
        );
        summary.created += 1;
        id = String(created._id);
      }
      summary.idMap.push({ workoutId: t.workoutId, name: workout.name, mongoId: id, action: dryRun ? 'would create' : 'created' });
      summary.mediaMap.push({ workoutId: t.workoutId, mongoId: id, video: t.legacyVideoFileName, thumbnail: t.legacyThumbnailFileName });
    } catch (error) {
      if (error?.code === 11000) {
        summary.errors.push({ ...ref, reason: `legacy workout_id ${t.workoutId} already exists (unique index)` });
      } else {
        summary.errors.push({ ...ref, reason: error.message });
      }
    }
  }

  return summary;
};

/**
 * Independent re-read of MongoDB after a run. Re-derives what should be there
 * from the legacy rows rather than trusting the loader's counters.
 */
export const verifyWorkouts = async (rows, { source = migrationEnv.source, ownerId = null } = {}) => {
  const eligible = new Map();
  for (const row of rows) {
    const t = transformLegacyWorkout(row, { source });
    if (t.problems.length > 0 || t.workoutId === null) continue;
    if (!eligible.has(t.workoutId)) eligible.set(t.workoutId, t.workout);
  }

  const docs = await Workout.find({ 'legacy.source': source }).lean();

  const byLegacy = new Map();
  const duplicateLegacyIds = [];
  for (const d of docs) {
    const id = d.legacy?.workoutId;
    if (byLegacy.has(id)) duplicateLegacyIds.push(id);
    else byLegacy.set(id, d);
  }

  const missing = [...eligible.keys()].filter((id) => !byLegacy.has(id));
  const notEligible = [...byLegacy.keys()].filter((id) => !eligible.has(id));

  const problems = [];
  for (const d of docs) {
    const where = `legacy ${d.legacy?.workoutId} (mongo ${d._id})`;
    if (typeof d.legacy?.workoutId !== 'number') problems.push(`${where}: legacy.workoutId missing`);
    if (!d.name?.trim()) problems.push(`${where}: name is empty`);
    if (!d.description?.trim()) problems.push(`${where}: description is empty`);
    if (!d.primaryMuscle?.trim()) problems.push(`${where}: primaryMuscle is empty`);
    if (!d.createdBy) problems.push(`${where}: createdBy missing`);
    if (!d.updatedBy) problems.push(`${where}: updatedBy missing`);
    if (ownerId && String(d.createdBy) !== String(ownerId)) problems.push(`${where}: createdBy is ${d.createdBy}, expected ${ownerId}`);
    // Nothing of the legacy system may have come along except the id.
    const extraLegacy = Object.keys(d.legacy ?? {}).filter((k) => !['source', 'workoutId'].includes(k));
    if (extraLegacy.length > 0) problems.push(`${where}: legacy carries extra fields: ${extraLegacy.join(', ')}`);
    // Media is copied by its own pass; a migrated workout must never claim one it does not have.
    if (d.video && !d.video.storageKey) problems.push(`${where}: video has no storageKey`);
    if (d.thumbnail && !d.thumbnail.storageKey) problems.push(`${where}: thumbnail has no storageKey`);
  }

  const mismatches = [];
  for (const [workoutId, expected] of eligible) {
    const doc = byLegacy.get(workoutId);
    if (!doc) continue;
    const fields = diffFields(doc, expected);
    if (fields.length > 0) mismatches.push({ workoutId, fields });
  }

  const portalWorkoutsWithLegacy = await Workout.countDocuments({
    legacy: { $exists: true },
    'legacy.source': { $ne: source },
  });

  return {
    eligibleCount: eligible.size,
    migratedInMongo: docs.length,
    duplicateLegacyIds,
    missing,
    notEligible,
    problems,
    mismatches,
    portalWorkoutsWithLegacy,
    archived: docs.filter((d) => d.status === 'archived').length,
    withoutMedia: docs.filter((d) => !d.video && !d.thumbnail).length,
  };
};
