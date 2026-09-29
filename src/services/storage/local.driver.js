import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import logger from '../../config/logger.js';

/**
 * Stores uploads on the local filesystem and serves them as static files.
 *
 * This is the development driver and the only one the project has: the
 * repository contains no object-storage integration, so nothing cloud-specific
 * is invented here. Swapping in S3/GCS means writing another module with this
 * same `save`/`remove` shape and selecting it in `index.js` - no caller
 * changes.
 */
export class LocalStorageDriver {
  constructor({ rootDirectory, publicBaseUrl, publicPath = '/uploads' }) {
    this.rootDirectory = rootDirectory;
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, '');
    this.publicPath = publicPath;
  }

  /**
   * Writes [buffer] under [folder] and returns its public URL.
   *
   * The filename is derived from the content hash, so a given image always
   * lands at the same immutable URL and a changed image always gets a new one.
   * That is what lets clients cache avatars without any cache-busting query
   * string. Nothing from the client's filename is used.
   */
  async save(buffer, { folder, extension }) {
    const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    const safeFolder = folder.replace(/[^a-z0-9/_-]/gi, '');
    const fileName = `${digest}.${extension}`;

    const directory = path.join(this.rootDirectory, safeFolder);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, fileName), buffer);

    return `${this.publicBaseUrl}${this.publicPath}/${safeFolder}/${fileName}`;
  }

  /**
   * Deletes a previously stored file. A URL this driver did not issue, or a
   * file that is already gone, is ignored rather than failing the request -
   * the user's action has already succeeded by this point.
   */
  async remove(url) {
    const relative = this.toRelativePath(url);
    if (!relative) return false;

    try {
      await fs.unlink(path.join(this.rootDirectory, relative));
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`Could not delete stored file ${relative}: ${error.message}`);
      }
      return false;
    }
  }

  /**
   * The driver-level identity of a stored file (here, its path under the
   * storage root, e.g. "coaches/<id>/cover/<hash>.jpg"). Recorded alongside the
   * URL so a future object-storage driver can address the object directly
   * instead of parsing a public URL.
   */
  keyFor(url) {
    return this.toRelativePath(url);
  }

  /** Maps a public URL back to a path inside the storage root, or null. */
  toRelativePath(url) {
    if (typeof url !== 'string' || url === '') return null;

    const marker = `${this.publicPath}/`;
    const index = url.indexOf(marker);
    if (index === -1) return null;

    const relative = url.slice(index + marker.length);

    // Refuses anything that would escape the storage root.
    const normalized = path.normalize(relative);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;

    return normalized;
  }
}

export default LocalStorageDriver;
