import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../../migration/scripts/migrate-single-user.js';

test('ids are read from --id and --legacy-id, singly or comma separated', () => {
  assert.deepEqual(parseArgs(['--id', '8853']).ids, [8853]);
  assert.deepEqual(parseArgs(['--legacy-id', '8853']).ids, [8853]);
  assert.deepEqual(parseArgs(['--id', '8853,1005']).ids, [8853, 1005]);
  assert.deepEqual(parseArgs(['--id', '8853', '--id', '1005']).ids, [8853, 1005]);
  assert.deepEqual(parseArgs(['--id', ' 8853 , 1005 ']).ids, [8853, 1005]);
});

test('anything that is not a positive integer id is dropped, never guessed', () => {
  // A stray flag, a word, a zero or a negative would otherwise widen the SELECT
  // to rows nobody named.
  assert.deepEqual(parseArgs(['--id', 'all']).ids, []);
  assert.deepEqual(parseArgs(['--id', '0']).ids, []);
  assert.deepEqual(parseArgs(['--id', '-5']).ids, []);
  assert.deepEqual(parseArgs(['--id', '8853,,abc']).ids, [8853]);
  assert.deepEqual(parseArgs([]).ids, []);
});

test('phone numbers are read from --phone, singly or comma separated', () => {
  assert.deepEqual(parseArgs(['--phone', '9900298489']).phones, ['9900298489']);
  assert.deepEqual(parseArgs(['--phone', '9871749771,9900298489']).phones, [
    '9871749771',
    '9900298489',
  ]);
  assert.deepEqual(parseArgs(['--phone', ' 9871749771 , 9900298489 ']).phones, [
    '9871749771',
    '9900298489',
  ]);
  // Kept verbatim: normalization belongs to the phone rule, not to argument
  // parsing, so "+91 98717 49771" must reach it untouched.
  assert.deepEqual(parseArgs(['--phone', '+91 98717 49771']).phones, ['+91 98717 49771']);
});

test('ids and phones can be named in the same run', () => {
  const args = parseArgs(['--id', '8853', '--phone', '9871749771', '--apply']);
  assert.deepEqual(args.ids, [8853]);
  assert.deepEqual(args.phones, ['9871749771']);
  assert.equal(args.apply, true);
});

test('writing is opt-in: dry run unless --apply is given', () => {
  assert.equal(parseArgs(['--id', '8853']).apply, false);
  assert.equal(parseArgs(['--id', '8853', '--apply']).apply, true);
});

test('--apply is not swallowed as an id', () => {
  const args = parseArgs(['--id', '8853', '--apply']);
  assert.deepEqual(args.ids, [8853]);
  assert.equal(args.apply, true);
});
