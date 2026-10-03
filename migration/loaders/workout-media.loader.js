import env from '../../src/config/env.js';
import Workout from '../../src/models/workout.model.js';
import { assertValidImage } from '../../src/utils/image.js';
import { assertValidVideo } from '../../src/utils/video.js';
import { getStorage, workoutThumbnailFolder, workoutVideoFolder } from '../../src/services/storage/index.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Legacy workout media -> this system's own storage, for a deliberately small
 * sample of workouts.
 *
 * The complete legacy media set is roughly 1 GB (188 videos at 2-8 MB each),
 * which the development environment has no reason to hold. This copies a fixed,
 * named handful so the whole pipeline - legacy file, storage, media.url,
 * media.storageKey, portal thumbnail, edit screen, replacement - can be
 * exercised end to end with real files.
 *
 * Every other migrated workout keeps `video: null` and `thumbnail: null`. A
 * filename is never written into a media reference, and a legacy host URL is
 * never stored, so "no media" always means exactly that.
 */

/**
 * The sample, fixed in source so every run copies the same files.
 *
 * Chosen for coverage rather than at random, from workouts whose files were
 * confirmed to exist:
 *   10 - General, 4.6 MB video, PNG thumbnail
 *   16 - Gym,     3.7 MB video, JPEG thumbnail
 *   24 - General, 7.8 MB video (over the 5 MB image limit, so it exercises the
 *                 separate video limit), JPEG thumbnail
 */
export const DEFAULT_MEDIA_SAMPLE = [10, 16, 24];

/** The two media slots, so a run can copy one kind without the other. */
export const MEDIA_SLOTS = ['video', 'thumbnail'];

const DEFAULT_TIMEOUT_MS = 60_000;

const fetchFile = async (url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
};

/** The two slots, each with its own legacy folder, validator, limit and storage folder. */
const SLOTS = {
  video: {
    legacyFolder: 'Video',
    storageFolder: workoutVideoFolder,
    validate: (buffer) => assertValidVideo(buffer, { maxBytes: env.storage.maxVideoUploadBytes }),
  },
  thumbnail: {
    legacyFolder: 'Thumbnail',
    storageFolder: workoutThumbnailFolder,
    validate: (buffer) => assertValidImage(buffer, { maxBytes: env.storage.maxUploadBytes }),
  },
};

/**
 * @param rows legacy m_workout rows (workout_id + the two filenames)
 * @param workoutIds the sample to copy; everything else is left untouched
 */
