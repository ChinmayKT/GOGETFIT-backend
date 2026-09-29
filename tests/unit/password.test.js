import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_PASSWORD_LENGTH,
  assertPasswordAcceptable,
  hashPassword,
  verifyPassword,
} from '../../src/utils/password.js';

test('a password is stored as an argon2id hash, never in plaintext', async () => {
  const hash = await hashPassword('gogetfit@123');
  assert.match(hash, /^\$argon2id\$/);
  assert.ok(!hash.includes('gogetfit@123'), 'the hash must not contain the password');
});

test('the same password hashes differently each time (per-hash salt)', async () => {
  const a = await hashPassword('gogetfit@123');
  const b = await hashPassword('gogetfit@123');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword(a, 'gogetfit@123'), true);
  assert.equal(await verifyPassword(b, 'gogetfit@123'), true);
});

test('verifyPassword accepts the right password and rejects anything else', async () => {
  const hash = await hashPassword('gogetfit@123');
  assert.equal(await verifyPassword(hash, 'gogetfit@123'), true);
  assert.equal(await verifyPassword(hash, 'gogetfit@124'), false);
  assert.equal(await verifyPassword(hash, ''), false);
});

test('verifyPassword returns false rather than throwing on a missing or corrupt hash', async () => {
  assert.equal(await verifyPassword(null, 'anything'), false);
  assert.equal(await verifyPassword(undefined, 'anything'), false);
  assert.equal(await verifyPassword('not-a-hash', 'anything'), false);
});

test('a password shorter than the minimum is rejected when set', () => {
  assert.throws(() => assertPasswordAcceptable('short'), /at least/);
  assert.equal(assertPasswordAcceptable('gogetfit@123'), 'gogetfit@123');
  assert.equal(MIN_PASSWORD_LENGTH, 8);
});
