import mongoose from 'mongoose';

import logger from '../config/logger.js';
import DailyUpdate from '../models/daily-update.model.js';
import EnrolledClient, { enrollmentStatus } from '../models/enrolled-client.model.js';
import GoGetFitCoins from '../models/gogetfit-coins.model.js';
import Streak from '../models/streak.model.js';
import { businessDayOf } from '../utils/business-date.js';

/**
 * GoGetFit Streak and Coins, earned by Daily Updates: each distinct plan day
 * with a submitted Daily Update counts once - one Streak day and 5 coins.
 *
 * Exactly once per day: the day's Daily Update record is claimed
 * (`rewardedAt`) in the SAME transaction that adds the Streak day and the
 * coins, so a repeat, a retry or a concurrent request for that day finds it
 * claimed and adds nothing - and a failure rolls all three back together.
 */

export const COINS_PER_DAY = 5;

/**
 * TEMPORARY - until the coach Start Plan flow exists: a bought plan the coach
 * has not started yet earns too. It has no dates, so there is no day window
 * (planStartDate/planEndDate null); its weeks × 7 still cap the count.
 * ponytail: remove this (and its use in planOf) once Start Plan sets the
 * enrollment's dates - Daily Update will then be locked until the plan starts.
 */
const notStartedPlanOf = (docs, now) => {
  const doc = docs.find((d) => enrollmentStatus(d, now) === 'not_started');
  const weeks = doc?.planId?.durationWeeks;
  if (!doc || !Number.isFinite(weeks) || weeks <= 0) return null;
  return {
    enrollmentId: doc._id,
    coachId: doc.coachId ?? null,
    planId: doc.planId?._id ?? null,
    planStartDate: null,
    planEndDate: null,
    planDays: weeks * 7,
  };
};

/** The member's active enrollment with its plan dates, or null. */
const planOf = async (userId, now) => {
  const docs = await EnrolledClient.find({ userId, isDeleted: { $ne: true } })
    .sort({ enrollDate: -1, createdAt: -1, _id: -1 })
    .populate({ path: 'planId', select: 'durationWeeks' })
    .lean();
    const doc = docs.find((d) => enrollmentStatus(d, now) === 'active');
  if (!doc?.startDate || !doc?.endDate) return notStartedPlanOf(docs, now);
  const weeks = doc.planId?.durationWeeks;
  return {
    enrollmentId: doc._id,
    coachId: doc.coachId ?? null,
    planId: doc.planId?._id ?? null,
    planStartDate: businessDayOf(doc.startDate),
    planEndDate: businessDayOf(doc.endDate),
    // The purchased length; without one, the days the dates span.
    planDays:
      Number.isFinite(weeks) && weeks > 0
        ? weeks * 7
        : Math.round((doc.endDate.getTime() - doc.startDate.getTime()) / 86_400_000),
  };
};

const summaryOf = (streak, coins, awarded) => ({
  currentStreak: streak?.currentStreak ?? 0,
  planDays: streak?.planDays ?? null,
  lastUpdatedDate: streak?.lastUpdatedDate ?? null,
  coins: { balance: coins?.balance ?? 0, totalEarned: coins?.totalEarned ?? 0 },
  rewardAwarded: awarded,
  coinsAwarded: awarded ? COINS_PER_DAY : 0,
});

/**
 * The days of the plan the member holds now - started or still waiting to
 * be (the newest enrollment that is neither deleted nor ended): its weeks × 7.
 * Only the plan's length - no dates are made up and nothing is started.
 */
const currentPlanDays = async (userId, now) => {
  const docs = await EnrolledClient.find({ userId, isDeleted: { $ne: true } })
    .sort({ enrollDate: -1, createdAt: -1, _id: -1 })
    .populate({ path: 'planId', select: 'durationWeeks' })
    .lean();
  const doc = docs.find((d) => ['active', 'not_started'].includes(enrollmentStatus(d, now)));
  const weeks = doc?.planId?.durationWeeks;
  return Number.isFinite(weeks) && weeks > 0 ? weeks * 7 : null;
};

/**
 * The member's Streak and Coins as stored (zeros with none yet). Before
 * their first counted day, planDays is their current plan's length - so a
 * bought plan reads "0 / 84" - or null with no plan.
 */
export const getRewards = async (userId, now = new Date()) => {
  const [streak, coins] = await Promise.all([
    Streak.findOne({ clientId: userId }).lean(),
    GoGetFitCoins.findOne({ clientId: userId }).lean(),
  ]);
  const summary = summaryOf(streak, coins, false);
  if (!streak) summary.planDays = await currentPlanDays(userId, now);
  return summary;
};

/**
 * After [dailyUpdateId] (the member's Daily Update for [date]) was saved:
 * rewards the day if it is a day of the member's active plan, not rewarded
 * before, and the plan's count is not full. Returns the Streak and Coins as
 * they now stand, and whether this call rewarded.
 */
export const rewardDailyUpdate = async ({ userId, dailyUpdateId, date, now = new Date() }) => {
  const plan = await planOf(userId, now);
  // A started plan: its days only. A not-started one (temporary): any day.
  const inPlan =
    plan && (plan.planStartDate === null || (date >= plan.planStartDate && date <= plan.planEndDate));
  if (!inPlan) return { ...(await getRewards(userId, now)), rewardAwarded: false, coinsAwarded: 0 };

  const session = await mongoose.startSession();
  let awarded = false;
  try {
    await session.withTransaction(async () => {
      awarded = false; // the callback may be retried
      const streak = await Streak.findOne({ clientId: userId }, null, { session }).lean();
      // A day of another plan starts that plan's count.
      const samePlan = streak && String(streak.enrollmentId) === String(plan.enrollmentId);
      const count = samePlan ? streak.currentStreak : 0;
      if (count >= plan.planDays) return; // the plan's days are all counted

      const claimed = await DailyUpdate.findOneAndUpdate(
        { _id: dailyUpdateId, clientId: userId, date, rewardedAt: null },
        { $set: { rewardedAt: now } },
        { session, new: true },
      ).lean();
      if (!claimed) return; // already rewarded

      const context = { enrollmentId: plan.enrollmentId, coachId: plan.coachId, planId: plan.planId };
      await Streak.updateOne(
        { clientId: userId },
        {
          $set: {
            ...context,
            planStartDate: plan.planStartDate,
            planEndDate: plan.planEndDate,
            planDays: plan.planDays,
            currentStreak: count + 1,
            lastUpdatedDate: date,
          },
          $setOnInsert: { clientId: userId, userId },
        },
        { session, upsert: true, runValidators: true },
      );
      await GoGetFitCoins.updateOne(
        { clientId: userId },
        { $set: context, $inc: { balance: COINS_PER_DAY, totalEarned: COINS_PER_DAY }, $setOnInsert: { clientId: userId, userId } },
        { session, upsert: true, runValidators: true },
      );
      awarded = true;
    });
  } finally {
    await session.endSession();
  }
  return { ...(await getRewards(userId, now)), rewardAwarded: awarded, coinsAwarded: awarded ? COINS_PER_DAY : 0 };
};

/**
 * [rewardDailyUpdate] that never fails the Daily Update itself: the update is
 * already saved, and a failed reward left nothing behind (rolled back), so
 * the day's next submission rewards it. Null when it could not be worked out.
 */
export const rewardDailyUpdateSafely = async (args) => {
  try {
    return await rewardDailyUpdate(args);
  } catch (error) {
    logger.error(`Daily Update reward failed for ${args.userId} on ${args.date}: ${error?.message}`);
    return null;
  }
};

export default { getRewards, rewardDailyUpdate, rewardDailyUpdateSafely };
