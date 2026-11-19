import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Coach from '../../src/models/coach.model.js';
import DailyUpdate from '../../src/models/daily-update.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import Food from '../../src/models/food.model.js';
import GoGetFitCoins from '../../src/models/gogetfit-coins.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import Streak from '../../src/models/streak.model.js';
import User from '../../src/models/user.model.js';
import { submitDailyUpdate } from '../../src/services/daily-update.service.js';
import { submitFoodLog } from '../../src/services/food-log.service.js';
import { businessDayOf } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * GoGetFit Streak and Coins from Daily Updates: one Streak and one Coins
 * document per member; each distinct day of the active plan with a saved
 * Daily Update earns exactly one Streak day and 5 coins - never twice
 * (repeats, retries, concurrency), never reset by a missed day, never past
 * the plan's days; coins are kept.
 */
let server;
let plan;
let member;
let other;
let coach;
let enrollment;
let rice;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9188300${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};
// Midnight IST of [day] (the coach starting the plan that day).
const istMidnight = (day) => new Date(`${day}T00:00:00.000+05:30`);
const enroll = (user, { start = '2026-10-01', weeks = 12, p = plan, enrollDate = '2026-09-30' } = {}) =>
  EnrolledClient.create({
    userId: user._id,
    planId: p._id,
    coachId: coach._id,
    enrollDate: new Date(enrollDate),
    startDate: istMidnight(start),
    endDate: new Date(istMidnight(start).getTime() + weeks * 7 * 86_400_000),
    hasStarted: true,
    isDeleted: false,
  });
const noonOn = (day) => new Date(`${day}T06:30:00.000Z`); // 12:00 IST
const body = (extra = {}) => ({
  weightKg: 80,
  workoutMinutes: 60,
  steps: 8000,
  calorieOut: { bmr: 1542, tef: 220, eat: 150, neat: 144 },
  submissionId: null,
  ...extra,
});
// The day's Food Intake comes first (once per member and day, however many
// Daily Updates follow it); a Daily Update is never rewarded without it.
let intakes = new Map();
const intakeOn = (user, day) => {
  const key = `${user._id}:${day}`;
  if (!intakes.has(key)) {
    intakes.set(
      key,
      submitFoodLog(user._id, { meals: [{ meal: 1, foods: [{ entryId: `${day}-a`, foodId: String(rice._id), qty: 100 }] }], memberGoal: null, day: null }, { now: noonOn(day) }),
    );
  }
  return intakes.get(key);
};
const submitOn = async (user, day, extra = {}) => {
  await intakeOn(user, day);
  return submitDailyUpdate(user._id, day, body(extra), { now: noonOn(day) });
};
const dailyUpdateOnly = (user, day) => submitDailyUpdate(user._id, day, body(), { now: noonOn(day) });
const docs = async (user) => ({
  streaks: await Streak.find({ clientId: user._id }).lean(),
  coins: await GoGetFitCoins.find({ clientId: user._id }).lean(),
});

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  await EnrolledClient.deleteMany({});
  plan = await GogetfitPlan.create({ name: '12 WEEKS', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 12, personsAllowed: 1, pricing: { basePrice: 1, reward: 0 } });
  member = await seedUser(['user', 'client'], 'Chethan');
  other = await seedUser(['user', 'client'], 'Bob');
  const coachUser = await seedUser(['user', 'coach'], 'Prajwal');
  coach = await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  enrollment = await enroll(member);
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 113, fat: 3.5, carbs: 19, protein: 2 });
  intakes = new Map();
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('the first plan day creates one Streak (1 of 84) and one Coins (5 / 5) document, from the trusted enrollment', async () => {
  const res = await submitOn(member, '2026-10-01');
  assert.deepEqual(res.rewards, {
    currentStreak: 1,
    planDays: 84,
    lastUpdatedDate: '2026-10-01',
    coins: { balance: 5, totalEarned: 5 },
    rewardAwarded: true,
    coinsAwarded: 5,
  });
  const { streaks, coins } = await docs(member);
  assert.equal(streaks.length, 1);
  assert.equal(coins.length, 1);
  assert.equal(String(streaks[0].enrollmentId), String(enrollment._id));
  assert.equal(String(streaks[0].coachId), String(coach._id));
  assert.equal(String(streaks[0].planId), String(plan._id));
  assert.equal(streaks[0].planStartDate, '2026-10-01');
  assert.equal(String(coins[0].userId), String(member._id));
  assert.ok((await DailyUpdate.findOne({ clientId: member._id }).lean()).rewardedAt);
});

