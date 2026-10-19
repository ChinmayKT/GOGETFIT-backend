/**
 * Adds `foodName` to food log entries saved before names were kept.
 *
 * Only entries without a name are touched, and only that one field, set by
 * its exact path (meals.<i>.foods.<j>.foodName, or .entries. on a log saved
 * before that was renamed) - nothing else in a log
 * changes, nothing is deleted. Safe to run again: named entries are skipped.
 *
 *   node scripts/backfill-food-log-names.js           # dry run: what would change
 *   node scripts/backfill-food-log-names.js --apply   # write it
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const apply = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const logs = db.collection('foodlogs');
const foods = db.collection('foods');

const unnamed = { $elemMatch: { $or: [{ foodName: { $exists: false } }, { foodName: null }] } };
const docs = await logs.find({ $or: [{ 'meals.foods': unnamed }, { 'meals.entries': unnamed }] }).toArray();
/** The array a meal keeps its foods in (see mealFoodsOf). */
const fieldOf = (m) => (Array.isArray(m.foods) && m.foods.length ? 'foods' : 'entries');
const ids = [...new Set(docs.flatMap((d) => d.meals.flatMap((m) => (m[fieldOf(m)] ?? []).map((e) => String(e.foodId)))))];
const names = new Map(
  (await foods.find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } }, { projection: { name: 1 } }).toArray()).map((f) => [String(f._id), f.name ?? null]),
);

let entries = 0;
let missingFood = 0;
for (const doc of docs) {
  const set = {};
  doc.meals.forEach((m, i) =>
    (m[fieldOf(m)] ?? []).forEach((e, j) => {
      if (e.foodName) return;
      const name = names.get(String(e.foodId));
      if (!name) {
        missingFood += 1;
        return;
      }
      set[`meals.${i}.${fieldOf(m)}.${j}.foodName`] = name;
      entries += 1;
    }),
  );
  if (!Object.keys(set).length) continue;
  console.log(`${doc.logDate}  client ${doc.clientId}  ->`, Object.values(set).join(', '));
  if (apply) {
    // Matched on the document as read, so a log changed meanwhile is skipped.
    const res = await logs.updateOne({ _id: doc._id, updatedAt: doc.updatedAt }, { $set: set });
    if (res.modifiedCount !== 1) console.log(`  skipped ${doc._id}: changed since it was read`);
  }
}
console.log(`${apply ? 'Updated' : 'Would update'} ${entries} entries in ${docs.length} logs; ${missingFood} entries whose food no longer exists left as they are.`);
await mongoose.disconnect();
