import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateAge, isFutureDate, parseDateOfBirth } from '../../src/utils/age.js';

const at = (iso) => new Date(iso);

test('age is correct the day before a birthday', () => {
  assert.equal(calculateAge(at('2001-09-22T00:00:00Z'), at('2026-09-21T12:00:00Z')), 24);
});

test('age increments on the birthday itself', () => {
  assert.equal(calculateAge(at('2001-09-22T00:00:00Z'), at('2026-09-22T00:00:00Z')), 25);
});

test('age holds through the following year until the birthday', () => {
  assert.equal(calculateAge(at('2001-09-22T00:00:00Z'), at('2027-09-21T23:59:59Z')), 25);
  assert.equal(calculateAge(at('2001-09-22T00:00:00Z'), at('2027-09-22T00:00:00Z')), 26);
});

test('a plain year subtraction would be wrong before the birthday', () => {
  const dob = at('2001-12-31T00:00:00Z');
  const now = at('2026-01-01T00:00:00Z');
  assert.equal(now.getUTCFullYear() - dob.getUTCFullYear(), 25);
  assert.equal(calculateAge(dob, now), 24);
});

test('leap-year birth date rolls over on 1 March in a non-leap year', () => {
  const dob = at('2000-02-29T00:00:00Z');
  assert.equal(calculateAge(dob, at('2027-02-28T00:00:00Z')), 26);
  assert.equal(calculateAge(dob, at('2027-03-01T00:00:00Z')), 27);
  // In a leap year the birthday lands on the real date.
  assert.equal(calculateAge(dob, at('2028-02-29T00:00:00Z')), 28);
});

test('a timezone offset cannot shift the stored date of birth by a day', () => {
  const dob = parseDateOfBirth('2001-09-22');
  assert.equal(dob.toISOString(), '2001-09-22T00:00:00.000Z');
  assert.equal(dob.getUTCDate(), 22);

  // Evaluated from either side of UTC, the birthday still lands on the 22nd.
  assert.equal(calculateAge(dob, at('2026-09-21T23:00:00Z')), 24);
  assert.equal(calculateAge(dob, at('2026-09-22T01:00:00Z')), 25);
});

test('date of birth parsing rejects malformed and impossible dates', () => {
  assert.equal(parseDateOfBirth('22-09-2001'), null);
  assert.equal(parseDateOfBirth('2001-13-01'), null);
  assert.equal(parseDateOfBirth('2025-02-30'), null);
  assert.equal(parseDateOfBirth(''), null);
  assert.equal(parseDateOfBirth(null), null);
});

test('future dates are detected and produce no age', () => {
  const future = parseDateOfBirth('2030-01-01');
  assert.equal(isFutureDate(future, at('2026-09-22T00:00:00Z')), true);
  assert.equal(calculateAge(future, at('2026-09-22T00:00:00Z')), null);
});

test('missing date of birth yields a null age', () => {
  assert.equal(calculateAge(null), null);
});
