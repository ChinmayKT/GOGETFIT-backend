import test from 'node:test';
import assert from 'node:assert/strict';

import { legacyRow } from '../helpers/legacy-rows.js';
import { transformLegacyUser } from '../../migration/transformers/user.transformer.js';
import { groupByNormalizedPhone } from '../../migration/identity/phone-grouper.js';
import { detectConflicts } from '../../migration/identity/conflict-detector.js';
import { applyResolution } from '../../migration/identity/conflict-resolver.js';
import { validateBatch } from '../../migration/validators/migration.validator.js';
import { CONFLICT_TYPES, RESOLUTION_STRATEGIES } from '../../src/models/migration-conflict.model.js';

const NOW = new Date('2026-09-22T00:00:00Z');
const transform = (rows) => rows.map((row) => transformLegacyUser(row, { now: NOW }));

test('a unique legacy phone becomes a migratable user', () => {
  const { migratable, conflicts } = detectConflicts(
    transform([legacyRow({ user_id: 1001, phone_number: '919999999999' })]),
  );

  assert.equal(conflicts.length, 0);
  assert.equal(migratable.length, 1);
  assert.equal(migratable[0].document.phone.normalized, '919999999999');
  assert.equal(migratable[0].document.legacy.userId, 1001);
});

test('duplicate legacy phones produce a conflict and migrate nobody', () => {
  const { migratable, conflicts } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999' }),
      legacyRow({ user_id: 1002, phone_number: '919999999999' }),
    ]),
  );

  assert.equal(migratable.length, 0, 'neither account may be migrated automatically');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, CONFLICT_TYPES.DUPLICATE_LEGACY_PHONE);
  assert.equal(conflicts[0].phone, '919999999999');
  assert.deepEqual(conflicts[0].legacyUserIds, [1001, 1002]);
});

test('duplicates are detected across different legacy spellings of one number', () => {
  const { duplicateGroups } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '+91 99999-99999' }),
      legacyRow({ user_id: 1002, phone_number: '9999999999' }),
    ]),
  );

  assert.equal(duplicateGroups.length, 1);
  assert.deepEqual(
    duplicateGroups[0].members.map((member) => member.legacyUserId),
    [1001, 1002],
  );
});

test('missing and invalid legacy phones are classified separately', () => {
  const { conflicts, migratable } = detectConflicts(
    transform([
      legacyRow({ user_id: 2001, phone_number: null }),
      legacyRow({ user_id: 2002, phone_number: '123' }),
    ]),
  );

  assert.equal(migratable.length, 0);
  const types = conflicts.map((conflict) => conflict.type).sort();
  assert.deepEqual(types, [CONFLICT_TYPES.INVALID_LEGACY_PHONE, CONFLICT_TYPES.MISSING_LEGACY_PHONE]);
});

test('grouping keeps unusable rows out of the phone groups', () => {
  const { unique, duplicates, unusable } = groupByNormalizedPhone(
    transform([
      legacyRow({ user_id: 1, phone_number: '9111111111' }),
      legacyRow({ user_id: 2, phone_number: '9222222222' }),
      legacyRow({ user_id: 3, phone_number: '9222222222' }),
      legacyRow({ user_id: 4, phone_number: null }),
    ]),
  );

  assert.equal(unique.length, 1);
  assert.equal(duplicates.length, 1);
  assert.equal(unusable.length, 1);
});

test('KEEP_ONE admits exactly the chosen legacy account', () => {
  const { duplicateGroups } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999' }),
      legacyRow({ user_id: 1002, phone_number: '919999999999' }),
    ]),
  );

  const { admitted, excluded } = applyResolution(
    { _id: 'c1', resolution: { strategy: RESOLUTION_STRATEGIES.KEEP_ONE, keepLegacyUserId: 1002 } },
    duplicateGroups[0].members,
  );

  assert.deepEqual(admitted.map((member) => member.legacyUserId), [1002]);
  assert.deepEqual(excluded, [1001]);
});

test('an unresolved conflict admits nobody', () => {
  const { duplicateGroups } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999' }),
      legacyRow({ user_id: 1002, phone_number: '919999999999' }),
    ]),
  );

  const { admitted } = applyResolution({ _id: 'c1', resolution: null }, duplicateGroups[0].members);
  assert.equal(admitted.length, 0);
});

test('REASSIGN_PHONES admits both accounts under distinct numbers', () => {
  const { duplicateGroups } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999' }),
      legacyRow({ user_id: 1002, phone_number: '919999999999' }),
    ]),
  );

  const { admitted } = applyResolution(
    {
      _id: 'c1',
      resolution: {
        strategy: RESOLUTION_STRATEGIES.REASSIGN_PHONES,
        phoneAssignments: [
          { legacyUserId: 1001, phone: '919999999999' },
          { legacyUserId: 1002, phone: '918888888888' },
        ],
      },
    },
    duplicateGroups[0].members,
  );

  assert.deepEqual(admitted.map((member) => member.phone.normalized).sort(), [
    '918888888888',
    '919999999999',
  ]);
});

test('a reassignment that still collides is refused', () => {
  const { duplicateGroups } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999' }),
      legacyRow({ user_id: 1002, phone_number: '919999999999' }),
    ]),
  );

  assert.throws(
    () =>
      applyResolution(
        {
          _id: 'c1',
          resolution: {
            strategy: RESOLUTION_STRATEGIES.REASSIGN_PHONES,
            phoneAssignments: [
              { legacyUserId: 1001, phone: '919999999999' },
              { legacyUserId: 1002, phone: '9999999999' },
            ],
          },
        },
        duplicateGroups[0].members,
      ),
    /duplicate phone/,
  );
});

test('EXCLUDE_ALL migrates none of the group', () => {
  const { duplicateGroups } = detectConflicts(
    transform([
      legacyRow({ user_id: 1001, phone_number: '919999999999' }),
      legacyRow({ user_id: 1002, phone_number: '919999999999' }),
    ]),
  );

  const { admitted, excluded } = applyResolution(
    { _id: 'c1', resolution: { strategy: RESOLUTION_STRATEGIES.EXCLUDE_ALL } },
    duplicateGroups[0].members,
  );

  assert.equal(admitted.length, 0);
  assert.deepEqual(excluded, [1001, 1002]);
});

test('validation rejects a batch that still contains a duplicate phone', () => {
  const batch = transform([
    legacyRow({ user_id: 1001, phone_number: '919999999999' }),
    legacyRow({ user_id: 1002, phone_number: '919999999999' }),
  ]);

  const result = validateBatch(batch, { source: 'gogetfit' });
  assert.equal(result.valid, false);
  assert.equal(result.duplicateWithinBatch.length, 1);
});

test('validation rejects a document carrying legacy credentials', () => {
  const [user] = transform([legacyRow()]);
  user.document.password = 'hunter2';

  const result = validateBatch([user], { source: 'gogetfit' });
  assert.equal(result.valid, false);
  assert.match(result.invalid[0].errors.join(' '), /authentication field/);
});