test('resubmitting / editing the same day saves it but rewards nothing more', async () => {
  await submitOn(member, '2026-10-01', { steps: 1000 });
  const again = await submitOn(member, '2026-10-01', { steps: 2000 });
  const third = await submitOn(member, '2026-10-01', { steps: 3000 });
  for (const r of [again, third]) {
    assert.equal(r.rewards.rewardAwarded, false);
    assert.equal(r.rewards.coinsAwarded, 0);
    assert.equal(r.rewards.currentStreak, 1);
    assert.deepEqual(r.rewards.coins, { balance: 5, totalEarned: 5 });
  }
  assert.equal(third.dailyUpdate.activity.steps, 3000, 'the update itself still saved');
});

test('missed days never reset the count or take coins; lastUpdatedDate follows the latest counted day', async () => {
  for (const day of ['2026-10-01', '2026-10-03', '2026-10-05']) await submitOn(member, day);
  const { streaks, coins } = await docs(member);
  assert.equal(streaks.length, 1, 'updated, not duplicated');
  assert.equal(streaks[0].currentStreak, 3);
  assert.equal(streaks[0].lastUpdatedDate, '2026-10-05');
  assert.deepEqual([coins.length, coins[0].balance, coins[0].totalEarned], [1, 15, 15]);
});

test('concurrent first submissions of a day reward it once - and create one document each', async () => {
  const results = await Promise.all(
    ['a', 'b', 'c'].map((id) => submitOn(member, '2026-10-02', { submissionId: id })),
  );
  assert.equal(results.filter((r) => r.rewards?.rewardAwarded).length, 1);
  const { streaks, coins } = await docs(member);
  assert.deepEqual([streaks.length, streaks[0].currentStreak], [1, 1]);
  assert.deepEqual([coins.length, coins[0].balance, coins[0].totalEarned], [1, 5, 5]);
});

test('a retry of a submission whose response was lost is not rewarded again', async () => {
  const first = await submitOn(member, '2026-10-02', { submissionId: 'tap-1' });
  const retry = await submitOn(member, '2026-10-02', { submissionId: 'tap-1' });
  assert.equal(first.rewards.rewardAwarded, true);
  assert.equal(retry.rewards.rewardAwarded, false);
  assert.deepEqual(retry.rewards.coins, { balance: 5, totalEarned: 5 });
});

test('a failed reward rolls back whole (nothing half-counted); the day\'s next submission rewards it once', async () => {
  const original = GoGetFitCoins.updateOne;
  GoGetFitCoins.updateOne = () => {
    throw new Error('coins write failed');
  };
  let res;
  try {
    res = await submitOn(member, '2026-10-02', { steps: 1000 });
  } finally {
    GoGetFitCoins.updateOne = original;
  }
  assert.equal(res.rewards, null, 'the Daily Update answer says the reward could not be worked out');
  assert.equal(res.dailyUpdate.activity.steps, 1000, 'the update itself saved');
  assert.equal((await DailyUpdate.findOne({ clientId: member._id }).lean()).rewardedAt, null, 'claim rolled back');
  assert.deepEqual(await docs(member), { streaks: [], coins: [] }, 'streak rolled back too');

  const next = await submitOn(member, '2026-10-02', { steps: 2000 });
  assert.equal(next.rewards.rewardAwarded, true);
  assert.equal((await submitOn(member, '2026-10-02', { steps: 3000 })).rewards.rewardAwarded, false);
  assert.deepEqual((await docs(member)).coins.map((c) => c.balance), [5]);
});

