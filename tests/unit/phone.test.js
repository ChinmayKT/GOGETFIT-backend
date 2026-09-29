import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePhone, tryNormalizePhone } from '../../src/utils/phone.js';

test('a bare national number gains the default country code', () => {
  assert.equal(normalizePhone('9999999999'), '919999999999');
});

test('formatting characters are stripped', () => {
  assert.equal(normalizePhone('+91 99999-99999'), '919999999999');
  assert.equal(normalizePhone('(999) 999 9999'), '919999999999');
});

test('international and trunk prefixes are handled', () => {
  assert.equal(normalizePhone('0091 9999999999'), '919999999999');
  assert.equal(normalizePhone('09999999999'), '919999999999');
});

test('an already normalized number is unchanged', () => {
  assert.equal(normalizePhone('919999999999'), '919999999999');
});

test('different legacy spellings collapse to one identity', () => {
  const spellings = ['+919999999999', '91 9999999999', '9999999999', '0-9999999999'];
  const normalized = new Set(spellings.map((value) => normalizePhone(value)));
  assert.equal(normalized.size, 1);
});

test('unusable values are rejected', () => {
  assert.throws(() => normalizePhone(''));
  assert.throws(() => normalizePhone(null));
  assert.throws(() => normalizePhone('12345'));
  assert.throws(() => normalizePhone('9999999999999999999'));
});

test('the non-throwing variant reports a reason instead of raising', () => {
  const result = tryNormalizePhone('123');
  assert.equal(result.ok, false);
  assert.equal(result.normalized, null);
  assert.match(result.reason, /unsupported length/);
});
