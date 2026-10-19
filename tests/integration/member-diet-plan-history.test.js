import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import DietPlan from '../../src/models/diet-plan.model.js';
import Food from '../../src/models/food.model.js';
import User from '../../src/models/user.model.js';
import { getDietPlanHistoryForUser } from '../../src/services/diet-plan.service.js';
import { addCalendarDays, businessDayOf, startOfBusinessDay } from '../../src/utils/business-date.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let alice;
let bob;
let aliceToken;
let prajwal;
let siri;
let rice;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9186000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};
const day = (d) => startOfBusinessDay(d);
const today = () => businessDayOf(new Date());

const plan = (overrides = {}) => ({
  planId: 'gogetfit:173',
  clientId: alice._id,
  coachId: prajwal._id,
  name: 'Jeevika meal plan',
  fromDate: day('2024-06-17'),
  toDate: day('2024-09-09'),
  assignedAt: new Date('2024-06-16T13:36:38Z'),
  goal: 'Fat/Weight Loss',
  bmr: 1369.93,
  tdee: 1883.65,
  targets: { calories: 1633, fat: 36, carbs: 204, protein: 122 },
  meals: [{ meal: 1, foods: [{ foodId: rice._id, qty: 200, portion: 100, servingUnit: 'Grams', calories: 113, fat: 3.5, carbs: 19, protein: 2 }] }],
  ...overrides,
});

const history = (token = aliceToken) => server.request('GET', '/api/users/me/diet-plans/history', { token });

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  prajwal = await Coach.create({ userId: (await seedUser(['user', 'coach'], 'Prajwal'))._id, profile: { level: 'LEVEL 1' } });
  siri = await Coach.create({ userId: (await seedUser(['user', 'coach'], 'Siri'))._id, profile: { level: 'LEVEL 2' } });
  alice = await seedUser(['user', 'client'], 'Jeevika');
  bob = await seedUser(['user', 'client'], 'Bob');
  aliceToken = tokenFor(alice);
  rice = await Food.create({ name: 'Rice', foodType: 'Vegetarian', servingUnit: 'Grams', servingQuantity: 100, calories: 1, fat: 1, carbs: 1, protein: 1 });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('requires a signed-in user', async () => {
  assert.equal((await server.request('GET', '/api/users/me/diet-plans/history', {})).status, 401);
});

test('a member with no plans gets an empty history', async () => {
  const res = await history();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.plans, []);
  assert.deepEqual(res.body.data.client, { id: String(alice._id), name: 'Jeevika' });
});

test('only the signed-in member\'s plans are returned; a userId in the URL is ignored', async () => {
  await DietPlan.create(plan({ clientId: bob._id, name: 'Bob plan', planId: 'gogetfit:9' }));
  const res = await server.request('GET', `/api/users/me/diet-plans/history?userId=${bob._id}&clientId=${bob._id}`, { token: aliceToken });
  assert.deepEqual(res.body.data.plans, []);
  assert.equal((await history(tokenFor(bob))).body.data.plans[0].name, 'Bob plan');
});

test('date-run documents of one plan become one item, with every run kept', async () => {
  const a = await DietPlan.create(plan({ fromDate: day('2024-06-17'), toDate: day('2024-09-09') }));
  const b = await DietPlan.create(plan({ fromDate: day('2024-09-10'), toDate: day('2024-09-28') }));
  const { plans } = (await history()).body.data;

  assert.equal(plans.length, 1);
  const [p] = plans;
  assert.equal(p.planId, 'gogetfit:173');
  assert.equal(p.name, 'Jeevika meal plan');
  assert.deepEqual(p.coach, { id: String(prajwal._id), name: 'Prajwal', level: 'LEVEL 1' });
  assert.deepEqual(p.targets, { calories: 1633, protein: 122, carbs: 204, fat: 36 });
  assert.equal(p.goal, 'Fat/Weight Loss');
  assert.deepEqual(p.ranges, [
    { dietPlanId: String(a._id), fromDate: '2024-06-17', toDate: '2024-09-09', days: 85 },
    { dietPlanId: String(b._id), fromDate: '2024-09-10', toDate: '2024-09-28', days: 19 },
  ]);
  // Back-to-back runs are one continuous coverage.
  assert.deepEqual(p.coverage, [{ fromDate: '2024-06-17', toDate: '2024-09-28', days: 104 }]);
  assert.equal(p.coveredDays, 104);
  assert.equal(p.openDate, '2024-09-28');
  assert.equal(p.latestDate, '2024-09-28');
  assert.equal('meals' in p, false);
});

test('a gap between runs is kept as a gap', async () => {
  await DietPlan.create(plan({ fromDate: day('2024-07-01'), toDate: day('2024-07-10') }));
  await DietPlan.create(plan({ fromDate: day('2024-07-12'), toDate: day('2024-07-20') }));
  const [p] = (await history()).body.data.plans;
  assert.deepEqual(p.coverage, [
    { fromDate: '2024-07-01', toDate: '2024-07-10', days: 10 },
    { fromDate: '2024-07-12', toDate: '2024-07-20', days: 9 },
  ]);
  assert.equal(p.coveredDays, 19);
});

