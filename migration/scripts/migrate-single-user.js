/**
 * Migrates named legacy users, by legacy user_id or phone number, into MongoDB.
 *
 *   node migration/scripts/migrate-single-user.js --id 8853               # dry run
 *   node migration/scripts/migrate-single-user.js --id 8853 --apply       # write
 *   node migration/scripts/migrate-single-user.js --id 8853,1005          # several
 *   node migration/scripts/migrate-single-user.js --phone 9900298489      # by phone
 *
 * Why this exists alongside migrate-users.js: that script walks the whole
 * table by keyset from user_id 0, so `--limit` cannot reach a high id without
 * dragging in everyone below it. Against production that is thousands of
 * accounts nobody asked for. This one reads only the rows named on the command
 * line.
 *
 * Nothing else is different. Same read-only MariaDB layer, same transformer,
 * same validator, same loaders, same (legacy.source, legacy.userId) identity,
 * so a user brought over this way is indistinguishable from one the full run
 * produced. It runs the same follow-ups the full migration does — email, email
 * verification and fitness profile — scoped to the named users.
 *
 * Dry run is the default. Nothing is ever written to MariaDB.
 */
import crypto from 'node:crypto';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import User from '../../src/models/user.model.js';
import { closePool, query } from '../config/mariadb.js';
import { assertMigrationEnv, describeMysqlTarget, migrationEnv } from '../config/migration.env.js';
import { resolveSelectableColumns, resolveFitnessColumns } from '../extractors/user.extractor.js';
import { transformLegacyUser } from '../transformers/user.transformer.js';
import { transformLegacyPhone } from '../transformers/phone.transformer.js';
import { tryNormalizePhone } from '../../src/utils/phone.js';
import { validateBatch } from '../validators/migration.validator.js';
import { loadUsers } from '../loaders/user.loader.js';
import { backfillUserEmails } from '../loaders/user-email.loader.js';
import { backfillFitnessProfiles } from '../loaders/fitness-profile.loader.js';

export const parseArgs = (argv) => {
  const args = { apply: false, ids: [], phones: [] };

  const list = (value) =>
    String(value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--id' || arg === '--legacy-id') {
      args.ids.push(...list(argv[++index]).map((value) => Number.parseInt(value, 10)));
    } else if (arg === '--phone') {
      args.phones.push(...list(argv[++index]));
    }
  }

  args.ids = args.ids.filter((id) => Number.isInteger(id) && id > 0);
  return args;
};

/**
 * Resolves phone numbers to legacy user_ids.
 *
 * The candidate read is a suffix match, because legacy rows store the number
 * however it was typed; the decision is then made by normalizing each candidate
 * through the same rule login and the migration use, and comparing. A row is
 * only accepted when its normalized identity equals the normalized input, so a
 * near-miss is reported rather than migrated.
 */
export const resolveIdsByPhone = async (phones) => {
  const wanted = new Map();
  const unusable = [];

  for (const phone of phones) {
    const normalized = tryNormalizePhone(phone);
    if (!normalized.ok) unusable.push({ phone, reason: normalized.reason });
    else wanted.set(normalized.normalized, phone);
  }

  if (wanted.size === 0) return { ids: [], matched: [], unmatched: phones, unusable };

  // One placeholder per number; the SQL shape is fixed, the values are bound.
  const suffixes = [...wanted.keys()].map((normalized) => `%${normalized.slice(-10)}`);
  const rows = await query(
    `SELECT user_id, phone_number FROM ?? WHERE ${suffixes.map(() => 'phone_number LIKE ?').join(' OR ')}`,
    [migrationEnv.userTable, ...suffixes],
  );

  const matched = [];
  for (const row of rows) {
    const normalized = transformLegacyPhone(row.phone_number);
    if (normalized.ok && wanted.has(normalized.normalized)) {
      matched.push({
        legacyUserId: Number(row.user_id),
        input: wanted.get(normalized.normalized),
        normalized: normalized.normalized,
        raw: row.phone_number,
      });
    }
  }

  const hit = new Set(matched.map((entry) => entry.normalized));
  const unmatched = [...wanted.entries()]
    .filter(([normalized]) => !hit.has(normalized))
    .map(([, input]) => input);

  return { ids: matched.map((entry) => entry.legacyUserId), matched, unmatched, unusable };
};

