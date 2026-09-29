import mysql from 'mysql2/promise';

import logger from '../../src/config/logger.js';
import { migrationEnv, describeMysqlTarget } from './migration.env.js';

let pool = null;

const READ_ONLY_STATEMENT = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;

/**
 * Hard guard: the migration may only ever read from MariaDB. Anything that is
 * not a read statement is refused before it reaches the driver, in addition to
 * the read-only transaction mode set on every pooled connection.
 */
const assertReadOnly = (sql) => {
  if (!READ_ONLY_STATEMENT.test(sql)) {
    throw new Error(`Migration attempted a non-read statement against MariaDB: ${sql.slice(0, 80)}`);
  }
};

export const getPool = () => {
  if (pool) return pool;

  pool = mysql.createPool({
    host: migrationEnv.mysql.host,
    port: migrationEnv.mysql.port,
    database: migrationEnv.mysql.database,
    user: migrationEnv.mysql.user,
    password: migrationEnv.mysql.password,
    waitForConnections: true,
    connectionLimit: 4,
    // Applies to every connection handed out by the pool.
    connectAttributes: { program_name: 'gogetfit-migration-readonly' },
    dateStrings: true,
    multipleStatements: false,
  });

  pool.on('connection', (connection) => {
    connection.query('SET SESSION TRANSACTION READ ONLY');
  });

  logger.info(`MariaDB pool created (read-only) for ${describeMysqlTarget()}`);
  return pool;
};

/** Parameterized read. Never build SQL by string concatenation. */
export const query = async (sql, params = []) => {
  assertReadOnly(sql);
  const [rows] = await getPool().query(sql, params);
  return rows;
};

export const closePool = async () => {
  if (!pool) return;
  await pool.end();
  pool = null;
  logger.info('MariaDB pool closed');
};

export default { getPool, query, closePool };
