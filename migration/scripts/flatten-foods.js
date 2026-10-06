/**
 * Flattens every Food document in place: serving.{unit,quantity} and
 * nutrition.{calories,fat,carbs,protein} become root fields, then the nested
 * objects are removed. See migration/loaders/food-flatten.loader.js for the rules.
 *
 *   npm run migrate:flatten-foods              # dry run (baseline report, writes nothing)
 *   npm run migrate:flatten-foods -- --apply   # write, then verify field by field
 *
 * DEVELOPMENT ONLY. Before connecting it requires NODE_ENV=development and
 * refuses MIGRATION_ALLOW_PRODUCTION; after connecting it requires the expected
 * development cluster and database. The usual production-database rail
 * (assertMigrationEnv) still runs first. MariaDB is never touched.
 *
 * Idempotent: an already-flat document is skipped. Before writing, the whole
 * collection is saved as Extended JSON next to the run report, so every
 * original value can be restored.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import { assertMigrationEnv, migrationEnv } from '../config/migration.env.js';
import { flattenFoods, verifyFlattened } from '../loaders/food-flatten.loader.js';
import { writeReport } from '../reports/migration-report.js';

/** The development target. Overridable, but only towards another dev target. */
const EXPECTED_HOST = process.env.MIGRATION_DEV_MONGO_HOST || 'gogetfit-dev.';
const EXPECTED_DATABASE = process.env.MIGRATION_DEV_MONGO_DATABASE || 'gogetfit';

/** Refuses anything that is not explicitly development - before any connection. */
export const assertDevelopmentTarget = (env = process.env) => {
  if (env.NODE_ENV !== 'development') {
    throw new Error(`Refusing to flatten foods: NODE_ENV is "${env.NODE_ENV ?? ''}", not "development"`);
  }
  if (migrationEnv.allowProduction) {
    throw new Error('Refusing to flatten foods: MIGRATION_ALLOW_PRODUCTION is set; this migration is development only');
  }
};

/** The cluster host named in a MongoDB URI (the SRV name, not a shard's), without credentials. */
const uriHost = (uri) => {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(String(uri ?? ''));
  return match ? match[1] : '';
};

/**
 * Refuses a connection that is not the expected development cluster and
 * database. The cluster is read from the configured URI: the live connection
 * only reports the shard it landed on (ac-xxxx-shard-00-00...), which does not
 * carry the cluster name.
 */
export const assertDevelopmentConnection = ({ uri = process.env.MONGODB_URI, name = mongoose.connection.name } = {}) => {
  const host = uriHost(uri);
  const database = name ?? '';
  if (!host.includes(EXPECTED_HOST) || database !== EXPECTED_DATABASE) {
    throw new Error(
      `Refusing to flatten foods: connected to ${host}/${database}, expected *${EXPECTED_HOST}*/${EXPECTED_DATABASE}`,
    );
  }
  return { host, database };
};

const list = (ids) => (ids.length ? ids.slice(0, 20).join(', ') + (ids.length > 20 ? ` … (+${ids.length - 20})` : '') : 'none');

export const runFlattenFoods = async ({ apply = false, runId = null } = {}) => {
  const dryRun = !apply;
  const id = runId ?? `foods-flatten-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  const target = assertDevelopmentConnection();

  let backupFile = null;
  const { docs, baseline, summary } = await flattenFoods({
    dryRun,
    batchSize: migrationEnv.batchSize,
    // The restore point: the exact pre-migration documents, saved before the first write.
    beforeWrite: async (original) => {
      const dir = path.join(process.cwd(), 'migration', 'reports', 'runs');
      await fs.mkdir(dir, { recursive: true });
      backupFile = path.join(dir, `${id}-backup.ejson`);
      await fs.writeFile(backupFile, mongoose.mongo.BSON.EJSON.stringify(original, { relaxed: false }), 'utf8');
    },
  });

  const verify = dryRun ? null : await verifyFlattened(docs, baseline.indexes);

  const { malformed, indexes, ...counts } = baseline;
  logger.info(
    [
      '',
      '────────── FOOD FLATTEN (serving / nutrition → root fields) ──────────',
      `mode                       : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`,
      `run id                     : ${id}`,
      `target                     : ${target.host}/${target.database} (NODE_ENV=${process.env.NODE_ENV})`,
      '',
      '── baseline (read before any write) ──',
      ...Object.entries(counts).map(([k, v]) => `${k.padEnd(27)}: ${v}`),
      `malformed                  : ${malformed.length}`,
      `indexes                    : ${indexes.map((i) => i.name).join(', ')}`,
      '',
      '── plan ──',
      `${dryRun ? 'would flatten              ' : 'flattened                  '}: ${dryRun ? summary.toFlatten : summary.flattened}`,
      `skipped (already flat)     : ${summary.alreadyFlat}`,
      `root values kept over nested: ${summary.rootValuesKept}`,
      `nested values absent (left absent): ${summary.missingNestedValues}`,
      ...(verify
        ? [
            '',
            '── verification (field by field, every document) ──',
            `count                      : ${verify.countBefore} → ${verify.countAfter}`,
            `_ids missing / added       : ${list(verify.missingIds)} / ${list(verify.addedIds)}`,
            `still with serving         : ${list(verify.stillWithServing)}`,
            `still with nutrition       : ${list(verify.stillWithNutrition)}`,
            `field mismatches           : ${verify.mismatches.length}`,
            ...verify.mismatches.slice(0, 50).map((m) => `    ${m.id}: ${m.fields.join(', ')}`),
            `duplicate legacy ids       : ${list(verify.duplicateLegacy)}`,
            `indexes unchanged          : ${verify.indexesUnchanged}`,
            `max updatedAt              : ${verify.maxUpdatedAtBefore} → ${verify.maxUpdatedAtAfter}`,
            `sha256 after               : ${verify.sha256After}`,
            `RESULT                     : ${verify.ok ? 'PASS' : 'FAIL'}`,
            `backup (pre-migration)     : ${backupFile}`,
          ]
        : []),
      '──────────────────────────────────────────────────────────────────────',
    ].join('\n'),
  );

  const report = {
    runId: id,
    dryRun,
    target,
    baseline: { ...counts, malformed, indexes },
    summary,
    verify,
    backupFile,
    finishedAt: new Date().toISOString(),
  };
  const file = await writeReport(report);
  logger.info(`report: ${file}`);

  if (verify && !verify.ok) {
    throw new Error(`Food flatten verification FAILED (${verify.mismatches.length} mismatch(es)); see ${file}`);
  }
  if (summary.notMatched.length > 0) {
    throw new Error(`Food flatten stopped: ${summary.notMatched.length} document(s) changed during the run: ${list(summary.notMatched)}`);
  }
  return report;
};

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('flatten-foods.js');
if (isEntryPoint) {
  const apply = process.argv.includes('--apply');
  Promise.resolve()
    // Reads no MariaDB, but the production-database rail still applies.
    .then(() => assertMigrationEnv({ requireMysql: false }))
    .then(() => assertDevelopmentTarget())
    .then(() => mongoose.connect(process.env.MONGODB_URI))
    .then(() => runFlattenFoods({ apply }))
    .catch((error) => {
      logger.error(`Food flatten failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.connection.close().catch(() => {});
    });
}

export default runFlattenFoods;
