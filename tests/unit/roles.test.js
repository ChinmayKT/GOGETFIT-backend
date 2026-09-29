import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANTABLE_ROLES,
  ROLES,
  ROLE_ADMIN,
  ROLE_CLIENT,
  ROLE_COACH,
  ROLE_USER,
  hasAnyRole,
  hasRole,
  isKnownRole,
  mergeRoles,
} from '../../src/constants/roles.js';

test('the four roles are additive, not mutually exclusive', () => {
  assert.deepEqual(ROLES, ['user', 'client', 'coach', 'admin']);
  assert.deepEqual(GRANTABLE_ROLES, ['client', 'coach', 'admin']);
});

test('mergeRoles adds a role without duplicating it', () => {
  assert.deepEqual(mergeRoles([ROLE_USER], [ROLE_ADMIN]), ['user', 'admin']);
  assert.deepEqual(mergeRoles([ROLE_USER, ROLE_CLIENT], [ROLE_ADMIN]), ['user', 'client', 'admin']);
});

test('mergeRoles is idempotent - re-granting an existing role changes nothing', () => {
  const once = mergeRoles([ROLE_USER], [ROLE_ADMIN]);
  const twice = mergeRoles(once, [ROLE_ADMIN]);
  assert.deepEqual(twice, once);
  assert.equal(twice.filter((r) => r === ROLE_ADMIN).length, 1, 'admin must appear exactly once');
});

test('mergeRoles preserves existing roles', () => {
  assert.deepEqual(mergeRoles([ROLE_USER, ROLE_CLIENT, ROLE_COACH], [ROLE_ADMIN]), [
    'user',
    'client',
    'coach',
    'admin',
  ]);
});

test('mergeRoles always keeps the baseline user role and normalises order', () => {
  assert.deepEqual(mergeRoles([], [ROLE_ADMIN]), ['user', 'admin']);
  // Input order must not change the stored result.
  assert.deepEqual(mergeRoles([ROLE_ADMIN, ROLE_USER], []), ['user', 'admin']);
  assert.deepEqual(mergeRoles([ROLE_COACH, ROLE_CLIENT], []), ['user', 'client', 'coach']);
});

test('mergeRoles silently drops unknown roles rather than storing them', () => {
  assert.deepEqual(mergeRoles([ROLE_USER], ['superuser', 'root']), ['user']);
  assert.equal(isKnownRole('superuser'), false);
  assert.equal(isKnownRole(ROLE_ADMIN), true);
});

test('hasRole and hasAnyRole read the roles array', () => {
  const user = { roles: ['user', 'coach'] };
  assert.equal(hasRole(user, ROLE_COACH), true);
  assert.equal(hasRole(user, ROLE_ADMIN), false);
  assert.equal(hasAnyRole(user, [ROLE_ADMIN, ROLE_COACH]), true);
  assert.equal(hasAnyRole(user, [ROLE_ADMIN]), false);
  // A malformed user must never be treated as privileged.
  assert.equal(hasRole({}, ROLE_ADMIN), false);
  assert.equal(hasRole(null, ROLE_ADMIN), false);
});
