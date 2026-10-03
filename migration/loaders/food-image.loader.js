import env from '../../src/config/env.js';
import Food from '../../src/models/food.model.js';
import { assertValidImage } from '../../src/utils/image.js';
import { foodImageFolder, getStorage } from '../../src/services/storage/index.js';
import { migrationEnv } from '../config/migration.env.js';

/**
 * Legacy food pictures -> this system's own storage, one file per migrated Food.
 *
 * The legacy database only held a filename, so the bytes are fetched over HTTP
 * from the legacy admin's image folder, validated by their real signature (the
 * filename is never trusted), stored through the same storage driver the coach
 * pictures and the Add Food upload use, and recorded on the Food as
 * { url, storageKey }.
 *
 * The point of copying rather than linking: once this has run, the new system
 * serves every food picture itself and the legacy server can be switched off.
 *
 * Rules:
 *   - a filename is never written into image.url - a food only gets an image
 *     when its actual bytes were fetched, validated and stored;
 *   - without `replace`, a Food that already has an image is left alone, so a
 *     re-run changes nothing and an admin's own upload is never overwritten;
 *   - a legacy food that was not migrated gets nothing - this never creates a Food;
 *   - anything unreachable, not a real image, or over the size limit is reported
 *     by legacy food_id with the reason, never guessed at.
 *
 * Only `image` is written. Nutrition, legacy identity and the migration stamp
 * are not part of any write here.
 */

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 30_000;

/** HEAD only: lets the dry run prove a file exists without downloading it. */
export const probeImage = async (url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
  return {
    ok: response.ok,
    status: response.status,
    bytes: Number(response.headers.get('content-length') ?? 0),
    contentType: response.headers.get('content-type'),
  };
};

const fetchImage = async (url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
};

/** Runs [task] over [items] across a fixed number of lanes. */
const inLanes = async (items, lanes, task) => {
  const queues = Array.from({ length: lanes }, (_, lane) => items.filter((_, index) => index % lanes === lane));
  await Promise.all(queues.map(async (queue) => {
    for (const item of queue) await task(item);
  }));
};

/** True for an image this system stores, as opposed to one served elsewhere. */
const isStored = (image) => Boolean(image?.storageKey);

