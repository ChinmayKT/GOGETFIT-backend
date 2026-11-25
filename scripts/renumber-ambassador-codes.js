/**
 * Moves every Brand Ambassador code still in the old name format (e.g.
 * CHI0001) onto the GGF sequence, oldest registration first: the first
 * becomes the next free GGF number (GGF0001 on a fresh counter), the
 * second the one after, and so on.
 *
 * Per ambassador, in one transaction: the coupon's code, the code snapshot on
 * its referrals, an activity entry (before / after), and the GGF counter is
 * moved past the numbers used so new registrations continue after them.
 * Orders link to the ambassador by id, so purchases, commissions and payouts
 * are untouched. Nothing is deleted. Safe to run again: GGF codes are skipped.
 *
 * The old code stops working at checkout once it is renumbered.
 *
 *   node scripts/renumber-ambassador-codes.js           # dry run: what would change
 *   node scripts/renumber-ambassador-codes.js --apply   # write it
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const PREFIX = 'GGF';
const GGF_CODE = /^GGF\d{4,}$/;
const apply = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const coupons = db.collection('brand_ambassador_coupons');
const referrals = db.collection('brand_ambassador_referrals');
const activities = db.collection('brand_ambassador_activities');
const sequences = db.collection('brand_ambassador_sequences');
const adminCoupons = db.collection('coupons');
console.log(`Database: ${db.databaseName}${apply ? '' : ' (dry run)'}`);

const all = await coupons.find({}).sort({ createdAt: 1, _id: 1 }).toArray();
const old = all.filter((c) => !GGF_CODE.test(c.couponCode));
const used = Math.max(
  0,
  (await sequences.findOne({ _id: PREFIX }))?.seq ?? 0,
  ...all.filter((c) => GGF_CODE.test(c.couponCode)).map((c) => Number(c.couponCode.slice(PREFIX.length))),
);

let next = used;
const plan = [];
for (const c of old) {
  let code;
  do {
    next += 1;
    code = `${PREFIX}${String(next).padStart(4, '0')}`;
  } while ((await coupons.findOne({ couponCode: code })) || (await adminCoupons.findOne({ code })));
  plan.push({ doc: c, code, seq: next });
}

for (const { doc, code } of plan) {
  const n = await referrals.countDocuments({ ambassadorCouponId: doc._id });
  console.log(`${doc.couponCode} -> ${code}  (registered ${doc.createdAt?.toISOString()}, user ${doc.userId}, ${n} referrals)`);
}
if (plan.length === 0) console.log('Nothing to renumber.');

let changed = 0;
if (apply) {
  for (const { doc, code, seq } of plan) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Matched on the code as read, so a record changed meanwhile is skipped.
        const res = await coupons.updateOne(
          { _id: doc._id, couponCode: doc.couponCode },
          { $set: { couponCode: code, updatedAt: new Date() } },
          { session },
        );
        if (res.modifiedCount !== 1) {
          console.log(`  skipped ${doc.couponCode}: changed since it was read`);
          return;
        }
        await referrals.updateMany(
          { ambassadorCouponId: doc._id, couponCode: doc.couponCode },
          { $set: { couponCode: code, updatedAt: new Date() } },
          { session },
        );
        await activities.insertOne(
          {
            ambassadorCouponId: doc._id,
            entityType: 'ambassador',
            entityId: doc._id,
            action: 'coupon_code_changed',
            detail: `Coupon ${doc.couponCode} changed to ${code}`,
            actorId: null,
            actorRole: 'system',
            before: { couponCode: doc.couponCode },
            after: { couponCode: code },
            at: new Date(),
          },
          { session },
        );
        await sequences.updateOne({ _id: PREFIX }, { $max: { seq } }, { upsert: true, session });
        changed += 1;
      });
    } finally {
      await session.endSession();
    }
  }
  console.log(`Renumbered ${changed} of ${plan.length}.`);
}

await mongoose.disconnect();
