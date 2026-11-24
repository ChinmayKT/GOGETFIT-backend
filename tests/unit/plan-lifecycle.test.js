import test from 'node:test';
import assert from 'node:assert/strict';

import { enrollmentLifecycle, enrollmentStatus, notEndedCutoff, unlocksPlan } from '../../src/models/enrolled-client.model.js';
import { addCalendarDays, startOfBusinessDay } from '../../src/utils/business-date.js';

/**
 * The plan lifecycle in Asia/Kolkata calendar days, end day inclusive.
 * The agreed example: Start clicked 18 Nov 2026, 12 weeks -> 19 Nov 2026 to
 * 10 Feb 2027 (84 days), completed from 11 Feb 2027 00:00 IST.
 */
const started = {
  hasStarted: true,
  startDate: startOfBusinessDay('2026-11-19'),
  endDate: startOfBusinessDay(addCalendarDays('2026-11-19', 12 * 7 - 1)),
};
const ist = (iso) => new Date(`${iso}+05:30`);

test('12 weeks from 19 Nov 2026 ends on 10 Feb 2027 - 84 calendar days, both ends included', () => {
  assert.equal(addCalendarDays('2026-11-19', 84 - 1), '2027-02-10');
  let days = 0;
  for (let d = '2026-11-19'; d <= '2027-02-10'; d = addCalendarDays(d, 1)) days += 1;
  assert.equal(days, 84);
});

test('lifecycle: not started, scheduled, active through the last day, completed at 00:00 IST after it', () => {
  assert.equal(enrollmentLifecycle({ hasStarted: false }, ist('2026-11-18T12:00:00')), 'not_started');
  assert.equal(enrollmentLifecycle({ hasStarted: true }, ist('2026-11-18T12:00:00')), 'not_started', 'no dates');
  assert.equal(enrollmentLifecycle(started, ist('2026-11-18T23:59:59.999')), 'scheduled');
  assert.equal(enrollmentLifecycle(started, ist('2026-11-19T00:00:00')), 'active');
  assert.equal(enrollmentLifecycle(started, ist('2027-02-10T00:00:00')), 'active', 'not expired at the start of its last day');
  assert.equal(enrollmentLifecycle(started, ist('2027-02-10T23:59:59.999')), 'active');
  assert.equal(enrollmentLifecycle(started, ist('2027-02-11T00:00:00')), 'completed');
  assert.equal(enrollmentLifecycle({ ...started, isDeleted: true }, ist('2026-12-01T12:00:00')), 'deleted');
});

test('IST, not UTC: 10 Feb 23:00 IST is still the 10th although UTC is past 17:30 there', () => {
  assert.equal(enrollmentLifecycle(started, new Date('2027-02-10T17:30:00.000Z')), 'active');
  assert.equal(enrollmentLifecycle(started, new Date('2027-02-10T18:30:00.000Z')), 'completed');
});

test('the legacy status reads a scheduled plan as active and turns inactive only after the last day', () => {
  assert.equal(enrollmentStatus(started, ist('2026-11-18T12:00:00')), 'active');
  assert.equal(enrollmentStatus(started, ist('2027-02-10T23:00:00')), 'active');
  assert.equal(enrollmentStatus(started, ist('2027-02-11T00:00:00')), 'inactive');
  assert.equal(enrollmentStatus({ hasStarted: false }), 'not_started');
});

test('notEndedCutoff is the instant today begins in IST (the query form of the inclusive end)', () => {
  assert.deepEqual(notEndedCutoff(ist('2027-02-10T23:59:59.999')), startOfBusinessDay('2027-02-10'));
  assert.ok(started.endDate >= notEndedCutoff(ist('2027-02-10T23:59:59.999')));
  assert.ok(started.endDate < notEndedCutoff(ist('2027-02-11T00:00:00')));
});

test('unlocksPlan: from the coach\'s Start (first day tomorrow) through the last day, never before or after', () => {
  const click = ist('2026-11-18T14:00:00');
  const coachStarted = { ...started, startedAt: click };
  assert.equal(unlocksPlan({ hasStarted: false }, click), false, 'bought, not started');
  assert.equal(unlocksPlan(coachStarted, ist('2026-11-18T13:59:59')), false, 'before the click');
  assert.equal(unlocksPlan(coachStarted, click), true, 'at the click');
  assert.equal(unlocksPlan(coachStarted, ist('2026-11-18T14:01:00')), true, 'the same afternoon');
  assert.equal(unlocksPlan(coachStarted, ist('2026-11-18T23:59:59.999')), true);
  assert.equal(enrollmentLifecycle(coachStarted, ist('2026-11-18T14:01:00')), 'scheduled', 'official lifecycle unchanged');
  assert.equal(unlocksPlan(coachStarted, ist('2027-02-10T23:59:59.999')), true, 'the last day');
  assert.equal(unlocksPlan(coachStarted, ist('2027-02-11T00:00:00')), false, 'expired at 00:00 IST after it');
  assert.equal(unlocksPlan({ ...coachStarted, isDeleted: true }, click), false, 'deleted');
  // Dated ahead with no coach Start (e.g. an admin enrollment): waits for its first day.
  assert.equal(unlocksPlan(started, ist('2026-11-18T14:01:00')), false);
  assert.equal(unlocksPlan(started, ist('2026-11-19T00:00:00')), true);
});
