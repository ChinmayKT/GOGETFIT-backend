import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import Coach from '../../src/models/coach.model.js';
import EnrolledClient from '../../src/models/enrolled-client.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';
import User from '../../src/models/user.model.js';
import { applyCoachLinks, planCoachLinks } from '../../migration/scripts/link-legacy-coaches.js';
import { clearTestDb, connectTestDb, disconnectTestDb } from '../helpers/test-server.js';

let plan;
let prajwalCoach;
let siriCoach;

let seq = 0;
const seedUser = (name, email = null, roles = ['user']) => {
  seq += 1;
  const phone = `9182000${String(seq).padStart(5, '0')}`;
  return User.create({ phone: { raw: phone, normalized: phone }, profile: { name, email }, roles, status: 'active' });
};
const seedCoach = async (name, email) => {
  const user = await seedUser(name, email, ['user', 'coach']);
  return Coach.create({ userId: user._id, profile: { level: 'LEVEL 1' } });
};

let legacyId = 1000;
/** A migrated enrollment carrying the legacy coach's name and email. */
const legacyEnrollment = async (member, { coachName, coachEmail, coachId = null, legacyCoachId = 13 } = {}) => {
  legacyId += 1;
  return EnrolledClient.create({
    userId: member._id,
    planId: plan._id,
    coachId,
    enrollDate: new Date(Date.UTC(2024, 0, legacyId % 28 + 1)),
    payment: { transactionId: `pay_link_${legacyId}`, amount: 4999, currency: 'INR', status: 'Success' },
    legacy: { source: 'gogetfit', enrollmentId: legacyId, userId: 200 + legacyId, packageId: 15, coachId: legacyCoachId, coachName, coachEmail },
  });
};

before(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  plan = await GogetfitPlan.create({
    name: '12 WEEKS GOGETFIT PLAN',
    planType: 'Enrollment',
    coachLevel: 'LEVEL 1',
    durationWeeks: 12,
    personsAllowed: 1,
    pricing: { basePrice: 4999, reward: 0 },
    legacy: { source: 'gogetfit', packageId: 15 },
  });
  prajwalCoach = await seedCoach('Prajwal', 'prajwal@gogetfitonline.com');
  siriCoach = await seedCoach('Siri Shankar C', 'siri@gogetfitonline.com');
});
after(disconnectTestDb);

const reload = (doc) => EnrolledClient.findById(doc._id).lean();

test('dry run: links by email and by name, reports the rest, writes nothing', async () => {
  const asha = await seedUser('Asha');
  const ravi = await seedUser('Ravi');
  const byEmail = await legacyEnrollment(asha, { coachName: 'Prajwal A T', coachEmail: ' PRAJWAL@gogetfitonline.com ' });
  const byName = await legacyEnrollment(ravi, { coachName: 'siri  shankar c', coachEmail: null, legacyCoachId: 14 });
  await legacyEnrollment(ravi, { coachName: 'Karthik M', coachEmail: 'karthik@gogetfitonline.com', legacyCoachId: 17 });
  const before = JSON.stringify(await EnrolledClient.find().sort({ _id: 1 }).lean());

  const p = await planCoachLinks();
  assert.equal(JSON.stringify(await EnrolledClient.find().sort({ _id: 1 }).lean()), before); // nothing written
  assert.deepEqual(p.summary, {
    totalLegacyEnrollments: 3,
    alreadyLinked: 0,
    toLink: 2,
    unmatched: 1,
    ambiguous: 0,
    conflicting: 0,
    danglingLinks: 0,
    newCoaches: 2,
  });
  const matched = p.groups.filter((g) => g.result.status === 'matched');
  assert.deepEqual(matched.map((g) => [g.result.coach.coachId, g.result.by]).sort(), [
    [String(prajwalCoach._id), 'email'],
    [String(siriCoach._id), 'name'],
  ].sort());
  const karthik = p.groups.find((g) => g.legacyName === 'Karthik M');
  assert.equal(karthik.result.status, 'unmatched');
  assert.equal(karthik.enrollments.length, 1);
  // The proposed links carry what is needed to verify them.
  const row = matched.find((g) => g.result.by === 'email').enrollments[0];
  assert.equal(row.enrollmentId, String(byEmail._id));
  assert.equal(row.userName, 'Asha');
  assert.ok(row.phone && row.plan && row.enrollDate && row.legacyEnrollmentId);
  assert.ok(byName);
});

test('apply: assigns coachId, records how, keeps every legacy field', async () => {
  const asha = await seedUser('Asha');
  const e = await legacyEnrollment(asha, { coachName: 'Prajwal A T', coachEmail: 'prajwal@gogetfitonline.com' });
  const legacyBefore = (await reload(e)).legacy;

  const result = await applyCoachLinks(await planCoachLinks());
  assert.equal(result.linked, 1);

  const after = await reload(e);
  assert.equal(String(after.coachId), String(prajwalCoach._id));
  assert.equal(after.legacy.coachResolvedBy, 'email');
  // Legacy coach name/email (and everything else in legacy) untouched.
  assert.deepEqual({ ...after.legacy, coachResolvedBy: undefined }, { ...legacyBefore, coachResolvedBy: undefined });
  assert.equal(after.legacy.coachName, 'Prajwal A T');
  assert.equal(after.legacy.coachEmail, 'prajwal@gogetfitonline.com');
});

