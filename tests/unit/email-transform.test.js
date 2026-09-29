import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupByEmail,
  transformLegacyEmail,
} from '../../migration/transformers/email.transformer.js';

test('a valid legacy email is carried across unchanged', () => {
  assert.equal(transformLegacyEmail('user@example.com'), 'user@example.com');
});

test('surrounding whitespace is trimmed', () => {
  assert.equal(transformLegacyEmail('  user@example.com  '), 'user@example.com');
  assert.equal(transformLegacyEmail('\tuser@example.com\n'), 'user@example.com');
});

test('null, undefined and blank values become null', () => {
  assert.equal(transformLegacyEmail(null), null);
  assert.equal(transformLegacyEmail(undefined), null);
  assert.equal(transformLegacyEmail(''), null);
  assert.equal(transformLegacyEmail('   '), null);
});

test('casing is preserved - nothing normalizes email case', () => {
  assert.equal(transformLegacyEmail('User.Name@Example.COM'), 'User.Name@Example.COM');
});

test('the address is never otherwise rewritten', () => {
  assert.equal(transformLegacyEmail('not-an-email'), 'not-an-email');
  assert.equal(transformLegacyEmail('a+b@example.co.in'), 'a+b@example.co.in');
});

test('duplicate legacy emails are grouped for reporting', () => {
  const groups = groupByEmail([
    { legacyUserId: 1001, rawEmail: 'shared@example.com' },
    { legacyUserId: 1002, rawEmail: ' shared@example.com ' },
    { legacyUserId: 1003, rawEmail: 'unique@example.com' },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].email, 'shared@example.com');
  assert.deepEqual(groups[0].legacyUserIds, [1001, 1002]);
});

test('duplicate detection is case-insensitive', () => {
  const groups = groupByEmail([
    { legacyUserId: 1, rawEmail: 'A@Example.com' },
    { legacyUserId: 2, rawEmail: 'a@example.com' },
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].legacyUserIds, [1, 2]);
});

test('missing emails never form a duplicate group', () => {
  const groups = groupByEmail([
    { legacyUserId: 1, rawEmail: null },
    { legacyUserId: 2, rawEmail: '  ' },
    { legacyUserId: 3, rawEmail: '' },
  ]);

  assert.equal(groups.length, 0);
});
