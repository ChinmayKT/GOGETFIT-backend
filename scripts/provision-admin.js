#!/usr/bin/env node
/**
 * CLI wrapper around provisionAdmin(). The logic lives in
 * src/services/admin-provisioning.service.js so it can be tested directly.
 *
 * Usage:
 *   ADMIN_BOOTSTRAP_SECRET=... ADMIN_BOOTSTRAP_PASSWORD=... \
 *     node scripts/provision-admin.js --phone 918123260930 [--email a@b.c] [--apply]
 *
 * Without --apply nothing is written. The password is read from the environment
 * or prompted for - never from an argument, which would leak it into the
 * process list and the shell history.
 */
import 'dotenv/config';
import readline from 'node:readline';

import mongoose from 'mongoose';

import env from '../src/config/env.js';
import logger from '../src/config/logger.js';
import { ROLE_ADMIN } from '../src/constants/roles.js';
import { provisionAdmin } from '../src/services/admin-provisioning.service.js';

const parseArgs = (argv) => {
  const args = { apply: false, phone: null, email: null, roles: [ROLE_ADMIN] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--phone') args.phone = argv[++i];
    else if (arg === '--email') args.email = argv[++i];
    else if (arg === '--roles') args.roles = String(argv[++i]).split(',').map((r) => r.trim());
    else if (arg === '--password') {
      throw new Error(
        '--password is not accepted: it would be visible in the process list and shell history. ' +
          'Use ADMIN_BOOTSTRAP_PASSWORD, or omit it to be prompted.',
      );
    }
  }

  if (!args.phone) throw new Error('--phone is required');
  return args;
};

const promptPassword = () =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Admin password (blank keeps the current one): ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  // Gates provisioning itself. The API never reads this, so a running server
  // cannot be talked into granting anyone the admin role.
  if (!env.adminAuth.bootstrapSecret) {
    throw new Error('ADMIN_BOOTSTRAP_SECRET is not set. Refusing to provision an administrator.');
  }

  let password = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? null;
  if (password === null && process.stdin.isTTY) password = await promptPassword();

  await mongoose.connect(env.mongoUri);
  logger.info(
    `Connected to ${mongoose.connection.host}/${mongoose.connection.name} (NODE_ENV=${env.nodeEnv})`,
  );

  const result = await provisionAdmin({
    phone: args.phone,
    email: args.email,
    roles: args.roles,
    password,
    apply: args.apply,
  });

  if (!result.found) {
    logger.error(
      `No user exists with phone.normalized="${result.normalized}". ` +
        'Refusing to create one - provisioning requires an existing account.',
    );
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  console.log('\n--- BEFORE ---');
  console.log(JSON.stringify(result.before, null, 2));
  console.log('\n--- PLAN ---');
  console.log(JSON.stringify(result.plan, null, 2));

  if (!result.wouldChange) {
    console.log('\nAlready in the desired state. Nothing to do.');
  } else if (!result.changed) {
    console.log('\nDry run. Re-run with --apply to write these changes.');
  } else {
    console.log('\n--- AFTER ---');
    console.log(JSON.stringify(result.after, null, 2));
  }

  await mongoose.disconnect();
};

main().catch(async (error) => {
  logger.error('Provisioning failed', error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