test('same name or coach never merges two different plans', async () => {
  await DietPlan.create(plan({ planId: 'gogetfit:1', fromDate: day('2024-01-01'), toDate: day('2024-01-05') }));
  await DietPlan.create(plan({ planId: 'gogetfit:2', fromDate: day('2024-02-01'), toDate: day('2024-02-05') }));
  assert.deepEqual((await history()).body.data.plans.map((p) => p.planId), ['gogetfit:2', 'gogetfit:1']);
});

test('history is newest first by last covered day, and coaches resolve per plan', async () => {
  await DietPlan.create(plan({ planId: 'gogetfit:150', name: 'May plan', coachId: siri._id, fromDate: day('2024-05-01'), toDate: day('2024-05-31') }));
  await DietPlan.create(plan({ planId: 'gogetfit:173', name: 'July plan', fromDate: day('2024-07-01'), toDate: day('2024-07-28') }));
  await DietPlan.create(plan({ planId: 'gogetfit:166', name: 'June plan', fromDate: day('2024-06-01'), toDate: day('2024-06-30') }));
  const { plans } = (await history()).body.data;
  assert.deepEqual(plans.map((p) => [p.name, p.coach.name]), [['July plan', 'Prajwal'], ['June plan', 'Prajwal'], ['May plan', 'Siri']]);
});

test('a plan still running or starting later is not history', async () => {
  await DietPlan.create(plan({ planId: 'gogetfit:now', name: 'Current', fromDate: day(addCalendarDays(today(), -3)), toDate: day(addCalendarDays(today(), 3)) }));
  await DietPlan.create(plan({ planId: 'gogetfit:next', name: 'Upcoming', fromDate: day(addCalendarDays(today(), 5)), toDate: day(addCalendarDays(today(), 9)) }));
  await DietPlan.create(plan({ planId: 'gogetfit:old', name: 'Old', fromDate: day('2024-06-01'), toDate: day('2024-06-03') }));
  // A plan whose last run ends today is still current.
  await DietPlan.create(plan({ planId: 'gogetfit:ends-today', name: 'Ends today', fromDate: day('2024-01-01'), toDate: day('2024-01-02') }));
  await DietPlan.create(plan({ planId: 'gogetfit:ends-today', name: 'Ends today', fromDate: day(today()), toDate: day(today()) }));
  assert.deepEqual((await history()).body.data.plans.map((p) => p.name), ['Old']);
});

test('shown days follow newest-wins: the open date is a day the member really saw', async () => {
  // Older plan 1..10 June; a newer one takes 8..10 June.
  await DietPlan.create(plan({ planId: 'gogetfit:95', name: 'Older', fromDate: day('2024-06-01'), toDate: day('2024-06-10'), assignedAt: new Date('2024-05-01') }));
  await DietPlan.create(plan({ planId: 'gogetfit:96', name: 'Newer', fromDate: day('2024-06-08'), toDate: day('2024-06-10'), assignedAt: new Date('2024-06-07') }));
  const plans = (await history()).body.data.plans;
  const older = plans.find((p) => p.name === 'Older');
  assert.deepEqual(older.coverage, [{ fromDate: '2024-06-01', toDate: '2024-06-10', days: 10 }]);
  assert.deepEqual(older.shown, [{ fromDate: '2024-06-01', toDate: '2024-06-07', days: 7 }]);
  assert.equal(older.openDate, '2024-06-07');

  // Opening it at openDate resolves to that plan through the day lookup.
  const res = await server.request('GET', `/api/users/me/diet-plan?date=${older.openDate}`, { token: aliceToken });
  assert.equal(res.body.data.dietPlan.planId, 'gogetfit:95');

  // A plan newer ones hide entirely has no open date.
  await DietPlan.create(plan({ planId: 'gogetfit:97', name: 'Hidden', fromDate: day('2024-06-02'), toDate: day('2024-06-03'), assignedAt: new Date('2024-01-01') }));
  const hidden = (await history()).body.data.plans.find((p) => p.name === 'Hidden');
  assert.deepEqual(hidden.shown, []);
  assert.equal(hidden.openDate, null);
});

test('archived plans are not history', async () => {
  await DietPlan.create(plan({ status: 'archived' }));
  assert.deepEqual((await history()).body.data.plans, []);
});

test('the history read never touches the foods collection', async () => {
  await DietPlan.create(plan());
  const collections = [];
  mongoose.set('debug', (collection) => collections.push(collection));
  try {
    await getDietPlanHistoryForUser(String(alice._id));
  } finally {
    mongoose.set('debug', false);
  }
  assert.ok(collections.includes('dietplans'));
  assert.equal(collections.includes('foods'), false, collections.join(','));
});

test('reading history never changes a plan', async () => {
  const doc = await DietPlan.create(plan());
  const beforeRead = await DietPlan.findById(doc._id).lean();
  await history();
  assert.deepEqual(await DietPlan.findById(doc._id).lean(), beforeRead);
});