export const loadFoodImages = async (
  rows,
  {
    dryRun = true,
    source = migrationEnv.source,
    baseUrl = migrationEnv.legacyImageBaseUrl,
    maxBytes = env.storage.maxUploadBytes,
    concurrency = DEFAULT_CONCURRENCY,
    adminId = null,
    /** Fetch and store even where the Food already points at an image. */
    replace = false,
  } = {},
) => {
  const summary = {
    legacyRows: rows.length,
    notMigrated: [],
    alreadyStored: [],
    toStore: 0,
    stored: 0,
    replacedLinks: 0,
    skippedUnreachable: [],
    skippedInvalid: [],
    skippedTooLarge: [],
    errors: [],
    bytesTransferred: 0,
    largestBytes: 0,
    byType: {},
  };

  const legacyIds = rows.map((row) => Number(row.food_id)).filter(Number.isInteger);
  const docs = await Food.find(
    { 'legacy.source': source, 'legacy.foodId': { $in: legacyIds } },
    { _id: 1, image: 1, legacy: 1 },
  ).lean();
  const byLegacyId = new Map(docs.map((doc) => [doc.legacy.foodId, doc]));

  const storage = getStorage();

  await inLanes(rows, Math.max(1, concurrency), async (row) => {
    const foodId = Number(row.food_id);
    const ref = { foodId, name: row.food_name ?? null, file: row.image_file_name };
    const doc = byLegacyId.get(foodId);

    if (!doc) {
      summary.notMigrated.push({ ...ref, reason: 'no migrated Food carries this legacy food_id' });
      return;
    }
    // A picture already held in this system's storage is finished work. An
    // external link is not, so it is replaced by a stored copy.
    if (isStored(doc.image) && !replace) {
      summary.alreadyStored.push({ ...ref, mongoId: String(doc._id) });
      return;
    }

    const url = `${baseUrl}${encodeURIComponent(row.image_file_name)}`;

    try {
      if (dryRun) {
        const probe = await probeImage(url);
        if (!probe.ok) {
          summary.skippedUnreachable.push({ ...ref, reason: `HTTP ${probe.status}` });
          return;
        }
        if (probe.bytes > maxBytes) {
          summary.skippedTooLarge.push({ ...ref, reason: `${probe.bytes} bytes exceeds the ${maxBytes} byte limit` });
          return;
        }
        summary.toStore += 1;
        if (doc.image?.url && !isStored(doc.image)) summary.replacedLinks += 1;
        summary.bytesTransferred += probe.bytes;
        summary.largestBytes = Math.max(summary.largestBytes, probe.bytes);
        const type = (probe.contentType ?? 'unknown').split(';')[0];
        summary.byType[type] = (summary.byType[type] ?? 0) + 1;
        return;
      }

      const buffer = await fetchImage(url);

      // The bytes decide the type, exactly as they do for an admin upload: a
      // file named .png whose content is not an image is refused.
      let type;
      try {
        type = assertValidImage(buffer, { maxBytes });
      } catch (error) {
        const bucket = error.code === 'FILE_TOO_LARGE' ? summary.skippedTooLarge : summary.skippedInvalid;
        bucket.push({ ...ref, reason: `${error.message} (${buffer.length} bytes)` });
        return;
      }

      const storedUrl = await storage.save(buffer, {
        folder: foodImageFolder(doc._id),
        extension: type.extension,
      });
      const image = { url: storedUrl, storageKey: storage.keyFor(storedUrl) };

      const result = await Food.collection.updateOne(
        { _id: doc._id },
        { $set: { image, updatedAt: new Date(), ...(adminId ? { updatedBy: adminId } : {}) } },
      );

      if (result.matchedCount === 1) {
        summary.stored += 1;
        summary.toStore += 1;
        if (doc.image?.url && !isStored(doc.image)) summary.replacedLinks += 1;
        summary.bytesTransferred += buffer.length;
        summary.largestBytes = Math.max(summary.largestBytes, buffer.length);
        summary.byType[type.mimeType] = (summary.byType[type.mimeType] ?? 0) + 1;

        // A file this system stored earlier for the same food is now orphaned.
        // An external link has no storageKey, so there is nothing of ours to remove.
        if (isStored(doc.image) && doc.image.url !== storedUrl) {
          await storage.remove(doc.image.url).catch(() => {});
        }
      }
    } catch (error) {
      if (error.status) summary.skippedUnreachable.push({ ...ref, reason: `HTTP ${error.status}` });
      else summary.errors.push({ ...ref, reason: error.message });
    }
  });

  return summary;
};

/**
 * Independent re-read of MongoDB once the run is over. Every image must be a
 * file this system stores: an absolute URL under the storage path with a
 * storage key, not a legacy link and never a bare filename.
 */
export const verifyFoodImages = async ({ source = migrationEnv.source } = {}) => {
  const [withImage, withoutImage, total] = await Promise.all([
    Food.countDocuments({ 'legacy.source': source, 'image.url': { $exists: true, $ne: null } }),
    Food.countDocuments({ 'legacy.source': source, $or: [{ image: null }, { image: { $exists: false } }] }),
    Food.countDocuments({ 'legacy.source': source }),
  ]);

  const docs = await Food.find(
    { 'legacy.source': source, 'image.url': { $exists: true, $ne: null } },
    { image: 1, legacy: 1 },
  ).lean();

  const problems = [];
  const urls = new Map();
  for (const doc of docs) {
    const where = `legacy ${doc.legacy?.foodId} (mongo ${doc._id})`;
    const url = String(doc.image.url);

    if (!doc.image.storageKey) problems.push(`${where}: image.storageKey missing - not a stored file`);
    if (!url.includes(`${env.storage.publicPath}/`)) problems.push(`${where}: image.url is not served from this system: ${url}`);
    // Two foods sharing one stored file would mean deleting one deletes the other's.
    const seen = urls.get(url);
    if (seen) problems.push(`${where}: shares a stored file with legacy ${seen}`);
    else urls.set(url, doc.legacy?.foodId);
  }

  return { total, withImage, withoutImage, stillLinked: docs.filter((d) => !d.image.storageKey).length, problems };
};