export const loadWorkoutMedia = async (
  rows,
  {
    dryRun = true,
    source = migrationEnv.source,
    baseUrl = migrationEnv.legacyWorkoutMediaBaseUrl,
    /** A list of legacy workout ids, or 'all' for every migrated workout. */
    workoutIds = DEFAULT_MEDIA_SAMPLE,
    /** Which slots to copy. Thumbnails alone are a few MB; videos are ~1 GB. */
    slots = MEDIA_SLOTS,
    replace = false,
  } = {},
) => {
  const everything = workoutIds === 'all';
  const wanted = everything
    ? new Set(rows.map((row) => Number(row.workout_id)))
    : new Set(workoutIds.map(Number));
  const wantedSlots = MEDIA_SLOTS.filter((slot) => slots.includes(slot));

  const summary = {
    sample: everything ? 'all' : [...wanted],
    slots: wantedSlots,
    requested: wanted.size,
    notInLegacy: [],
    notMigrated: [],
    selected: [],
    videosCopied: 0,
    thumbnailsCopied: 0,
    alreadyHadMedia: [],
    skippedNoFilename: [],
    unreachable: [],
    invalid: [],
    errors: [],
    bytesTransferred: 0,
  };

  const byLegacyId = new Map(rows.map((row) => [Number(row.workout_id), row]));
  if (!everything) for (const id of wanted) if (!byLegacyId.has(id)) summary.notInLegacy.push(id);

  const docs = await Workout.find(
    { 'legacy.source': source, 'legacy.workoutId': { $in: [...wanted] } },
    { _id: 1, name: 1, legacy: 1, video: 1, thumbnail: 1 },
  ).lean();
  const docByLegacyId = new Map(docs.map((d) => [d.legacy.workoutId, d]));

  const storage = getStorage();

  // Sorted, so the run is reproducible down to the order files are written.
  for (const legacyId of [...wanted].sort((a, b) => a - b)) {
    const row = byLegacyId.get(legacyId);
    if (!row) continue;

    const doc = docByLegacyId.get(legacyId);
    if (!doc) {
      summary.notMigrated.push({ workoutId: legacyId, reason: 'no migrated Workout carries this legacy workout_id' });
      continue;
    }

    const entry = { workoutId: legacyId, name: doc.name, mongoId: String(doc._id), video: null, thumbnail: null };

    for (const slot of wantedSlots) {
      const config = SLOTS[slot];
      const fileName = String(row[slot === 'video' ? 'video_file_name' : 'thumbnail_file_name'] ?? '').trim();
      if (fileName === '' || fileName.toLowerCase() === 'null') {
        summary.skippedNoFilename.push({ workoutId: legacyId, slot });
        entry[slot] = 'no legacy filename';
        continue;
      }
      if (doc[slot]?.url && !replace) {
        summary.alreadyHadMedia.push({ workoutId: legacyId, slot });
        entry[slot] = 'already stored';
        continue;
      }

      const url = `${baseUrl}${config.legacyFolder}/${encodeURIComponent(fileName)}`;

      try {
        if (dryRun) {
          const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
          if (!head.ok) {
            summary.unreachable.push({ workoutId: legacyId, slot, reason: `HTTP ${head.status}` });
            entry[slot] = `unreachable (${head.status})`;
            continue;
          }
          const bytes = Number(head.headers.get('content-length') ?? 0);
          summary.bytesTransferred += bytes;
          entry[slot] = `would copy (${(bytes / 1048576).toFixed(1)} MB, ${head.headers.get('content-type')})`;
          if (slot === 'video') summary.videosCopied += 1;
          else summary.thumbnailsCopied += 1;
          continue;
        }

        const buffer = await fetchFile(url);

        // The bytes decide the type, exactly as they do for an admin upload.
        let type;
        try {
          type = config.validate(buffer);
        } catch (error) {
          summary.invalid.push({ workoutId: legacyId, slot, reason: `${error.message} (${buffer.length} bytes)` });
          entry[slot] = `invalid: ${error.message}`;
          continue;
        }

        const storedUrl = await storage.save(buffer, {
          folder: config.storageFolder(doc._id),
          extension: type.extension,
        });
        const media = { url: storedUrl, storageKey: storage.keyFor(storedUrl) };

        await Workout.collection.updateOne({ _id: doc._id }, { $set: { [slot]: media, updatedAt: new Date() } });

        // A file this system stored before for the same slot is now orphaned.
        if (doc[slot]?.storageKey && doc[slot].url !== storedUrl) {
          await storage.remove(doc[slot].url).catch(() => {});
        }

        summary.bytesTransferred += buffer.length;
        if (slot === 'video') summary.videosCopied += 1;
        else summary.thumbnailsCopied += 1;
        entry[slot] = `copied (${(buffer.length / 1048576).toFixed(1)} MB) -> ${media.storageKey}`;
      } catch (error) {
        if (error.status) summary.unreachable.push({ workoutId: legacyId, slot, reason: `HTTP ${error.status}` });
        else summary.errors.push({ workoutId: legacyId, slot, reason: error.message });
        entry[slot] = `failed: ${error.message}`;
      }
    }

    if (!everything || entry.video || entry.thumbnail) summary.selected.push(entry);
  }

  return summary;
};

/**
 * Independent re-read of MongoDB. The invariant is not "every workout has
 * media" - it is that whatever media exists is a real stored file, and that
 * nothing points at the legacy host or holds a bare filename.
 */
export const verifyWorkoutMedia = async ({ source = migrationEnv.source, sample = DEFAULT_MEDIA_SAMPLE } = {}) => {
  const total = await Workout.countDocuments({ 'legacy.source': source });
  const docs = await Workout.find(
    { 'legacy.source': source, $or: [{ video: { $ne: null } }, { thumbnail: { $ne: null } }] },
    { name: 1, legacy: 1, video: 1, thumbnail: 1 },
  ).lean();

  const problems = [];
  for (const d of docs) {
    for (const slot of ['video', 'thumbnail']) {
      const media = d[slot];
      if (!media) continue;
      const where = `legacy ${d.legacy?.workoutId} ${slot}`;
      if (!media.storageKey) problems.push(`${where}: no storageKey - not a stored file`);
      if (!String(media.url).includes(`${env.storage.publicPath}/`)) {
        problems.push(`${where}: url is not served by this system: ${media.url}`);
      }
      if (/apiimages\.gogetfitonline\.com|\/WorkOut\//i.test(String(media.url))) {
        problems.push(`${where}: url points at the legacy host: ${media.url}`);
      }
    }
  }

  const withMedia = docs.map((d) => d.legacy.workoutId).sort((a, b) => a - b);
  const unexpected = Array.isArray(sample) ? withMedia.filter((id) => !sample.includes(id)) : [];

  const withVideo = docs.filter((d) => d.video).length;
  const withThumbnail = docs.filter((d) => d.thumbnail).length;

  return {
    migratedWorkouts: total,
    withAnyMedia: docs.length,
    withVideo,
    withThumbnail,
    withoutMedia: total - docs.length,
    withMedia,
    unexpected,
    problems,
  };
};
