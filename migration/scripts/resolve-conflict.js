/**
 * Records human decisions for migration conflicts. The migration itself never
 * picks a winner; this script is how a decision enters the system.
 *
 *   node migration/scripts/resolve-conflict.js list
 *   node migration/scripts/resolve-conflict.js show <conflictId>
 *   node migration/scripts/resolve-conflict.js keep-one <conflictId> <legacyUserId> --by <who>
 *   node migration/scripts/resolve-conflict.js reassign <conflictId> <legacyUserId>=<phone> [...] --by <who>
 *   node migration/scripts/resolve-conflict.js exclude-all <conflictId> --by <who>
 */
import mongoose from 'mongoose';

import logger from '../../src/config/logger.js';
import MigrationConflict, {
  RESOLUTION_STRATEGIES,
} from '../../src/models/migration-conflict.model.js';
import { listPendingConflicts } from '../identity/conflict-detector.js';
import { resolveConflict } from '../identity/conflict-resolver.js';

const flagValue = (argv, flag, fallback) => {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
};

const commands = {
  async list(argv) {
    const conflicts = await listPendingConflicts(flagValue(argv, '--run-id', null));

    if (conflicts.length === 0) {
      logger.info('No pending migration conflicts.');
      return;
    }

    logger.info(`${conflicts.length} pending conflict(s):`);
    for (const conflict of conflicts) {
      logger.info(
        `  ${conflict._id}  ${conflict.type}  phone=${conflict.phone}  legacyUserIds=[${conflict.legacyUserIds.join(', ')}]`,
      );
    }
  },

  async show(argv) {
    const conflict = await MigrationConflict.findById(argv[0]);
    if (!conflict) {
      logger.error(`Conflict ${argv[0]} not found`);
      process.exitCode = 1;
      return;
    }
    logger.info(JSON.stringify(conflict.toObject(), null, 2));
  },

  async 'keep-one'(argv) {
    const [conflictId, legacyUserId] = argv;
    const decidedBy = flagValue(argv, '--by', null);

    if (!conflictId || !legacyUserId || !decidedBy) {
      throw new Error('Usage: keep-one <conflictId> <legacyUserId> --by <who>');
    }

    const conflict = await resolveConflict(conflictId, {
      strategy: RESOLUTION_STRATEGIES.KEEP_ONE,
      keepLegacyUserId: Number(legacyUserId),
      note: flagValue(argv, '--note', null),
      decidedBy,
    });

    logger.info(`Conflict ${conflict._id} resolved: legacy user ${legacyUserId} keeps ${conflict.phone}`);
    logger.info('The other legacy accounts stay unmigrated; their legacy rows are untouched.');
  },

  async reassign(argv) {
    const [conflictId, ...rest] = argv;
    const decidedBy = flagValue(argv, '--by', null);

    const assignments = rest
      .filter((token) => token.includes('='))
      .map((token) => {
        const [legacyUserId, phone] = token.split('=');
        return { legacyUserId: Number(legacyUserId), phone };
      });

    if (!conflictId || assignments.length === 0 || !decidedBy) {
      throw new Error('Usage: reassign <conflictId> <legacyUserId>=<phone> [...] --by <who>');
    }

    const conflict = await resolveConflict(conflictId, {
      strategy: RESOLUTION_STRATEGIES.REASSIGN_PHONES,
      phoneAssignments: assignments,
      note: flagValue(argv, '--note', null),
      decidedBy,
    });

    logger.info(`Conflict ${conflict._id} resolved with ${assignments.length} phone reassignment(s)`);
  },

  async 'exclude-all'(argv) {
    const [conflictId] = argv;
    const decidedBy = flagValue(argv, '--by', null);

    if (!conflictId || !decidedBy) {
      throw new Error('Usage: exclude-all <conflictId> --by <who>');
    }

    const conflict = await resolveConflict(conflictId, {
      strategy: RESOLUTION_STRATEGIES.EXCLUDE_ALL,
      note: flagValue(argv, '--note', null),
      decidedBy,
    });

    logger.info(`Conflict ${conflict._id}: no legacy account from this group will be migrated`);
  },
};

const run = async () => {
  const [command, ...argv] = process.argv.slice(2);
  const handler = commands[command];

  if (!handler) {
    logger.error(`Unknown command "${command || ''}". Available: ${Object.keys(commands).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);
  await handler(argv);
};

run()
  .catch((error) => {
    logger.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
