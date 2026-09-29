import test from 'node:test';
import assert from 'node:assert/strict';

import { query } from '../../migration/config/mariadb.js';
import { READABLE_COLUMNS, FORBIDDEN_COLUMNS } from '../../migration/extractors/user.extractor.js';

// The guard runs before any connection is opened, so these assertions never
// touch the legacy database.
for (const statement of [
  'UPDATE m_user SET phone_number = ? WHERE user_id = ?',
  'DELETE FROM m_user WHERE user_id = ?',
  'INSERT INTO m_user (user_id) VALUES (?)',
  'ALTER TABLE m_user ADD COLUMN x INT',
  'DROP TABLE m_user',
  'TRUNCATE m_user',
  '  update m_user set x = 1',
]) {
  test(`the migration refuses to run: ${statement.slice(0, 32)}`, async () => {
    await assert.rejects(() => query(statement, []), /non-read statement/);
  });
}

test('the extractor never reads a legacy authentication column', () => {
  for (const column of FORBIDDEN_COLUMNS) {
    assert.equal(
      READABLE_COLUMNS.includes(column),
      false,
      `${column} must never appear in the selected column list`,
    );
  }
});

test('the extractor reads the legacy identity and phone columns', () => {
  for (const column of ['user_id', 'phone_number', 'first_name', 'dob', 'gender', 'city_name']) {
    assert.equal(READABLE_COLUMNS.includes(column), true);
  }
});
