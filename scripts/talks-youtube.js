/**
 * TALKS (YouTube) maintenance.
 *
 *   node scripts/talks-youtube.js seed      # add the initial GOGETFIT Talks (idempotent)
 *   node scripts/talks-youtube.js refresh   # re-fetch oEmbed metadata older than 30 days
 *   node scripts/talks-youtube.js list      # what is in talks_videos
 *
 * seed: each video is added once (keyed by its YouTube id). One already there
 * is left exactly as it is - admin edits are never overwritten - so running
 * it again changes nothing. Metadata comes from YouTube oEmbed; a video whose
 * metadata cannot be fetched is still added, as a draft marked `pending`
 * (it needs a title before it can be published).
 *
 * It also builds the Talks indexes and drops `talks_upload_jobs`, the old
 * upload-pipeline collection, only when it is empty.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { TalkVideo, ensureTalksIndexes } from '../src/models/talks.models.js';
import { createTalk, refreshStaleTalkMetadata } from '../src/services/talks.service.js';
import { parseYouTubeVideoId } from '../src/utils/youtube.js';

/** The initial talks, in display order (titles verified with oEmbed). */
const SEED = [
  // "Then 100 kg, now 65 kg - 35 kg weight loss journey" (Nandini, GOGETFIT Prajwal).
  { url: 'https://youtu.be/B6ecGgRE9D8?si=4rAMw8bOYnfY4EIl', displayOrder: 1, isFeatured: true },
  // "90 kg to 62 kg - 28 kg lost, a six pack on home food | Weight Loss Journey".
  { url: 'https://youtu.be/8VpKjJvjhX8?si=_0QjDo3PZC7ihIJj', displayOrder: 2 },
  // "Then 84 kg, now 65 kg - a village homemaker lost 16 kg at home" (GoGetFit App, Prajwal Davanagere).
  { url: 'https://youtu.be/qtp_kJSGhD4?si=Re0FEfZYT7VDX97t', displayOrder: 3 },
  // "You too can build a six pack at home" - Kalamadhyama's conversation with Prajwal Davanagere.
  { url: 'https://youtu.be/deRkelyrAuU?si=nSrCnGNH8n-Ba1Hz', displayOrder: 4 },
];

const command = process.argv[2] ?? 'list';
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
console.log(`Database: ${db.databaseName}`);

try {
  await ensureTalksIndexes();
  // Talks have no categories: clear the field from records made before that.
  const cleared = await TalkVideo.collection.updateMany({ category: { $exists: true } }, { $unset: { category: '' } });
  if (cleared.modifiedCount) console.log(`Removed the category field from ${cleared.modifiedCount} talk(s)`);
  const jobs = await db.listCollections({ name: 'talks_upload_jobs' }).toArray();
  if (jobs.length) {
    const n = await db.collection('talks_upload_jobs').countDocuments();
    if (n === 0) {
      await db.dropCollection('talks_upload_jobs');
      console.log('Dropped the empty obsolete collection talks_upload_jobs');
    } else {
      console.log(`Kept talks_upload_jobs: it has ${n} document(s) - review before removing`);
    }
  }

  if (command === 'seed') {
    for (const s of SEED) {
      const id = parseYouTubeVideoId(s.url);
      const existing = await TalkVideo.findOne({ youtubeVideoId: id }).lean();
      if (existing) {
        console.log(`exists   ${id}  ${existing.status}/${existing.metadataStatus}  ${existing.title}`);
        continue;
      }
      // Published when YouTube gave a title; otherwise a pending draft.
      let talk;
      try {
        talk = await createTalk({ youtubeUrl: s.url, displayOrder: s.displayOrder, isFeatured: s.isFeatured ?? false, status: 'published' }, null);
      } catch (error) {
        if (error?.code !== 'TALK_NOT_READY') throw error;
        talk = await createTalk({ youtubeUrl: s.url, displayOrder: s.displayOrder, isFeatured: s.isFeatured ?? false, status: 'draft' }, null);
      }
      console.log(`added    ${id}  ${talk.status}/${talk.metadataStatus}  ${talk.title || '(no title - metadata pending)'}`);
    }
  } else if (command === 'refresh') {
    const results = await refreshStaleTalkMetadata();
    for (const r of results) console.log(`refreshed ${r.youtubeVideoId}  ${r.metadataStatus}`);
    console.log(`${results.length} refreshed`);
  }

  const all = await TalkVideo.find({}).sort({ displayOrder: 1 }).lean();
  console.log(`talks_videos: ${all.length}`);
  for (const t of all) {
    console.log(`  ${t.displayOrder}. ${t.youtubeVideoId}  ${t.status}  ${t.metadataStatus}${t.isFeatured ? '  featured' : ''}  ${t.channelName ?? '-'}  ${t.title}`);
  }
} finally {
  await mongoose.disconnect();
}
