import User from '../../src/models/user.model.js';
import { migrationEnv } from '../config/migration.env.js';
import { transformLegacyFitness } from '../transformers/fitness.transformer.js';

/**
 * Backfills profile.fitnessProfile onto users that were already migrated.
 *
 * Matches strictly on (legacy.source, legacy.userId) - never phone, never
 * email. Creates no users and writes nothing outside profile.fitnessProfile.
 *
 * A value the member has already set is never overwritten by a legacy value:
 * that is reported as a conflict instead. Conflicts are handled per field, so
 * a field that already holds a different figure keeps it while every other
 * field still receives its legacy value - a body-fat conflict never blocks the
 * energy figures.
 *
 * Energy figures: legacy bmr lands on fitnessProfile.bmr and legacy tdee on
 * fitnessProfile.tdee. Nothing is calculated - a row without them stays null.
 */
export const backfillFitnessProfiles = async (
  legacyRows,
  { dryRun = true, source = migrationEnv.source } = {},
) => {
  const summary = {
    legacyInspected: legacyRows.length,
    matched: 0,
    missingMongoUser: [],
    withHeight: 0,
    withWeight: 0,
    withBodyFat: 0,
    withActivityLevel: 0,
    withFoodType: 0,
    withGoal: 0,
    withBmr: 0,
    withTdee: 0,
    // Legacy rows that carry a value the legacy system used for "never
    // computed": 0, or a negative figure. Both are read as missing.
    zeroTreatedAsMissing: { height: 0, weight: 0, fat: 0, bmr: 0, tdee: 0 },
    negativeTreatedAsMissing: { bmr: 0, tdee: 0 },
    toWrite: 0,
    alreadyInPlace: 0,
    conflicts: [],
    updated: 0,
    errors: [],
  };

  if (legacyRows.length === 0) return summary;

  const existing = await User.collection
    .find(
      {
        'legacy.source': source,
        'legacy.userId': { $in: legacyRows.map((row) => row.legacyUserId) },
      },
      { projection: { _id: 1, 'legacy.userId': 1, 'profile.fitnessProfile': 1 } },
    )
    .toArray();

  const byLegacyId = new Map(existing.map((user) => [user.legacy.userId, user]));
  const operations = [];

  for (const row of legacyRows) {
    const fitness = transformLegacyFitness(row);

    // Count genuine zeros separately so the report is honest about them.
    // NULL is excluded explicitly: Number(null) is 0, which would otherwise
    // report every empty row as a zero.
    for (const column of ['height', 'weight', 'fat', 'bmr', 'tdee']) {
      const raw = row[column];
      if (raw === null || raw === undefined || raw === '') continue;

      const number = Number(raw);
      if (number === 0) {
        summary.zeroTreatedAsMissing[column] += 1;
      } else if (number < 0 && summary.negativeTreatedAsMissing[column] !== undefined) {
        summary.negativeTreatedAsMissing[column] += 1;
      }
    }

    if (fitness.height !== null) summary.withHeight += 1;
    if (fitness.weight !== null) summary.withWeight += 1;
    if (fitness.bodyFatPercentage !== null) summary.withBodyFat += 1;
    if (fitness.bmr !== null) summary.withBmr += 1;
    if (fitness.tdee !== null) summary.withTdee += 1;

    const user = byLegacyId.get(row.legacyUserId);
    if (!user) {
      summary.missingMongoUser.push(row.legacyUserId);
      continue;
    }
    summary.matched += 1;

    const current = user.profile?.fitnessProfile ?? null;

    // Anything the member has already entered wins; the legacy value is
    // reported rather than written over it. Reported per field: the merge below
    // keeps the held value for exactly these fields and still fills the rest,
    // so one disagreeing field cannot hold back the others.
    const overwrites = ['height', 'weight', 'bodyFatPercentage', 'bmr', 'tdee'].filter((field) => {
      const held = current?.[field] ?? null;
      return held !== null && fitness[field] !== null && held !== fitness[field];
    });

    if (overwrites.length > 0) {
      summary.conflicts.push({
        legacyUserId: row.legacyUserId,
        userId: String(user._id),
        fields: overwrites,
        existing: Object.fromEntries(overwrites.map((field) => [field, current[field]])),
        legacy: Object.fromEntries(overwrites.map((field) => [field, fitness[field]])),
      });
    }

    // Preserve anything already set (including the three preference fields a
    // member may have filled in) and only add what is missing.
    const merged = {
      height: current?.height ?? fitness.height,
      weight: current?.weight ?? fitness.weight,
      bodyFatPercentage: current?.bodyFatPercentage ?? fitness.bodyFatPercentage,
      activityLevel: current?.activityLevel ?? null,
      foodType: current?.foodType ?? null,
      goal: current?.goal ?? null,
      // A figure already held in Mongo wins; the legacy value only fills a gap.
      bmr: current?.bmr ?? fitness.bmr,
      tdee: current?.tdee ?? fitness.tdee,
    };

    if (merged.activityLevel !== null) summary.withActivityLevel += 1;
    if (merged.foodType !== null) summary.withFoodType += 1;
    if (merged.goal !== null) summary.withGoal += 1;

    const unchanged =
      current !== null &&
      [
        'height',
        'weight',
        'bodyFatPercentage',
        'activityLevel',
        'foodType',
        'goal',
        'bmr',
        'tdee',
      ].every((field) => (current[field] ?? null) === merged[field]);

    if (unchanged) {
      summary.alreadyInPlace += 1;
      continue;
    }

    summary.toWrite += 1;
    operations.push({
      updateOne: {
        filter: { _id: user._id },
        update: { $set: { 'profile.fitnessProfile': merged } },
      },
    });
  }

  if (dryRun || operations.length === 0) return summary;

  try {
    const result = await User.collection.bulkWrite(operations, { ordered: false });
    summary.updated = result.modifiedCount ?? 0;
  } catch (error) {
    for (const writeError of error.writeErrors || []) {
      const detail = writeError.err || writeError;
      summary.errors.push(detail.errmsg || detail.message || String(writeError));
    }
    if (!error.writeErrors) throw error;
  }

  return summary;
};

export default backfillFitnessProfiles;
