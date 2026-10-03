import {
  WORKOUT_EQUIPMENT,
  WORKOUT_TYPES,
  parseWorkoutLevel,
} from '../../src/models/workout.model.js';

/**
 * Pure transform: one m_workout row -> Workout fields, or the reasons it cannot
 * be migrated. Nothing is repaired and nothing is guessed - a row that does not
 * map cleanly is reported by workout_id and left behind.
 *
 * Legacy values are preserved exactly, including the misspelling
 * "Pair of Dumbells" and muscle names that carry a training phase
 * ("Back (Cool Down)"). The one deliberate conversion is the level, which goes
 * from the text "LEVEL 3" to the number 3.
 */

const text = (value) => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  // Legacy writes the four characters "null" when the form posted nothing,
  // because the insert concatenates a null string into quotes.
  if (s === '' || s.toLowerCase() === 'null') return null;
  return s;
};

const toInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
};

/** Legacy delete_flg = 1 means the row was flagged outside the application. */
export const isDeleted = (value) => String(value ?? '').trim() === '1';

export const transformLegacyWorkout = (row, { source }) => {
  const problems = [];

  const workoutId = toInt(row.workout_id);
  if (workoutId === null) problems.push('workout_id is not an integer');

  const name = text(row.workout_name);
  if (name === null) problems.push('workout_name is empty');

  const type = text(row.workout_type);
  if (type === null || !WORKOUT_TYPES.includes(type)) {
    problems.push(`workout_type "${row.workout_type}" is not one of ${WORKOUT_TYPES.join(', ')}`);
  }

  const equipment = text(row.equipment);
  if (equipment === null || !WORKOUT_EQUIPMENT.includes(equipment)) {
    problems.push(`equipment "${row.equipment}" is not one of ${WORKOUT_EQUIPMENT.join(', ')}`);
  }

  const primaryMuscle = text(row.primary_muscle);
  if (primaryMuscle === null) problems.push('primary_muscle is empty');

  const level = parseWorkoutLevel(row.workout_level);
  if (level === null) problems.push(`workout_level "${row.workout_level}" is not LEVEL 1-5`);

  const description = text(row.description);
  if (description === null) problems.push('description is empty');

  const deleted = isDeleted(row.delete_flg);

  return {
    workoutId,
    name,
    deleted,
    problems,
    /** Filenames, for the media pass and for reporting. Never written to the document. */
    legacyVideoFileName: text(row.video_file_name),
    legacyThumbnailFileName: text(row.thumbnail_file_name),
    workout: {
      name,
      type: type && WORKOUT_TYPES.includes(type) ? type : null,
      equipment: equipment && WORKOUT_EQUIPMENT.includes(equipment) ? equipment : null,
      primaryMuscle,
      secondaryMuscle: text(row.secondary_muscle),
      level,
      description,
      youtubeUrl: text(row.youtube_link),
      // A filename is not a stored file. Media is copied by its own pass; until
      // then a migrated workout has none rather than a fabricated reference.
      video: null,
      thumbnail: null,
      // delete_flg = 1 finally means something: the row is kept but hidden.
      status: deleted ? 'archived' : 'active',
      legacy: { source, workoutId },
    },
  };
};

export default transformLegacyWorkout;
