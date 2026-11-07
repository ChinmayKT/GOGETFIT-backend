import mongoose from 'mongoose';

import env from '../config/env.js';
import Coach from '../models/coach.model.js';
import CoachMonthlyCapacity from '../models/coach-monthly-capacity.model.js';
import EnrolledClient from '../models/enrolled-client.model.js';
import { addCalendarDays, businessDayOf, startOfBusinessDay } from '../utils/business-date.js';
import { ERROR_CODES, conflict } from '../utils/errors.js';

/**
 * Monthly coach capacity and the daily release of customer-facing slots. The one
 * place these rules live; the portal and the app only display what this returns.
 *
 *   - `Coach.profile.monthlySlots` is the latest allocation. Null means an admin
 *     has never set one (coaches older than this feature): no limit, no count shown.
 *   - A confirmed booking IS an enrollment, so bookings are counted from
 *     `enrolledclients` by coach and `capacityAccountingMonth`, the month it was
 *     created in. Enrollments older than that field count by `enrollDate` and are
 *     never rewritten. There is no counter to reconcile.
 *   - The month and the day are worked out from the clock in the business
 *     timezone, so a new month or day starts by itself: there is no reset job
 *     that could run twice, or not at all.
 *   - Nothing about a release is stored. Batches are a pure function of how many
 *     were booked today, so a slot cannot be released twice or go missing.
 */

export const FIRST_BATCH_SIZE = 9;
export const NEXT_BATCH_SIZE = 3;

export const CAPACITY_STATUS = {
  AVAILABLE: 'available',
  FULLY_BOOKED: 'fully_booked',
  NOT_CONFIGURED: 'not_configured',
};

/**
 * The release rule: 9 first, then 3 each time a batch sells out, never more than
 * the month has left. Booking the last slot of a batch opens the next one at once.
 */
export const releaseState = ({ capacity, confirmed, bookedToday }) => {
  if (capacity === null || capacity === undefined) {
    return {
      status: CAPACITY_STATUS.NOT_CONFIGURED,
      remainingCapacity: null,
      currentBatch: null,
      releasedToday: 0,
      availableSlots: 0,
    };
  }
  const remainingCapacity = Math.max(0, capacity - confirmed);
  const currentBatch = bookedToday < FIRST_BATCH_SIZE
    ? 1
    : 2 + Math.floor((bookedToday - FIRST_BATCH_SIZE) / NEXT_BATCH_SIZE);
  const batchEnd = FIRST_BATCH_SIZE + (currentBatch - 1) * NEXT_BATCH_SIZE;
  const availableSlots = Math.min(batchEnd - bookedToday, remainingCapacity);
  return {
    status: remainingCapacity === 0 ? CAPACITY_STATUS.FULLY_BOOKED : CAPACITY_STATUS.AVAILABLE,
    remainingCapacity,
    currentBatch,
    releasedToday: bookedToday + availableSlots,
    availableSlots,
  };
};

export const monthOfDay = (day) => day.slice(0, 7);

/** The month after [month] (YYYY-MM); December rolls into January. */
export const nextMonth = (month) => {
  const [year, m] = month.split('-').map(Number);
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
};

const monthRange = (month) => ({
  $gte: startOfBusinessDay(`${month}-01`),
  $lt: startOfBusinessDay(`${nextMonth(month)}-01`),
});

/** The enrollments using [month]'s capacity. */
const accountedIn = (month) => ({
  $or: [
    { capacityAccountingMonth: month },
    // Null also matches a missing field: every enrollment older than the field.
    { capacityAccountingMonth: null, enrollDate: monthRange(month) },
  ],
});

/**
 * Confirmed bookings this month and today, per coach, in one query. "Today" still
 * goes by enrollDate: a late-recorded payment uses a monthly slot, but it was not
 * sold from today's batch.
 */
const countBookings = async (coachIds, day) => {
  const dayStart = startOfBusinessDay(day);
  const dayEnd = startOfBusinessDay(addCalendarDays(day, 1));
  const rows = await EnrolledClient.aggregate([
    { $match: { coachId: { $in: coachIds }, ...accountedIn(monthOfDay(day)) } },
    {
      $group: {
        _id: '$coachId',
        confirmed: { $sum: 1 },
        bookedToday: {
          $sum: { $cond: [{ $and: [{ $gte: ['$enrollDate', dayStart] }, { $lt: ['$enrollDate', dayEnd] }] }, 1, 0] },
        },
      },
    },
  ]);
  return new Map(rows.map((row) => [String(row._id), row]));
};

/**
 * What the app may show for each coach, keyed by coach id. The monthly capacity
 * itself is deliberately not part of this: customers only see released slots.
 */
export const memberAvailability = async (coachDocs, at = new Date()) => {
  const counts = await countBookings(coachDocs.map((doc) => doc._id), businessDayOf(at));
  return new Map(
    coachDocs.map((doc) => {
      const id = String(doc._id);
      const state = releaseState({
        capacity: doc.profile?.monthlySlots,
        confirmed: counts.get(id)?.confirmed ?? 0,
        bookedToday: counts.get(id)?.bookedToday ?? 0,
      });
      return [id, { availableSlots: state.availableSlots, slotStatus: state.status }];
    }),
  );
};