/** The named rows, and nothing else. Read-only, parameterized, same guard. */
const extractByIds = async (ids) => {
  const { selected } = await resolveSelectableColumns();
  return query(
    'SELECT ?? FROM ?? WHERE user_id IN (?) ORDER BY user_id ASC',
    [selected, migrationEnv.userTable, ids],
  );
};

/** What the new system will hold, printed before anything is written. */
const describeRow = (row) => {
  const phone = transformLegacyPhone(row.phone_number);
  const name = [row.first_name, row.last_name]
    .filter((part) => part !== null && part !== undefined && String(part).trim() !== '')
    .map((part) => String(part).trim())
    .join(' ');

  return [
    `  #${row.user_id}  ${name || '(no name)'}`,
    `      phone   : ${row.phone_number ?? '-'} -> ${phone.ok ? phone.normalized : `REJECTED (${phone.reason})`}`,
    `      email   : ${row.email_id ?? '-'}`,
    `      city    : ${row.city_name ?? '-'}`,
    `      dob     : ${row.dob ?? '-'}   gender: ${row.gender ?? '-'}`,
    `      fitness : height=${row.height ?? '-'} weight=${row.weight ?? '-'} fat=${row.fat ?? '-'} bmr=${row.bmr ?? '-'} tdee=${row.tdee ?? '-'}`,
  ].join('\n');
};

