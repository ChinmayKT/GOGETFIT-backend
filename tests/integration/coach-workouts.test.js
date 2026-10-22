import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import Coach from '../../src/models/coach.model.js';
import User from '../../src/models/user.model.js';
import Workout from '../../src/models/workout.model.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * The coach's workout picker: GET /api/coach/workouts - active workouts from
 * the Workout master, name A-Z, searched and filtered by type, paged, with
 * only what the picker shows.
 */
let server;
let coachUser;
let member;
let admin;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
let seq = 0;
const seedUser = (roles, name) => {
  seq += 1;
  const phone = `9177100${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name }, roles, status: 'active' });
};
const workout = (o) =>
  Workout.create({
    type: 'General',
    equipment: 'Body Weight',
    primaryMuscle: 'Legs',
    level: 2,
    description: 'Stand tall.',
    createdBy: admin._id,
    updatedBy: admin._id,
    ...o,
  });
const list = (qs = '', user = coachUser) => server.request('GET', `/api/coach/workouts${qs}`, { token: tokenFor(user) });
const names = (res) => res.body.data.items.map((i) => i.name);

before(async () => {
  await connectTestDb();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  await Workout.deleteMany({}); // (gogetfit_test only - see test-server.js)
  coachUser = await seedUser(['user', 'coach'], 'Prajwal');
  await Coach.create({ userId: coachUser._id, profile: { level: 'LEVEL 1' } });
  member = await seedUser(['user', 'client'], 'Bob');
  admin = await seedUser(['user', 'admin'], 'Admin');
  await workout({
    name: 'Squat',
    primaryMuscle: 'Legs (Warm Up)',
    thumbnail: { url: 'http://x/uploads/workouts/a/thumbnail/t.jpg', storageKey: 'workouts/a/thumbnail/t.jpg' },
    video: { url: 'http://x/uploads/workouts/a/video/v.mp4', storageKey: 'workouts/a/video/v.mp4' },
    legacy: { source: 'mysql', workoutId: 7 },
  });
  await workout({ name: 'Bench Press', type: 'Gym', equipment: 'Gym Equipment', primaryMuscle: 'Chest', secondaryMuscle: 'Triceps', level: 3 });
  await workout({ name: 'Band Row', type: 'Home', equipment: 'Resistance Band', primaryMuscle: 'Back' });
  await workout({ name: 'Arm Circles', primaryMuscle: 'Shoulder (Cool Down)' });
  await workout({ name: 'Old Move', status: 'archived' });
});

after(async () => {
  await server.close();
  await disconnectTestDb();
});

test('active workouts, A-Z, with only what the picker shows', async () => {
  const res = await list();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(names(res), ['Arm Circles', 'Band Row', 'Bench Press', 'Squat'], 'no archived');
  assert.deepEqual(res.body.data.types, ['Gym', 'Home', 'General'], 'the schema\'s own categories');
  const squat = res.body.data.items[3];
  assert.equal(squat.type, 'General');
  assert.equal(squat.equipment, 'Body Weight');
  assert.equal(squat.primaryMuscle, 'Legs (Warm Up)');
  assert.equal(squat.level, 2);
  assert.equal(squat.description, 'Stand tall.');
  assert.deepEqual(squat.thumbnail, { url: 'http://x/uploads/workouts/a/thumbnail/t.jpg' });
  assert.equal(squat.hasVideo, true);
  // The playable video, by URL only - never its storage key.
  assert.deepEqual(squat.video, { url: 'http://x/uploads/workouts/a/video/v.mp4' });
  assert.equal(res.body.data.items[0].video, null);
  for (const k of ['createdBy', 'updatedBy', 'legacy', 'migration', 'status', 'storageKey']) assert.ok(!(k in squat), k);
  assert.equal(res.body.data.items[0].thumbnail, null);
  assert.deepEqual(res.body.data.pagination, { page: 1, pageSize: 30, total: 4, hasMore: false });
});

test('search: name and muscles, any case, trimmed, literal', async () => {
  assert.deepEqual(names(await list('?search=%20bench%20')), ['Bench Press']);
  assert.deepEqual(names(await list('?search=TRICEPS')), ['Bench Press'], 'secondary muscle');
  assert.deepEqual(names(await list('?search=warm%20up')), ['Squat'], 'primary muscle text');
  assert.deepEqual(names(await list(`?search=${encodeURIComponent('.*')}`)), []);
  assert.equal((await list(`?search=${encodeURIComponent('(')}`)).status, 200);
  assert.deepEqual(names(await list('?search=old')), [], 'archived stays out');
});

test('type filters, alone and with a search', async () => {
  assert.deepEqual(names(await list('?type=General')), ['Arm Circles', 'Squat']);
  assert.deepEqual(names(await list('?type=Gym')), ['Bench Press']);
  assert.deepEqual(names(await list('?type=General&search=circles')), ['Arm Circles']);
  assert.deepEqual(names(await list('?type=Home&search=circles')), []);
});

test('pages neither repeat nor skip; the total is of the matches', async () => {
  const seen = [];
  for (let page = 1; page <= 2; page += 1) {
    const res = await list(`?pageSize=2&page=${page}`);
    seen.push(...names(res));
    assert.equal(res.body.data.pagination.total, 4);
    assert.equal(res.body.data.pagination.hasMore, page < 2);
  }
  assert.deepEqual(seen, ['Arm Circles', 'Band Row', 'Bench Press', 'Squat']);
  assert.equal((await list('?type=General&pageSize=1')).body.data.pagination.total, 2);
  assert.equal((await list('?pageSize=999')).body.data.pagination.pageSize, 50, 'capped');
});

test('bad parameters are a 400', async () => {
  for (const qs of ['?type=Cardio', '?type=general', '?page=0', '?page=x', '?pageSize=-1', `?search=${'a'.repeat(101)}`]) {
    const res = await list(qs);
    assert.equal(res.status, 400, qs);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
});

test('reading changes nothing; only coaches may read', async () => {
  const before = await Workout.find().sort({ _id: 1 }).lean();
  await list('?search=squat');
  assert.deepEqual(await Workout.find().sort({ _id: 1 }).lean(), before);
  assert.equal((await server.request('GET', '/api/coach/workouts')).status, 401);
  assert.equal((await list('', member)).status, 403);
});
