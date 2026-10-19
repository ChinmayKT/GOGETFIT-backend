import mongoose from 'mongoose';

import { migrationEnv } from './migration.env.js';

/**
 * Guards for migrations that may only ever write to the development database.
 * They run on top of assertMigrationEnv (the production legacy-database rail),
 * never instead of it.
 */

/** The development target. Overridable, but only towards another dev target. */
const EXPECTED_HOST = process.env.MIGRATION_DEV_MONGO_HOST || 'gogetfit-dev.';
const EXPECTED_DATABASE = process.env.MIGRATION_DEV_MONGO_DATABASE || 'gogetfit';

/** Refuses anything that is not explicitly development - before any connection. */
export const assertDevelopmentTarget = (env = process.env, label = 'run this migration') => {
  if (env.NODE_ENV !== 'development') {
    throw new Error(`Refusing to ${label}: NODE_ENV is "${env.NODE_ENV ?? ''}", not "development"`);
  }
  if (migrationEnv.allowProduction) {
    throw new Error(`Refusing to ${label}: MIGRATION_ALLOW_PRODUCTION is set; this migration is development only`);
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
export const assertDevelopmentConnection = (
  { uri = process.env.MONGODB_URI, name = mongoose.connection.name } = {},
  label = 'run this migration',
) => {
  const host = uriHost(uri);
  const database = name ?? '';
  if (!host.includes(EXPECTED_HOST) || database !== EXPECTED_DATABASE) {
    throw new Error(
      `Refusing to ${label}: connected to ${host}/${database}, expected *${EXPECTED_HOST}*/${EXPECTED_DATABASE}`,
    );
  }
  return { host, database };
};
