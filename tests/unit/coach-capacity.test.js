import test from 'node:test';
import assert from 'node:assert/strict';

import { nextMonth, releaseState } from '../../src/services/coach-capacity.service.js';

const state = (capacity, confirmed, bookedToday) => releaseState({ capacity, confirmed, bookedToday });

test('the day opens with a first batch of 9, and unbooked slots are not deducted', () => {
  assert.deepEqual(state(50, 0, 0), {
    status: 'available', remainingCapacity: 50, currentBatch: 1, releasedToday: 9, availableSlots: 9,
  });
  const partly = state(50, 6, 6);
  assert.equal(partly.remainingCapacity, 44);
  assert.equal(partly.availableSlots, 3);
  assert.equal(partly.releasedToday, 9); // No new batch while this one has slots.
});

test('each sold-out batch releases 3 more', () => {
  for (const [booked, batch, released] of [[9, 2, 12], [11, 2, 12], [12, 3, 15], [15, 4, 18]]) {
    const s = state(50, booked, booked);
    assert.equal(s.currentBatch, batch);
    assert.equal(s.releasedToday, released);
    assert.equal(s.availableSlots, released - booked);
  }
});

test('a new day starts again at 9 and does not add yesterday\'s unsold slots', () => {
  assert.equal(state(50, 15, 0).availableSlots, 9);
  assert.equal(state(50, 15, 0).currentBatch, 1);
});

test('the month caps every release: remaining below 9 and below 3', () => {
  assert.equal(state(20, 15, 0).availableSlots, 5); // The brief's Day 2 example.
  assert.equal(state(20, 14, 14).availableSlots, 1);
  assert.equal(state(10, 9, 9).availableSlots, 1);
});

test('capacity gone means fully booked, also when cut below what is booked', () => {
  assert.equal(state(20, 20, 5).status, 'fully_booked');
  assert.equal(state(20, 20, 5).availableSlots, 0);
  assert.equal(state(25, 30, 0).remainingCapacity, 0);
  assert.equal(state(25, 30, 0).status, 'fully_booked');
  assert.equal(state(0, 0, 0).status, 'fully_booked');
});

test('capacity changes apply without restarting the day', () => {
  assert.equal(state(40, 30, 0).remainingCapacity, 10);
  assert.equal(state(60, 30, 10).currentBatch, 2); // Raised mid-batch: still batch 2.
  assert.equal(state(60, 30, 10).availableSlots, 2);
});

test('a coach with no allocation is unlimited and shows no count', () => {
  assert.deepEqual(state(null, 12, 3), {
    status: 'not_configured', remainingCapacity: null, currentBatch: null, releasedToday: 0, availableSlots: 0,
  });
});

test('months roll over, December into January', () => {
  assert.equal(nextMonth('2026-11'), '2026-12');
  assert.equal(nextMonth('2026-12'), '2027-01');
  assert.equal(nextMonth('2026-09'), '2026-10');
});

test('selling a whole day: never more than the month has left, and no batch opens early', () => {
  for (let capacity = 0; capacity <= 60; capacity += 1) {
    for (let soldBefore = 0; soldBefore <= capacity; soldBefore += 1) {
      let bookedToday = 0;
      let released = state(capacity, soldBefore, 0).releasedToday;
      assert.ok(released <= Math.min(9, capacity - soldBefore));

      while (state(capacity, soldBefore + bookedToday, bookedToday).availableSlots > 0) {
        const before = state(capacity, soldBefore + bookedToday, bookedToday);
        assert.ok(before.availableSlots <= before.remainingCapacity);
        assert.ok(before.availableSlots <= (bookedToday < 9 ? 9 : 3));

        bookedToday += 1;
        const after = state(capacity, soldBefore + bookedToday, bookedToday);
        // The release only moves when the previous batch has sold out.
        if (after.releasedToday !== released) {
          assert.equal(bookedToday, released);
          assert.ok(after.releasedToday - released <= 3);
        }
        released = after.releasedToday;
      }
      // Sold the whole month, one by one, and exactly the whole month.
      assert.equal(soldBefore + bookedToday, capacity);
      assert.equal(state(capacity, capacity, bookedToday).status, 'fully_booked');
    }
  }
});
