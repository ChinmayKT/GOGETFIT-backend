/**
 * Recalculates users.profileCompleted with the current rule (user.model.js
 * isProfileComplete) for every user whose stored flag disagrees with it.
 *
 *   node migration/scripts/recompute-profile-completed.js            # dry run (default)
 *   node migration/scripts/recompute-profile-completed.js --apply    # write
 *
 * Only `profileCompleted` is written - no other field, and not updatedAt.
 */
import mongoose from 'mongoose';

import env from '../../src/config/env.js';
import logger from '../../src/config/logger.js';
import User, { isProfileComplete } from '../../src/models/user.model.js';

const apply = process.argv.includes('--apply');

const run = async () => {
  await mongoose.connect(env.mongoUri);
  if (env.isProduction || /prod/i.test(mongoose.connection.db.databaseName)) throw new Error('Refusing to run against production');

  const users = await User.find({}, { profile: 1, profileCompleted: 1, 'phone.normalized': 1 }).lean();
  const changes = users
    .map((u) => ({ id: u._id, phone: u.phone?.normalized, name: u.profile?.name ?? null, from: Boolean(u.profileCompleted), to: isProfileComplete(u.profile) }))
    .filter((c) => c.from !== c.to);

  logger.info(
    [
      `database: ${mongoose.connection.db.databaseName} · mode: ${apply ? 'APPLY' : 'DRY RUN'}`,
      `users: ${users.length} · complete under the rule: ${users.filter((u) => isProfileComplete(u.profile)).length} · to change: ${changes.length}`,
      ...changes.map((c) => `  ${c.id}  ${c.phone}  ${String(c.name).padEnd(24)} ${c.from} -> ${c.to}`),
    ].join('\n'),
  );

  if (apply && changes.length) {
    const res = await User.collection.bulkWrite(
      changes.map((c) => ({ updateOne: { filter: { _id: c.id }, update: { $set: { profileCompleted: c.to } } } })),
    );
    logger.info(`updated: ${res.modifiedCount}`);
  }
};

run()
  .catch((error) => {
    logger.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
