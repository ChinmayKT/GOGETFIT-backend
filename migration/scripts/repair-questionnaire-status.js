/**
 * Repairs questionnaires that were submitted but left reading `draft`.
 *
 * WHY THIS EXISTS. Until the fix in `saveMemberQuestionnaire`, the status could
 * move backwards: the app autosaves a draft whenever a step is finished or the
 * form is left, and any such save landing after the submission flipped a
 * finished questionnaire back to `draft`. The answers were never lost and
 * `submittedAt` was kept, so the damage is exactly one field.
 *
 * WHAT IT TOUCHES. Only documents carrying the fingerprint of that bug:
 *
 *     status === 'draft'  AND  submittedAt is a real date
 *
 * A genuine draft has `submittedAt: null`, so it can never match. No answer is
 * read, written, or deleted - the update sets `status` and nothing else.
 *
 * Idempotent: a second run matches nothing, because the first run left no
 * document in that state.
 *
 * Dry run by default. Pass --apply to write.
 *
 *     node migration/scripts/repair-questionnaire-status.js
 *     node migration/scripts/repair-questionnaire-status.js --apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import Questionnaire from '../../src/models/questionnaire.model.js';

const apply = process.argv.includes('--apply');

const BROKEN = {
  status: 'draft',
  submittedAt: { $ne: null, $exists: true },
};

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`database: ${mongoose.connection.name}`);
  console.log(apply ? 'mode: APPLY' : 'mode: dry run (pass --apply to write)');

  const affected = await Questionnaire.find(BROKEN)
    .select('userId enrollmentId status submittedAt updatedAt answers')
    .lean();

  console.log(`questionnaires submitted but stored as draft: ${affected.length}`);
  for (const doc of affected) {
    console.log(
      `  ${doc._id}  user=${doc.userId}  enrollment=${doc.enrollmentId}  ` +
        `submittedAt=${doc.submittedAt?.toISOString()}  answers=${Object.keys(doc.answers ?? {}).length}`,
    );
  }

  if (!apply) {
    console.log('nothing written');
  } else if (affected.length === 0) {
    console.log('nothing to repair');
  } else {
    // Only the status. The filter is repeated so a concurrent write cannot be
    // overwritten by this one.
    const result = await Questionnaire.updateMany(BROKEN, { $set: { status: 'submitted' } });
    console.log(`repaired: ${result.modifiedCount}`);
    const left = await Questionnaire.countDocuments(BROKEN);
    console.log(`still in that state: ${left}`);
  }

  await mongoose.connection.close();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.connection.close().catch(() => {});
  process.exitCode = 1;
});
