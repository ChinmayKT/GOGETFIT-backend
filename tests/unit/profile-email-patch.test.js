import test from 'node:test';
import assert from 'node:assert/strict';

import { validateProfilePatch } from '../../src/validators/profile.validator.js';

test('an email reaches the patch instead of being rejected', () => {
  // It used to sit in FORBIDDEN_FIELDS, so the app could only keep the address
  // on the phone: it never reached the database or the Admin Portal.
  const patch = validateProfilePatch({ email: 'Prajwal@GoGetFitOnline.com' });

  assert.equal(patch.email, 'prajwal@gogetfitonline.com', 'stored lowercased');
});

test('a blank or null address clears the stored one', () => {
  assert.equal(validateProfilePatch({ email: null }).email, null);
  assert.equal(validateProfilePatch({ email: '   ' }).email, null);
});

test('an address that is not one is refused', () => {
  for (const email of ['not-an-email', 'two@@at.com', 'spaces in@mail.com', 'no@domain', 42]) {
    assert.throws(
      () => validateProfilePatch({ email }),
      /valid email address|must be a string/,
      `accepted ${JSON.stringify(email)}`,
    );
  }
  assert.throws(() => validateProfilePatch({ email: `${'a'.repeat(250)}@b.com` }), /valid email/);
});

test('the verified flag stays backend-owned', () => {
  // The address is the member's to set; whether it is trusted is not.
  assert.throws(
    () => validateProfilePatch({ isEmailVerified: true }),
    /managed by the backend/,
  );
});

test('email travels with the rest of a profile save', () => {
  const patch = validateProfilePatch({
    name: 'Prajwal',
    city: 'Davangere',
    email: 'prajwal@gogetfitonline.com',
    fitnessProfile: { height: 174, weight: 65 },
  });

  assert.deepEqual(Object.keys(patch).sort(), ['city', 'email', 'fitnessProfile', 'name']);
});