test('only days of the active plan: before it starts and after it ends a Daily Update is refused and earns nothing; coins are kept', async () => {
  const notActive = (e) => e.statusCode === 403 && e.code === 'INTAKE_PLAN_NOT_ACTIVE';
  // Before the plan's first day (no Intake is possible either).
  await assert.rejects(dailyUpdateOnly(member, '2026-09-30'), notActive);
  await submitOn(member, '2026-10-01');
  // The plan has ended (its last day is 24 Dec): refused, and the 5 coins stay.
  await assert.rejects(dailyUpdateOnly(member, '2026-12-25'), notActive);
  const { streaks, coins } = await docs(member);
  assert.deepEqual([streaks[0].currentStreak, coins[0].balance, coins[0].totalEarned], [1, 5, 5]);
  // A member with no plan at all: refused, nothing saved, nothing made up.
  await assert.rejects(dailyUpdateOnly(other, '2026-10-01'), notActive);
  assert.deepEqual(await docs(other), { streaks: [], coins: [] });
  assert.equal(await DailyUpdate.countDocuments({ date: { $in: ['2026-09-30', '2026-12-25'] } }), 0);
  assert.equal(await DailyUpdate.countDocuments({ clientId: other._id }), 0);
});

test('the count never passes the plan\'s days', async () => {
  const oneWeek = await GogetfitPlan.create({ name: '1 WEEK', planType: 'Enrollment', coachLevel: 'LEVEL 1', durationWeeks: 1, personsAllowed: 1, pricing: { basePrice: 1, reward: 0 } });
  await EnrolledClient.deleteMany({ userId: member._id });
  await enroll(member, { weeks: 1, p: oneWeek });
  // 1 Oct to 8 Oct: eight dated days, seven plan days.
  const days = ['01', '02', '03', '04', '05', '06', '07', '08'].map((d) => `2026-10-${d}`);
  let last;
  for (const day of days) last = await submitOn(member, day);
  assert.equal(last.rewards.rewardAwarded, false);
  assert.equal(last.rewards.currentStreak, 7);
  assert.equal(last.rewards.planDays, 7);
  assert.deepEqual(last.rewards.coins, { balance: 35, totalEarned: 35 });
  assert.equal(await DailyUpdate.countDocuments({ clientId: member._id, rewardedAt: { $ne: null } }), 7);
});

test('a new plan starts its own count; the coins carry on in the same document', async () => {
  await submitOn(member, '2026-10-01');
  await submitOn(member, '2026-10-02');
  // That plan ends; a new one is bought and started.
  await EnrolledClient.updateOne({ _id: enrollment._id }, { $set: { endDate: istMidnight('2026-10-03') } });
  const next = await enroll(member, { start: '2026-10-10', enrollDate: '2026-10-09' });
  const res = await submitOn(member, '2026-10-10');
  assert.equal(res.rewards.currentStreak, 1);
  assert.deepEqual(res.rewards.coins, { balance: 15, totalEarned: 15 });
  const { streaks, coins } = await docs(member);
  assert.deepEqual([streaks.length, coins.length], [1, 1]);
  assert.equal(String(streaks[0].enrollmentId), String(next._id));
});