const FULLY_BOOKED_MESSAGE = 'This coach is fully booked for this month. Please contact GoGetFit Support.';
const fullyBooked = (message = FULLY_BOOKED_MESSAGE) => conflict(ERROR_CODES.COACH_FULLY_BOOKED, message);

/** Refuses a coach with no slots left. A courtesy check: consumeSlot is what enforces. */
export const assertCoachHasSlots = async (coachDoc, at = new Date()) => {
  const availability = await memberAvailability([coachDoc], at);
  if (availability.get(String(coachDoc._id)).slotStatus === CAPACITY_STATUS.FULLY_BOOKED) throw fullyBooked();
};

/**
 * Creates the month's record if it is missing. Runs OUTSIDE the booking
 * transaction: inside one, two first bookings of a month would race on the
 * unique index and fail outright instead of one retrying.
 */
export const ensureMonthRecord = async (coachId, month, capacity, adminId = null) => {
  try {
    await CoachMonthlyCapacity.updateOne(
      { coachId, month },
      { $setOnInsert: { capacity, createdBy: adminId, updatedBy: adminId } },
      { upsert: true },
    );
  } catch (error) {
    // Someone else created it first, which is all that was needed.
    if (error?.code !== 11000) throw error;
  }
};

/** Call before starting a booking transaction, then consumeSlot inside it. */
export const prepareBooking = async (coachId, at) => {
  const coach = await Coach.findById(coachId, { 'profile.monthlySlots': 1 }).lean();
  const capacity = coach?.profile?.monthlySlots;
  if (capacity === null || capacity === undefined) return;
  await ensureMonthRecord(coachId, monthOfDay(businessDayOf(at)), capacity);
};

/**
 * Claims one slot, inside the transaction that creates the enrollment, so a
 * failed or duplicate booking claims nothing.
 *
 * The bump is what makes this safe. Two bookings both write this document, so
 * MongoDB aborts one with a transient write conflict and `withTransaction`
 * retries it on a fresh snapshot, where it counts the other's enrollment. That
 * also serialises a booking against an admin changing the capacity.
 *
 * Call this BEFORE inserting the enrollment: the count must not include it.
 * [refusal] replaces the customer's message when an admin is the one booking.
 *
 * Returns the month to store as the enrollment's `capacityAccountingMonth`,
 * including for a coach with no allocation, so that bookings taken before one is
 * set still count against it.
 */
export const consumeSlot = async (coachId, at, session, refusal = undefined) => {
  const month = monthOfDay(businessDayOf(at));
  const record = await CoachMonthlyCapacity.findOneAndUpdate(
    { coachId, month },
    { $inc: { confirmationSeq: 1 } },
    { new: true, session },
  ).lean();
  if (!record) return month; // No allocation has ever been set for this coach.

  const confirmed = await EnrolledClient.countDocuments({ coachId, ...accountedIn(month) }).session(session);
  if (confirmed >= record.capacity) throw fullyBooked(refusal);
  return month;
};

/** Writes an admin's new allocation onto the current month, inside their transaction. */
export const recordCapacityChange = (coachId, { from, to, adminId, at }, session) =>
  CoachMonthlyCapacity.updateOne(
    { coachId, month: monthOfDay(businessDayOf(at)) },
    { $set: { capacity: to, updatedBy: adminId }, $push: { changes: { from, to, by: adminId, at } } },
    { session },
  );

/** GET /api/admin/coaches/:id/capacity. Null when the coach does not exist. */
export const getCoachCapacity = async (coachId, at = new Date()) => {
  if (!mongoose.isValidObjectId(coachId)) return null;
  const coach = await Coach.findById(coachId, { 'profile.monthlySlots': 1 }).lean();
  if (!coach) return null;

  const day = businessDayOf(at);
  const counts = (await countBookings([coach._id], day)).get(String(coach._id));
  const confirmedBookings = counts?.confirmed ?? 0;
  const bookedToday = counts?.bookedToday ?? 0;
  const monthlyCapacity = coach.profile?.monthlySlots ?? null;

  const records = await CoachMonthlyCapacity.find({ coachId: coach._id }).sort({ month: -1 }).limit(12).lean();
  const byMonth = await EnrolledClient.aggregate([
    { $match: { coachId: coach._id } },
    {
      $group: {
        _id: {
          $ifNull: [
            '$capacityAccountingMonth',
            { $dateToString: { date: '$enrollDate', format: '%Y-%m', timezone: env.businessTimezone } },
          ],
        },
        confirmed: { $sum: 1 },
      },
    },
  ]);
  const confirmedByMonth = new Map(byMonth.map((row) => [row._id, row.confirmed]));

  return {
    month: monthOfDay(day),
    date: day,
    timezone: env.businessTimezone,
    monthlyCapacity,
    confirmedBookings,
    bookedToday,
    firstBatchSize: FIRST_BATCH_SIZE,
    nextBatchSize: NEXT_BATCH_SIZE,
    ...releaseState({ capacity: monthlyCapacity, confirmed: confirmedBookings, bookedToday }),
    history: records.map((record) => ({
      month: record.month,
      capacity: record.capacity,
      confirmedBookings: confirmedByMonth.get(record.month) ?? 0,
      changes: (record.changes ?? []).map((change) => ({
        from: change.from ?? null,
        to: change.to,
        by: change.by ? String(change.by) : null,
        at: change.at.toISOString(),
      })),
    })),
  };
};
