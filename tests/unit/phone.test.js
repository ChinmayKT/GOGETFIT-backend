import test from 'node:test';
import assert from 'node:assert/strict';

import { PhoneNormalizationError, normalizePhone, tryNormalizePhone } from '../../src/utils/phone.js';

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

// --- International parsing (parsePhone) -------------------------------------

import { normalizeCountryIso, parsePhone } from '../../src/utils/phone.js';

const expectParsed = (input, iso, expected) => {
  assert.deepEqual(parsePhone(input, iso), expected, `${input} / ${iso}`);
};

test('India: 10 digits (old app, no countryIso), +91 and IN all agree', () => {
  const india = {
    normalized: '919876543210',
    e164: '+919876543210',
    countryIso: 'IN',
    countryName: 'India',
    countryCode: '91',
    formatted: '+91 98765 43210',
  };
  expectParsed('9876543210', undefined, india);
  expectParsed('+91 98765 43210', undefined, india);
  expectParsed('9876543210', 'IN', india);
  expectParsed('+919876543210', 'IN', india);
  expectParsed('919876543210', undefined, india);
  expectParsed('09876543210', undefined, india);
});

test('US, Australia, UAE, Singapore and UK with their countryIso', () => {
  expectParsed('+14155550123', 'US', {
    normalized: '14155550123',
    e164: '+14155550123',
    countryIso: 'US',
    countryName: 'United States',
    countryCode: '1',
    formatted: '+1 415 555 0123',
  });
  expectParsed('+61412345678', 'AU', {
    normalized: '61412345678',
    e164: '+61412345678',
    countryIso: 'AU',
    countryName: 'Australia',
    countryCode: '61',
    formatted: '+61 412 345 678',
  });
  expectParsed('+971501234567', 'AE', {
    normalized: '971501234567',
    e164: '+971501234567',
    countryIso: 'AE',
    countryName: 'United Arab Emirates',
    countryCode: '971',
    formatted: '+971 50 123 4567',
  });
  expectParsed('+6591234567', 'SG', {
    normalized: '6591234567',
    e164: '+6591234567',
    countryIso: 'SG',
    countryName: 'Singapore',
    countryCode: '65',
    formatted: '+65 9123 4567',
  });
  expectParsed('+447400123456', 'GB', {
    normalized: '447400123456',
    e164: '+447400123456',
    countryIso: 'GB',
    countryName: 'United Kingdom',
    countryCode: '44',
    formatted: '+44 7400 123456',
  });
});

test('a national number is read in the supplied country', () => {
  assert.equal(parsePhone('412 345 678', 'AU').e164, '+61412345678');
  assert.equal(parsePhone('0412 345 678', 'AU').e164, '+61412345678');
  assert.equal(parsePhone('9123 4567', 'SG').e164, '+6591234567');
  assert.equal(parsePhone('07400 123456', 'GB').e164, '+447400123456');
  assert.equal(parsePhone('(415) 555-0123', 'us').e164, '+14155550123');
});

test('Singapore (10 digits with its code) is never read as Indian', () => {
  assert.equal(parsePhone('+6591234567').normalized, '6591234567');
  assert.equal(parsePhone('+6591234567', 'SG').normalized, '6591234567');
  assert.equal(normalizePhone('+6591234567', { countryIso: 'SG' }), '6591234567');
  assert.equal(normalizePhone('+6591234567'), '6591234567');
});

test('00 international prefix', () => {
  assert.equal(parsePhone('0061 412 345 678').e164, '+61412345678');
  assert.equal(parsePhone('00971501234567', 'AE').e164, '+971501234567');
  assert.equal(parsePhone('0091 9876543210').e164, '+919876543210');
});

test('invalid for the country, or the wrong country, is rejected', () => {
  assert.throws(() => parsePhone('+6512345678', 'SG'), PhoneNormalizationError); // no SG range
  assert.throws(() => parsePhone('41234567', 'AU'), PhoneNormalizationError); // too short
  assert.throws(() => parsePhone('+15555550123', 'US'), PhoneNormalizationError); // 555 area
  assert.throws(() => parsePhone('+61412345678', 'IN'), PhoneNormalizationError); // code mismatch
  assert.throws(() => parsePhone('5555555555'), PhoneNormalizationError); // not an Indian range
  assert.throws(() => parsePhone('9876543210', 'XX'), PhoneNormalizationError);
  assert.throws(() => parsePhone('', 'IN'), PhoneNormalizationError);
});

test('a +1 number keeps its own region, and countryName follows countryIso', () => {
  const canada = parsePhone('+14165550123', 'US');
  assert.equal(canada.countryIso, 'CA');
  assert.equal(canada.countryName, 'Canada');
  assert.equal(normalizeCountryIso(' au '), 'AU');
});

test('every valid number: e164 is "+" + normalized, normalized is digits only', () => {
  for (const [n, iso] of [
    ['9876543210'],
    ['+14155550123', 'US'],
    ['+61412345678', 'AU'],
    ['+971501234567', 'AE'],
    ['+6591234567', 'SG'],
    ['+447400123456', 'GB'],
  ]) {
    const p = parsePhone(n, iso);
    assert.match(p.normalized, /^\d+$/);
    assert.equal(p.e164, `+${p.normalized}`);
  }
});

test('normalizePhone keeps every existing identity (old clients, migration)', () => {
  // Same digits as the original rule for every spelling it accepted.
  for (const [input, identity] of [
    ['9999999999', '919999999999'],
    ['+91 99999-99999', '919999999999'],
    ['0091 9999999999', '919999999999'],
    ['09999999999', '919999999999'],
    ['919999999999', '919999999999'],
    ['61412345678', '61412345678'],
    ['+61 412 345 678', '61412345678'],
  ]) {
    assert.equal(normalizePhone(input), identity, input);
  }
  // A legacy number outside today's numbering rules still maps to the digits
  // it was stored under, so its account keeps resolving.
  assert.throws(() => parsePhone('5555555555'));
  assert.equal(normalizePhone('5555555555'), '915555555555');
  assert.equal(normalizePhone('999999999999'), '999999999999');
});
