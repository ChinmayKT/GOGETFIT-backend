import test from 'node:test';
import assert from 'node:assert/strict';

import { isProfileComplete } from '../../src/models/user.model.js';

/** Prajwal's real profile - complete under the rule. */
const complete = () => ({
  name: 'Prajwal',
  dateOfBirth: new Date('2001-09-22T00:00:00.000Z'),
  age: 25,
  gender: 'male',
  city: 'Davangere',
  email: 'prajwal@gogetfitonline.com',
  isEmailVerified: true,
  profilePicture: 'http://10.0.2.2:3000/uploads/profile/28f121b2794f39511187d16f80cf6976.png',
  fitnessProfile: {
    height: 176.8,
    weight: 66.3,
    bodyFatPercentage: 15,
    activityLevel: 'sedentary',
    foodType: 'nonVegetarian',
    goal: 'maintainPhysique',
    bmr: 1648,
    tdee: 1977.6,
  },
});

const without = (path, value = null) => {
  const p = complete();
  const [head, tail] = path.split('.');
  if (tail) p[head] = { ...p[head], [tail]: value };
  else p[head] = value;
  return p;
};

test('complete profile -> true', () => {
  assert.equal(isProfileComplete(complete()), true);
});

test('email unverified -> false', () => {
  assert.equal(isProfileComplete(without('isEmailVerified', false)), false);
  assert.equal(isProfileComplete(without('isEmailVerified', undefined)), false);
  assert.equal(isProfileComplete(without('isEmailVerified', 'true')), false); // strictly true
});

test('missing basic field -> false', () => {
  for (const field of ['name', 'dateOfBirth', 'age', 'gender', 'city', 'email', 'profilePicture']) {
    assert.equal(isProfileComplete(without(field)), false, field);
    assert.equal(isProfileComplete(without(field, '')), false, `${field} empty`);
  }
  assert.equal(isProfileComplete(without('name', '   ')), false);
  assert.equal(isProfileComplete(without('gender', 'other')), false);
  assert.equal(isProfileComplete(without('dateOfBirth', new Date('nope'))), false);
});

test('missing fitness field -> false', () => {
  for (const field of ['height', 'weight', 'bodyFatPercentage', 'activityLevel', 'foodType', 'goal', 'bmr', 'tdee']) {
    assert.equal(isProfileComplete(without(`fitnessProfile.${field}`)), false, field);
  }
});

test('incomplete or invalid fitnessProfile -> false', () => {
  assert.equal(isProfileComplete(without('fitnessProfile')), false);
  assert.equal(isProfileComplete(without('fitnessProfile', {})), false);
  const invalid = [
    ['height', 0],
    ['height', -170],
    ['height', 400],
    ['weight', 0],
    ['weight', '66.3'],
    ['bodyFatPercentage', 0],
    ['bodyFatPercentage', 95],
    ['bmr', 50],
    ['tdee', Number.NaN],
    ['activityLevel', 'Moderately Active'],
    ['foodType', 'Vegetarian'],
    ['goal', 'weightLoss'],
  ];
  for (const [field, value] of invalid) {
    assert.equal(isProfileComplete(without(`fitnessProfile.${field}`, value)), false, `${field}=${value}`);
  }
});

test('re-completing the profile -> true', () => {
  const p = without('fitnessProfile.goal');
  assert.equal(isProfileComplete(p), false);
  p.fitnessProfile.goal = 'fatLoss';
  assert.equal(isProfileComplete(p), true);
});