test('HTTP: PUT answers with the rewards; GET /users/me/rewards reads them; the body can\'t set anything; members are separate', async () => {
  const today = businessDayOf(new Date());
  await EnrolledClient.deleteMany({ userId: member._id });
  await EnrolledClient.create({
    userId: member._id,
    planId: plan._id,
    coachId: coach._id,
    enrollDate: new Date(Date.now() - 2 * 86_400_000),
    startDate: new Date(Date.now() - 86_400_000),
    endDate: new Date(Date.now() + 80 * 86_400_000),
    hasStarted: true,
    isDeleted: false,
  });
  const intake = await server.request('PUT', '/api/users/me/food-log', {
    body: { meals: [{ meal: 1, foods: [{ entryId: 'e1', foodId: String(rice._id), qty: 100 }] }] },
    token: tokenFor(member),
  });
  assert.equal(intake.status, 200, JSON.stringify(intake.body));
  const put = await server.request('PUT', `/api/users/me/daily-updates/${today}`, {
    body: body({ currentStreak: 99, balance: 999, clientId: String(other._id), rewardAwarded: true }),
    token: tokenFor(member),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.data.rewards.currentStreak, 1);
  assert.deepEqual(put.body.data.rewards.coins, { balance: 5, totalEarned: 5 });

  const mine = await server.request('GET', '/api/users/me/rewards', { token: tokenFor(member) });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.rewards.currentStreak, 1);
  assert.equal(mine.body.data.rewards.coins.balance, 5);
  const theirs = await server.request('GET', '/api/users/me/rewards', { token: tokenFor(other) });
  assert.deepEqual(theirs.body.data.rewards.coins, { balance: 0, totalEarned: 0 });
  assert.equal((await server.request('GET', '/api/users/me/rewards')).status, 401);
});

test('a bought plan the coach has not started never earns: its Daily Update is refused, and so is its Intake; coins kept', async () => {
  await submitOn(member, '2026-10-01'); // 1 day, 5 coins on the started plan
  const notActive = (e) => e.statusCode === 403 && e.code === 'INTAKE_PLAN_NOT_ACTIVE';

  // Bought, never started - and the odd rows: started without a start date,
  // or deleted. None is an active plan: nothing saved, nothing earned.
  for (const [i, change] of [
    { hasStarted: false, startDate: null, endDate: null },
    { hasStarted: true, startDate: null, endDate: new Date('2099-01-01') },
    { isDeleted: true },
  ].entries()) {
    await EnrolledClient.updateOne({ _id: enrollment._id }, { $set: { hasStarted: false, isDeleted: false, startDate: null, endDate: null, ...change } });
    const day = `2026-10-1${i}`;
    await assert.rejects(intakeOn(member, day), notActive, `intake, case ${i}`);
    await assert.rejects(dailyUpdateOnly(member, day), notActive, `daily update, case ${i}`);
  }
  const { streaks, coins } = await docs(member);
  assert.deepEqual([streaks.length, coins.length, streaks[0].currentStreak, coins[0].balance], [1, 1, 1, 5]);
  assert.equal(await DailyUpdate.countDocuments({ clientId: member._id }), 1);
});

test('a bought plan not started still reads 0 / 84 (its length), but earns nothing until the coach starts it', async () => {
  await EnrolledClient.updateOne({ _id: enrollment._id }, { $set: { hasStarted: false, startDate: null, endDate: null } });
  const read = await server.request('GET', '/api/users/me/rewards', { token: tokenFor(member) });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data.rewards, {
    currentStreak: 0,
    planDays: 84,
    lastUpdatedDate: null,
    coins: { balance: 0, totalEarned: 0 },
    rewardAwarded: false,
    coinsAwarded: 0,
  });
  await assert.rejects(dailyUpdateOnly(member, '2026-10-05'), (e) => e.code === 'INTAKE_PLAN_NOT_ACTIVE');
  assert.deepEqual(await docs(member), { streaks: [], coins: [] });
  // A deleted plan is not "current": no plan length.
  await EnrolledClient.updateOne({ _id: enrollment._id }, { $set: { isDeleted: true } });
  const none = await server.request('GET', '/api/users/me/rewards', { token: tokenFor(member) });
  assert.equal(none.body.data.rewards.planDays, null);
});