test('an already-linked enrollment is left exactly as it is', async () => {
  const asha = await seedUser('Asha');
  // Linked to Siri although its legacy coach is Prajwal: a valid link is never overwritten.
  const e = await legacyEnrollment(asha, { coachName: 'Prajwal A T', coachEmail: 'prajwal@gogetfitonline.com', coachId: siriCoach._id });
  const before = await reload(e);

  const p = await planCoachLinks();
  assert.equal(p.summary.alreadyLinked, 1);
  assert.equal(p.summary.toLink, 0);
  await applyCoachLinks(p);
  assert.deepEqual(await reload(e), before);
});

test('ambiguous and conflicting coaches are reported and NOT linked', async () => {
  await seedCoach('Twin', 'prajwal@gogetfitonline.com'); // a second coach with Prajwal's email
  const asha = await seedUser('Asha');
  const ambiguous = await legacyEnrollment(asha, { coachName: 'Prajwal A T', coachEmail: 'prajwal@gogetfitonline.com' });
  const conflicting = await legacyEnrollment(asha, { coachName: 'Siri Shankar C', coachEmail: 'siri.old@gmail.com', legacyCoachId: 14 });

  const p = await planCoachLinks();
  assert.equal(p.summary.ambiguous, 1);
  assert.equal(p.summary.conflicting, 1);
  const result = await applyCoachLinks(p);
  assert.equal(result.linked, 0);
  assert.equal((await reload(ambiguous)).coachId, null);
  assert.equal((await reload(conflicting)).coachId, null);
});

test('idempotent: a second apply changes nothing', async () => {
  const asha = await seedUser('Asha');
  const e = await legacyEnrollment(asha, { coachName: 'Prajwal A T', coachEmail: 'prajwal@gogetfitonline.com' });
  await applyCoachLinks(await planCoachLinks());
  const once = await reload(e);

  const second = await planCoachLinks();
  assert.equal(second.summary.toLink, 0);
  assert.equal(second.summary.alreadyLinked, 1);
  const result = await applyCoachLinks(second);
  assert.equal(result.linked, 0);
  assert.deepEqual(await reload(e), once);
  assert.equal(await EnrolledClient.countDocuments(), 1);
});

test('several enrollments of one client are all linked and all kept', async () => {
  const asha = await seedUser('Asha');
  for (let i = 0; i < 3; i += 1) await legacyEnrollment(asha, { coachName: 'Prajwal A T', coachEmail: 'prajwal@gogetfitonline.com' });

  const p = await planCoachLinks();
  assert.equal(p.summary.toLink, 3);
  await applyCoachLinks(p);
  const rows = await EnrolledClient.find({ userId: asha._id }).lean();
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => String(r.coachId) === String(prajwalCoach._id)));
});

test('no enrollment is silently dropped: every one is counted, deleted ones too', async () => {
  const asha = await seedUser('Asha');
  await legacyEnrollment(asha, { coachName: 'Prajwal A T', coachEmail: 'prajwal@gogetfitonline.com' });
  await legacyEnrollment(asha, { coachName: 'Karthik M', coachEmail: 'karthik@gogetfitonline.com' });
  await legacyEnrollment(asha, { coachName: null, coachEmail: null }); // nothing to match on
  const deleted = await legacyEnrollment(asha, { coachName: 'Prajwal A T', coachEmail: 'prajwal@gogetfitonline.com' });
  await EnrolledClient.updateOne({ _id: deleted._id }, { $set: { isDeleted: true } });
  // A coachId pointing at no Coach is not a valid link: it is re-resolved.
  const dangling = await legacyEnrollment(asha, { coachName: 'Siri Shankar C', coachEmail: 'siri@gogetfitonline.com', coachId: new mongoose.Types.ObjectId() });

  const p = await planCoachLinks();
  const s = p.summary;
  assert.equal(s.totalLegacyEnrollments, 5);
  assert.equal(s.alreadyLinked + s.toLink + s.unmatched + s.ambiguous + s.conflicting, 5);
  assert.equal(s.unmatched, 2);
  assert.equal(s.danglingLinks, 1);
  await applyCoachLinks(p);
  assert.equal(String((await reload(dangling)).coachId), String(siriCoach._id));
  assert.equal(await EnrolledClient.countDocuments(), 5);
});

test('after linking, the coach details API picks the historical enrollments up by coachId', async () => {
  const { getCoachClients } = await import('../../src/services/coach-dashboard.service.js');
  const asha = await seedUser('Asha');
  await legacyEnrollment(asha, { coachName: 'Prajwal A T', coachEmail: 'prajwal@gogetfitonline.com' });
  assert.equal((await getCoachClients(String(prajwalCoach._id))).summary.totalEnrollments, 0);
  await applyCoachLinks(await planCoachLinks());
  assert.equal((await getCoachClients(String(prajwalCoach._id))).summary.totalEnrollments, 1);
});
