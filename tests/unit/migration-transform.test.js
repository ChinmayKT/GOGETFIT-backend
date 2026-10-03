import test from 'node:test';
import assert from 'node:assert/strict';

import { legacyRow } from '../helpers/legacy-rows.js';
import {
  resolveDateOfBirth,
  resolveGender,
  resolveProfileName,
  transformLegacyUser,
} from '../../migration/transformers/user.transformer.js';
import { transformLegacyPhone } from '../../migration/transformers/phone.transformer.js';

const NOW = new Date('2026-09-22T00:00:00Z');

test('legacy identity is preserved without becoming the Mongo id', () => {
  const result = transformLegacyUser(legacyRow({ user_id: 1234 }), { now: NOW });

  assert.equal(result.document.legacy.source, 'gogetfit');
  assert.equal(result.document.legacy.userId, 1234);
  assert.equal(result.document._id, undefined);
});

test('profile.name uses first_name only under the configured strategy', () => {
  const row = legacyRow({ first_name: 'John', last_name: 'Doe' });

  assert.equal(resolveProfileName(row, 'first_name'), 'John');
  assert.equal(resolveProfileName(row, 'concat'), 'John Doe');
  assert.equal(resolveProfileName(row, 'ignore'), null);
});

test('an empty first_name leaves the name for onboarding to collect', () => {
  assert.equal(resolveProfileName(legacyRow({ first_name: '  ', last_name: 'Doe' }), 'first_name'), null);
  assert.equal(resolveProfileName(legacyRow({ first_name: null }), 'first_name'), null);
});

test('the legacy age column is ignored and age is derived from dob', () => {
  const result = transformLegacyUser(legacyRow({ dob: '2001-09-22', age: 99 }), { now: NOW });
  assert.equal(result.document.profile.age, 25);
});

test('a missing date of birth is never invented', () => {
  const result = transformLegacyUser(legacyRow({ dob: null }), { now: NOW });
  assert.equal(result.document.profile.dateOfBirth, null);
  assert.equal(result.document.profile.age, null);
});

test('zero dates and unparseable dates become null', () => {
  assert.equal(resolveDateOfBirth('0000-00-00'), null);
  assert.equal(resolveDateOfBirth('0000-00-00 00:00:00'), null);
  assert.equal(resolveDateOfBirth('not a date'), null);
});

test('gender is only accepted when it maps cleanly', () => {
  assert.equal(resolveGender('Male'), 'male');
  assert.equal(resolveGender('F'), 'female');
  assert.equal(resolveGender('other'), null);
  assert.equal(resolveGender(null), null);
});

test('no legacy authentication field can reach the transformed document', () => {
  const row = legacyRow({ password: 'hunter2', login_token: 'abc', otp: '1234', otp_expiry: 'x' });
  const result = transformLegacyUser(row, { now: NOW });
  const serialized = JSON.stringify(result.document);

  for (const forbidden of ['password', 'login_token', 'otp', 'otp_expiry', 'hunter2', 'abc']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked into the document`);
  }
});

test('migration completion and profile completion are independent', () => {
  // Under the strict rule a migrated user is never complete on arrival: no
  // verified-in-app email, no profile picture and no fitness profile yet.
  const complete = transformLegacyUser(legacyRow(), { now: NOW });
  assert.equal(complete.document.profileCompleted, false);
  assert.equal(complete.document.legacy.userId, 1001);

  const partial = transformLegacyUser(legacyRow({ dob: null, city_name: null }), { now: NOW });
  assert.equal(partial.document.profileCompleted, false);
  assert.equal(partial.document.legacy.userId, 1001);
});

test('an unusable legacy phone is flagged rather than dropped or guessed', () => {
  assert.equal(transformLegacyPhone(null).reason, 'MISSING');
  assert.equal(transformLegacyPhone('   ').reason, 'MISSING');
  assert.equal(transformLegacyPhone('123').ok, false);

  const result = transformLegacyUser(legacyRow({ phone_number: '123' }), { now: NOW });
  assert.equal(result.phone.ok, false);
  assert.equal(result.document.phone, null);
});
