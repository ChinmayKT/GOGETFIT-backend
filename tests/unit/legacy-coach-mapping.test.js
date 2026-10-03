import test from 'node:test';
import assert from 'node:assert/strict';

import { directoryFrom, normalizeEmail, normalizeName, resolveLegacyCoach } from '../../migration/mappings/legacy-coach.mapping.js';

const prajwal = { coachId: 'c-prajwal', name: 'Prajwal', email: 'prajwal@gogetfitonline.com' };
const siri = { coachId: 'c-siri', name: 'Siri Shankar C', email: 'siri@gogetfitonline.com' };
const dir = (...coaches) => directoryFrom(coaches);

test('normalization: trim, case, repeated spaces, initials punctuation', () => {
  assert.equal(normalizeEmail('  Prajwal@GoGetFitOnline.COM '), 'prajwal@gogetfitonline.com');
  assert.equal(normalizeName('  Siri   Shankar  C '), 'siri shankar c');
  assert.equal(normalizeName('Prajwal A.T.'), normalizeName('prajwal a t'));
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeName(null), null);
});

test('exact email match wins even when the legacy name differs ("Prajwal A T" vs "Prajwal")', () => {
  const r = resolveLegacyCoach({ name: 'Prajwal A T', email: 'prajwal@gogetfitonline.com' }, dir(prajwal, siri));
  assert.equal(r.status, 'matched');
  assert.equal(r.by, 'email');
  assert.equal(r.coach.coachId, 'c-prajwal');
});

test('email match is case- and whitespace-insensitive', () => {
  const r = resolveLegacyCoach({ name: null, email: '  PRAJWAL@GoGetFitOnline.com ' }, dir(prajwal));
  assert.equal(r.status, 'matched');
  assert.equal(r.coach.coachId, 'c-prajwal');
});

test('exact normalized name match when there is no email match', () => {
  const r = resolveLegacyCoach({ name: '  siri   SHANKAR c ', email: null }, dir(prajwal, siri));
  assert.equal(r.status, 'matched');
  assert.equal(r.by, 'name');
  assert.equal(r.coach.coachId, 'c-siri');
});

test('no fuzzy matching: a partial or near name is unmatched', () => {
  for (const name of ['Siri', 'Siri Shankar', 'Siri Shankr C', 'Prajwal A T']) {
    assert.equal(resolveLegacyCoach({ name, email: null }, dir(prajwal, siri)).status, 'unmatched', name);
  }
});

test('unmatched coach is reported with a reason', () => {
  const r = resolveLegacyCoach({ name: 'Karthik M', email: 'karthik@gogetfitonline.com' }, dir(prajwal, siri));
  assert.equal(r.status, 'unmatched');
  assert.match(r.reason, /no new coach/);
  assert.equal(resolveLegacyCoach({ name: '', email: '' }, dir(prajwal)).status, 'unmatched');
});

test('ambiguous: two coaches share the email, or the name - nothing is assigned', () => {
  const twinEmail = { coachId: 'c-x', name: 'Someone', email: 'prajwal@gogetfitonline.com' };
  assert.equal(resolveLegacyCoach({ name: null, email: 'prajwal@gogetfitonline.com' }, dir(prajwal, twinEmail)).status, 'ambiguous');
  const twinName = { coachId: 'c-y', name: 'Siri Shankar C', email: 'other@x.com' };
  const r = resolveLegacyCoach({ name: 'Siri Shankar C', email: null }, dir(siri, twinName));
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.candidates.length, 2);
});

test('conflict: email says one coach, name says another - nothing is assigned', () => {
  const r = resolveLegacyCoach({ name: 'Siri Shankar C', email: 'prajwal@gogetfitonline.com' }, dir(prajwal, siri));
  assert.equal(r.status, 'conflict');
});

test('conflict: the name matches but the coach has a different email on record', () => {
  const r = resolveLegacyCoach({ name: 'Siri Shankar C', email: 'siri.old@gmail.com' }, dir(siri));
  assert.equal(r.status, 'conflict');
});
