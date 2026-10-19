/**
 * Renames each food log meal's `entries` to `foods` (and gives it
 * `image: null`), the shape new submissions are saved in.
 *
 * Only `meals` changes, and only on logs that still have `entries`; every
 * food keeps its entryId and nutrition snapshot exactly, and consumed,
 * targets and dates are untouched. Nothing is deleted. Safe to run again:
 * a renamed log is skipped. A log changed after it was read is skipped too.
 *
 *   node scripts/rename-food-log-entries.js           # dry run: what would change
 *   node scripts/rename-food-log-entries.js --apply   # write it
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { renamedMeal } from '../src/utils/food-log-rename.js';

const apply = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const logs = db.collection('foodlogs');
console.log(`Database: ${db.databaseName}${apply ? '' : ' (dry run)'}`);

const docs = await logs.find({ 'meals.entries': { $exists: true } }).toArray();
let changed = 0;
let foods = 0;
for (const doc of docs) {
  const meals = doc.meals.map((m) => renamedMeal(m) ?? m);
  const before = doc.meals.reduce((n, m) => n + (m.foods?.length || m.entries?.length || 0), 0);
  const after = meals.reduce((n, m) => n + m.foods.length, 0);
  if (before !== after) throw new Error(`${doc._id}: ${before} foods would become ${after} - stopped, nothing written for it`);
  console.log(`${doc.logDate}  client ${doc.clientId}  ${meals.length} meals, ${after} foods`);
  foods += after;
  if (!apply) continue;
  // Matched on the document as read, so a log changed meanwhile is skipped.
  const res = await logs.updateOne({ _id: doc._id, updatedAt: doc.updatedAt }, { $set: { meals } });
  if (res.modifiedCount === 1) changed += 1;
  else console.log(`  skipped ${doc._id}: changed since it was read`);
}
console.log(`${apply ? 'Renamed' : 'Would rename'} ${apply ? changed : docs.length} of ${docs.length} logs (${foods} foods).`);
const left = await logs.countDocuments({ 'meals.entries': { $exists: true } });
console.log(`Logs still with entries: ${left}`);
await mongoose.disconnect();