export const migrateSingleUsers = async ({ ids, apply = false } = {}) => {
  const dryRun = !apply;
  const runId = `single-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;

  logger.info(
    `Targeted migration ${runId} (${dryRun ? 'DRY RUN' : 'APPLY'}) from ${describeMysqlTarget()} [read-only]`,
  );
  logger.info(`legacy.source will be recorded as "${migrationEnv.source}"`);

  const rows = await extractByIds(ids);
  const found = new Set(rows.map((row) => Number(row.user_id)));
  const missing = ids.filter((id) => !found.has(id));

  logger.info(`\nLegacy rows read (${rows.length}/${ids.length}):\n${rows.map(describeRow).join('\n')}`);
  if (missing.length > 0) {
    logger.warn(`Not present in ${migrationEnv.mysql.database}: ${missing.join(', ')}`);
  }
  if (rows.length === 0) return { runId, dryRun, inserted: 0, rows: 0 };

  const transformed = rows.map((row) => transformLegacyUser(row));

  // A row the full migration would have parked as a conflict is parked here
  // too: no phone, no login identity, nothing to insert.
  const usable = transformed.filter((user) => user.phone.ok);
  for (const user of transformed) {
    if (!user.phone.ok) {
      logger.warn(`#${user.legacyUserId} has no usable phone (${user.phone.reason}) — skipped, as the full run would`);
    }
  }

  // All-or-nothing, exactly as the full run treats it: a bad record aborts the
  // batch rather than being quietly dropped from it.
  const validation = validateBatch(usable, { source: migrationEnv.source });
  if (!validation.valid) {
    for (const entry of validation.invalid) {
      logger.error(`#${entry.legacyUserId} failed validation: ${entry.errors.join('; ')}`);
    }
    for (const duplicate of validation.duplicateWithinBatch) {
      logger.error(`duplicate phone ${duplicate.phone} within this batch: ${duplicate.legacyUserIds.join(', ')}`);
    }
    logger.error('Nothing was written.');
    return { runId, dryRun, rows: rows.length, inserted: 0 };
  }
  if (usable.length === 0) return { runId, dryRun, inserted: 0, rows: rows.length };

  // Already there? Say so with the document, so a legacy id that collided with
  // a different account is visible rather than reported as a quiet skip.
  const existing = await User.find({
    'legacy.source': migrationEnv.source,
    'legacy.userId': { $in: usable.map((user) => user.legacyUserId) },
  })
    .select('_id phone.normalized profile.name legacy.userId')
    .lean();

  for (const user of existing) {
    logger.warn(
      `#${user.legacy.userId} is already in MongoDB as ${user._id} ` +
        `("${user.profile?.name ?? '-'}", ${user.phone?.normalized ?? '-'}) — it will not be re-inserted`,
    );
  }

  const load = await loadUsers(usable, { runId, dryRun });
  logger.info(
    `\nUsers: ${dryRun ? 'would insert' : 'inserted'} ${load.inserted}, ` +
      `already migrated ${load.skippedAlreadyMigrated}, phone collision ${load.skippedDuplicatePhone}` +
      (load.failed.length > 0 ? `, failed ${load.failed.length}` : ''),
  );
  for (const failure of load.failed) logger.error(`  #${failure.legacyUserId}: ${failure.reason}`);

  // The same follow-ups the full migration runs, scoped to these rows only.
  const emails = await backfillUserEmails(
    rows.map((row) => ({ legacyUserId: Number(row.user_id), rawEmail: row.email_id })),
    { dryRun },
  );
  logger.info(
    `Email: ${dryRun ? 'would write' : 'wrote'} ${dryRun ? emails.toAdd : emails.updated}` +
      `, already matching ${emails.alreadyMatching}, conflicts ${emails.conflicts.length}`,
  );

  const { available } = await resolveFitnessColumns();
  const fitness = await backfillFitnessProfiles(
    rows.map((row) => ({
      legacyUserId: Number(row.user_id),
      height: row.height ?? null,
      weight: row.weight ?? null,
      fat: row.fat ?? null,
      bmr: row.bmr ?? null,
      tdee: row.tdee ?? null,
    })),
    { dryRun },
  );
  logger.info(
    `Fitness (${available.join(', ')}): ${dryRun ? 'would write' : 'wrote'} ` +
      `${dryRun ? fitness.toWrite : fitness.updated}, matched ${fitness.matched}`,
  );

  if (dryRun) {
    logger.info('\nDRY RUN — nothing was written. Re-run with --apply to write.');
  }

  return { runId, dryRun, rows: rows.length, inserted: load.inserted };
};

const run = async () => {
  const { apply, ids, phones } = parseArgs(process.argv.slice(2));

  if (ids.length === 0 && phones.length === 0) {
    throw new Error(
      'Usage: migrate-single-user.js [--id <legacy user_id>[,...]] [--phone <number>[,...]] [--apply]',
    );
  }

  // The production rail applies here exactly as it does to the full run.
  assertMigrationEnv();
  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const resolved = phones.length > 0 ? await resolveIdsByPhone(phones) : null;

    if (resolved) {
      for (const entry of resolved.matched) {
        logger.info(
          `${entry.input} -> ${entry.normalized} -> legacy #${entry.legacyUserId} (stored as "${entry.raw}")`,
        );
      }
      for (const entry of resolved.unusable) {
        logger.error(`${entry.phone} is not a usable phone number (${entry.reason})`);
      }
      if (resolved.unmatched.length > 0) {
        logger.warn(`No legacy row in ${migrationEnv.mysql.database} for: ${resolved.unmatched.join(', ')}`);
      }
    }

    // A number that resolves to a row already named by --id is migrated once.
    const all = [...new Set([...ids, ...(resolved?.ids ?? [])])];
    if (all.length === 0) {
      logger.error('Nothing to migrate: no legacy row matched.');
      return;
    }

    await migrateSingleUsers({ ids: all, apply });
  } finally {
    await mongoose.disconnect();
    await closePool();
  }
};

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('migrate-single-user.js');
if (invokedDirectly) {
  run().catch((error) => {
    logger.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export default migrateSingleUsers;
