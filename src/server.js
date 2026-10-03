import http from 'node:http';

import env, { assertRuntimeEnv } from './config/env.js';
import logger from './config/logger.js';
import app from './app.js';
import connectDatabase, { disconnectDatabase } from './config/database.js';
import User from './models/user.model.js';
import Otp from './models/otp.model.js';
import MigrationConflict from './models/migration-conflict.model.js';
import FreeDietPlan from './models/free-diet-plan.model.js';
import EnrolledClient from './models/enrolled-client.model.js';

/**
 * Unique indexes are hard database constraints, so they are built at startup
 * rather than being left to Mongoose's background autoIndex behaviour.
 */
const ensureIndexes = async () => {
  await Promise.all([
    User.syncIndexes(),
    Otp.syncIndexes(),
    MigrationConflict.syncIndexes(),
    FreeDietPlan.syncIndexes(),
    EnrolledClient.syncIndexes(),
  ]);
  logger.info('MongoDB indexes verified');
};

/**
 * The listening callback can fire even when the bind failed (address() is then
 * null and an EADDRINUSE error event follows), so success is confirmed by the
 * address and failure is surfaced through the error event.
 */
const listen = (server, port) =>
  new Promise((resolve, reject) => {
    const onError = (error) => reject(error);

    server.once('error', onError);
    server.listen(port, () => {
      const address = server.address();
      if (!address) {
        
        reject(new Error(`Failed to bind to port ${port}`));
        return;
      }
      server.removeListener('error', onError);
      resolve(address);
    });
  });

const shutdown = async (server, signal) => {
  logger.info(`${signal} received, shutting down`);

  await new Promise((resolve) => server.close(resolve));
  await disconnectDatabase().catch((error) => logger.error(error.message));

  process.exit(0);
};

const startServer = async () => {
  const server = http.createServer(app);

  try {
    assertRuntimeEnv();
    await connectDatabase();
    await ensureIndexes();
    await listen(server, env.port);

    logger.info(`GOGETFIT backend running on port ${env.port} [${env.nodeEnv}]`, undefined, {
      color: 'blue',
    });
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown(server, signal).catch(() => process.exit(1));
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    process.exit(1);
  });

  return server;
};

startServer();
