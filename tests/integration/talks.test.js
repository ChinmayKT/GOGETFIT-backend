import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import jwt from 'jsonwebtoken';

import env from '../../src/config/env.js';
import User from '../../src/models/user.model.js';
import Post from '../../src/models/post.model.js';
import PostSave from '../../src/models/post-save.model.js';
import { TALKS_MODELS, TalkAuditLog, TalkEngagement, TalkVideo, ensureTalksIndexes } from '../../src/models/talks.models.js';
import { createTalk as createTalkService } from '../../src/services/talks.service.js';
import { resetStorage } from '../../src/services/storage/index.js';
import { resetRateLimits } from '../../src/middleware/rate-limit.middleware.js';
import { canonicalYouTubeUrl, parseYouTubeVideoId, setOEmbedFetch } from '../../src/utils/youtube.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

/**
 * TALKS on the API: YouTube links only. Admin-only management (preview,
 * create with oEmbed metadata, edit, publish / unpublish, archive / restore,
 * refresh metadata, thumbnail, delete), members reading published talks only
 * (featured, pages, saved), Hi-Fi / Save that never count twice,
 * once-a-day open / share events, and the idempotent seed. YouTube's oEmbed
 * is stubbed: no test reaches the network.
 */

let server;
let uploadRoot;
let admin;
let adminToken;
let member;
let memberToken;
let otherToken;

/** The stubbed oEmbed: per video id, a body, an HTTP status, or a thrown error. */
let oembed;
let oembedCalls;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const seedUser = (phone, roles) =>
  User.create({ phone: { raw: phone, normalized: phone }, profile: { name: `User ${phone}` }, roles, status: 'active' });
const api = (method, url, body, token = adminToken) => server.request(method, url, { token, body });
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);

const ID = { a: 'B6ecGgRE9D8', b: '8VpKjJvjhX8', c: 'qtp_kJSGhD4', d: 'deRkelyrAuU' };
const meta = (id, title) => ({
  title,
  author_name: 'Digital Maadhyama',
  author_url: 'https://www.youtube.com/@DigitalMadhyama',
  thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  thumbnail_width: 480,
  thumbnail_height: 360,
});

const create = (overrides = {}) =>
  api('POST', '/api/admin/talks', { youtubeUrl: `https://youtu.be/${ID.a}?si=track`, ...overrides });
const published = async (id, overrides = {}) =>
  (await create({ youtubeUrl: `https://youtu.be/${id}`, status: 'published', ...overrides })).body.data.talk;

before(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ggf-talks-up-'));
  env.storage.localRoot = uploadRoot;
  resetStorage();
  setOEmbedFetch(async (url) => {
    const id = new URL(decodeURIComponent(new URL(url).searchParams.get('url'))).searchParams.get('v');
    oembedCalls.push(id);
    const answer = oembed[id];
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'number') return new Response('{}', { status: answer });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await connectTestDb();
  await ensureTalksIndexes();
  server = await startTestServer();
});

beforeEach(async () => {
  await clearTestDb();
  await Promise.all(TALKS_MODELS.map((m) => m.deleteMany({})));
  resetRateLimits();
  oembedCalls = [];
  oembed = {
    [ID.a]: meta(ID.a, 'Nandini: 100 kg to 65 kg'),
    [ID.b]: meta(ID.b, '90 kg to 62 kg'),
    [ID.c]: meta(ID.c, '84 kg to 65 kg'),
    [ID.d]: { ...meta(ID.d, 'Six pack at home'), author_name: 'Kalamadhyama' },
  };
  admin = await seedUser('919000000100', ['user', 'admin']);
  adminToken = tokenFor(admin);
  member = await seedUser('919000000101', ['user']);
  memberToken = tokenFor(member);
  otherToken = tokenFor(await seedUser('919000000102', ['user']));
});

after(async () => {
  setOEmbedFetch(null);
  await server.close();
  await disconnectTestDb();
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

// --- YouTube links ------------------------------------------------------------

test('every supported YouTube link form gives the video id; tracking parameters are ignored', () => {
  for (const url of [
    'https://youtu.be/B6ecGgRE9D8',
    'https://youtu.be/B6ecGgRE9D8?si=4rAMw8bOYnfY4EIl',
    'https://www.youtube.com/watch?v=B6ecGgRE9D8',
    'https://youtube.com/watch?v=B6ecGgRE9D8&si=x&t=42s',
    'https://m.youtube.com/watch?feature=share&v=B6ecGgRE9D8',
    'https://www.youtube.com/shorts/B6ecGgRE9D8?si=abc',
    'https://www.youtube.com/embed/B6ecGgRE9D8',
    'youtu.be/B6ecGgRE9D8',
    '  https://www.youtube.com/watch?v=B6ecGgRE9D8  ',
  ]) {
    assert.equal(parseYouTubeVideoId(url), 'B6ecGgRE9D8', url);
  }
  assert.equal(canonicalYouTubeUrl('B6ecGgRE9D8'), 'https://www.youtube.com/watch?v=B6ecGgRE9D8');
});

test('anything that is not a YouTube video link is refused', () => {
  for (const url of [
    'https://vimeo.com/123456',
    'https://youtube.com.evil.com/watch?v=B6ecGgRE9D8',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/@DigitalMadhyama',
    'https://www.youtube.com/playlist?list=PL123',
    'ftp://youtu.be/B6ecGgRE9D8',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
  ]) {
    assert.equal(parseYouTubeVideoId(url), null, String(url));
  }
});

// --- Admin ----------------------------------------------------------------------

test('admin routes are admin-only: members 403, no token 401', async () => {
  assert.equal((await api('GET', '/api/admin/talks', undefined, null)).status, 401);
  for (const [method, url] of [
    ['GET', '/api/admin/talks'],
    ['POST', '/api/admin/talks'],
    ['POST', '/api/admin/talks/preview'],
    ['GET', '/api/admin/talks/stats'],
  ]) {
    assert.equal((await api(method, url, method === 'GET' ? undefined : {}, memberToken)).status, 403, url);
  }
});

test('preview: the pasted link resolves to its id, canonical URL and oEmbed metadata; nothing is saved', async () => {
  const res = await api('POST', '/api/admin/talks/preview', { youtubeUrl: `https://youtu.be/${ID.a}?si=4rAMw8bOYnfY4EIl` });
  assert.equal(res.status, 200);
  const p = res.body.data.preview;
  assert.equal(p.youtubeVideoId, ID.a);
  assert.equal(p.youtubeUrl, `https://www.youtube.com/watch?v=${ID.a}`);
  assert.equal(p.metadataStatus, 'complete');
  assert.equal(p.metadata.title, 'Nandini: 100 kg to 65 kg');
  assert.equal(p.metadata.channelName, 'Digital Maadhyama');
  assert.equal(p.metadata.thumbnailUrl, `https://i.ytimg.com/vi/${ID.a}/hqdefault.jpg`);
  assert.equal(p.existing, null);
  assert.equal(await TalkVideo.countDocuments(), 0);

  const bad = await api('POST', '/api/admin/talks/preview', { youtubeUrl: 'https://vimeo.com/1' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'TALK_INVALID_YOUTUBE_URL');
});

test('create: oEmbed fills title, channel and thumbnail; the canonical URL is stored; nothing invented', async () => {
  const res = await create({ description: 'Typed by the admin.', displayOrder: 3, isFeatured: true });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const t = res.body.data.talk;
  assert.equal(t.youtubeVideoId, ID.a);
  assert.equal(t.youtubeUrl, `https://www.youtube.com/watch?v=${ID.a}`);
  assert.equal(t.title, 'Nandini: 100 kg to 65 kg');
  assert.equal(t.channelName, 'Digital Maadhyama');
  assert.equal(t.channelUrl, 'https://www.youtube.com/@DigitalMadhyama');
  assert.equal(t.thumbnailUrl, `https://i.ytimg.com/vi/${ID.a}/hqdefault.jpg`);
  assert.equal(t.description, 'Typed by the admin.');
  assert.equal(t.category, undefined, 'talks have no category');
  assert.equal(t.status, 'draft');
  assert.equal(t.metadataStatus, 'complete');
  assert.ok(t.metadataFetchedAt);
  // oEmbed has none of these: left empty, never guessed.
  assert.equal(t.durationSeconds, null);
  assert.equal(t.publishedAt, null);
  assert.equal(t.viewCount, null);
  // What the admin typed wins over oEmbed.
  const own = (await create({ youtubeUrl: `https://youtu.be/${ID.b}`, title: 'Our own title', channelName: 'GOGETFIT' })).body.data.talk;
  assert.equal(own.title, 'Our own title');
  assert.equal(own.titleEdited, true);
  assert.equal(own.channelName, 'GOGETFIT');
});

test('create validation: a missing or bad link, a bad status, a bad duration', async () => {
  for (const body of [
    { youtubeUrl: 'https://example.com/watch?v=B6ecGgRE9D8' },
    {},
    { youtubeUrl: `https://youtu.be/${ID.a}`, status: 'archived' },
    { youtubeUrl: `https://youtu.be/${ID.a}`, durationSeconds: -5 },
  ]) {
    assert.equal((await api('POST', '/api/admin/talks', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await TalkVideo.countDocuments(), 0);
});

test('one talk per YouTube video: any link form of it is a 409 naming the existing talk', async () => {
  const first = (await create()).body.data.talk;
  for (const url of [`https://www.youtube.com/watch?v=${ID.a}`, `https://www.youtube.com/shorts/${ID.a}?si=zz`]) {
    const res = await create({ youtubeUrl: url });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TALK_DUPLICATE');
    assert.equal(res.body.error.details.existingId, first.id);
  }
  const preview = (await api('POST', '/api/admin/talks/preview', { youtubeUrl: `https://youtu.be/${ID.a}` })).body.data.preview;
  assert.equal(preview.existing.id, first.id);
  // Even two at once make one.
  const results = await Promise.all([create({ youtubeUrl: `https://youtu.be/${ID.b}` }), create({ youtubeUrl: `https://youtu.be/${ID.b}` })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await TalkVideo.countDocuments({ youtubeVideoId: ID.b }), 1);
});

test('oEmbed failure: the talk is still saved, marked pending, and cannot go live until a title is added', async () => {
  oembed[ID.a] = new Error('getaddrinfo ENOTFOUND www.youtube.com');
  const t = (await create()).body.data.talk;
  assert.equal(t.metadataStatus, 'pending');
  assert.match(t.metadataError, /Could not reach YouTube/);
  assert.equal(t.title, '');
  assert.equal(t.thumbnailUrl, null);

  const refused = await api('PATCH', `/api/admin/talks/${t.id}/publish`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'TALK_NOT_READY');
  // Published straight from create is refused the same way, and nothing is saved.
  assert.equal((await create({ youtubeUrl: `https://youtu.be/${ID.c}`, status: 'published' })).status, 201);
  oembed[ID.d] = 500;
  assert.equal((await create({ youtubeUrl: `https://youtu.be/${ID.d}`, status: 'published' })).status, 409);
  assert.equal(await TalkVideo.countDocuments({ youtubeVideoId: ID.d }), 0);

  // The admin completes it by hand: title + own thumbnail, then publishes.
  await api('PUT', `/api/admin/talks/${t.id}`, { title: 'Typed title', channelName: 'GOGETFIT', description: 'Typed.' });
  const thumb = await fetch(`${server.baseUrl}/api/admin/talks/${t.id}/thumbnail`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${adminToken}` },
    body: jpeg,
  }).then((r) => r.json());
  assert.match(thumb.data.talk.thumbnailUrl, /\/talks\/.+\/thumbnail\/[0-9a-f]{32}\.jpg$/);
  const live = (await api('PATCH', `/api/admin/talks/${t.id}/publish`)).body.data.talk;
  assert.equal(live.status, 'published');
  assert.equal(live.metadataStatus, 'pending', 'still marked: it was never fetched');
});

test('a private / removed video is marked unavailable for admin review, never deleted', async () => {
  const t = await published(ID.a);
  oembed[ID.a] = 404;
  const refreshed = (await api('POST', `/api/admin/talks/${t.id}/refresh-metadata`)).body.data.talk;
  assert.equal(refreshed.metadataStatus, 'unavailable');
  assert.match(refreshed.metadataError, /unavailable/);
  assert.equal(refreshed.title, t.title, 'what was there is kept');
  assert.equal(refreshed.status, 'published');
  const attention = (await api('GET', '/api/admin/talks?status=attention')).body.data;
  assert.deepEqual(attention.talks.map((x) => x.id), [t.id]);
  assert.equal((await api('GET', '/api/admin/talks/stats')).body.data.stats.attention, 1);
});

test('refresh metadata: picks up YouTube changes but keeps a title the admin edited', async () => {
  const t = await published(ID.a);
  oembed[ID.a] = { ...meta(ID.a, 'New YouTube title'), author_name: 'Renamed channel' };
  let r = (await api('POST', `/api/admin/talks/${t.id}/refresh-metadata`)).body.data.talk;
  assert.equal(r.title, 'New YouTube title');
  assert.equal(r.channelName, 'Renamed channel');
  await api('PUT', `/api/admin/talks/${t.id}`, { title: 'Admin title' });
  oembed[ID.a] = meta(ID.a, 'Yet another');
  r = (await api('POST', `/api/admin/talks/${t.id}/refresh-metadata`)).body.data.talk;
  assert.equal(r.title, 'Admin title');
  assert.equal(r.metadataStatus, 'complete');
});

test('edit changes only what is sent; the video link itself cannot be changed', async () => {
  const t = (await create()).body.data.talk;
  const res = await api('PUT', `/api/admin/talks/${t.id}`, {
    description: 'New words',
    isFeatured: true,
    displayOrder: 7,
    durationSeconds: 754,
    publishedAt: '2026-01-15',
  });
  assert.equal(res.status, 200);
  const e = res.body.data.talk;
  assert.equal(e.description, 'New words');
  assert.equal(e.isFeatured, true);
  assert.equal(e.displayOrder, 7);
  assert.equal(e.durationSeconds, 754);
  assert.equal(e.publishedAt, '2026-01-15T00:00:00.000Z');
  assert.equal(e.title, t.title);
  for (const body of [{ youtubeUrl: 'https://youtu.be/8VpKjJvjhX8' }, { status: 'published' }, {}]) {
    assert.equal((await api('PUT', `/api/admin/talks/${t.id}`, body)).status, 400, JSON.stringify(body));
  }
});

test('lifecycle: publish, unpublish, archive, restore (never straight back live), delete', async () => {
  const t = (await create()).body.data.talk;
  let r = (await api('PATCH', `/api/admin/talks/${t.id}/publish`)).body.data.talk;
  assert.equal(r.status, 'published');
  assert.ok(r.listedAt);
  assert.equal((await api('DELETE', `/api/admin/talks/${t.id}`)).body.error.code, 'TALK_PUBLISHED');
  r = (await api('PATCH', `/api/admin/talks/${t.id}/unpublish`)).body.data.talk;
  assert.equal(r.status, 'unpublished');
  await api('PATCH', `/api/admin/talks/${t.id}/publish`);
  r = (await api('PATCH', `/api/admin/talks/${t.id}/archive`)).body.data.talk;
  assert.equal(r.status, 'archived');
  assert.ok(r.archivedAt);
  assert.equal((await api('PATCH', `/api/admin/talks/${t.id}/publish`)).status, 409, 'restore first');
  r = (await api('PATCH', `/api/admin/talks/${t.id}/restore`)).body.data.talk;
  assert.equal(r.status, 'unpublished');
  assert.equal(r.archivedAt, null);
  const del = await api('DELETE', `/api/admin/talks/${t.id}`);
  assert.equal(del.status, 200);
  assert.equal(await TalkVideo.countDocuments(), 0);
  assert.ok((await TalkAuditLog.countDocuments({ talksVideoId: t.id })) >= 6, 'the audit trail is kept');
});

test('admin list: status filter, search, sorting, pages', async () => {
  await published(ID.a, { displayOrder: 2 });
  await published(ID.b, { displayOrder: 1 });
  await create({ youtubeUrl: `https://youtu.be/${ID.c}`, displayOrder: 3 });
  const all = (await api('GET', '/api/admin/talks?sortKey=displayOrder&sortDir=asc')).body.data;
  assert.deepEqual(all.talks.map((t) => t.youtubeVideoId), [ID.b, ID.a, ID.c]);
  assert.equal(all.categories, undefined);
  assert.equal((await api('GET', '/api/admin/talks?status=draft')).body.data.talks.length, 1);
  assert.equal((await api('GET', '/api/admin/talks?search=nandini')).body.data.talks[0].youtubeVideoId, ID.a);
  assert.equal((await api('GET', `/api/admin/talks?search=${ID.c}`)).body.data.talks[0].youtubeVideoId, ID.c);
  const paged = (await api('GET', '/api/admin/talks?pageSize=2&page=2&sortKey=displayOrder&sortDir=asc')).body.data;
  assert.deepEqual(paged.talks.map((t) => t.youtubeVideoId), [ID.c]);
  assert.equal(paged.pagination.total, 3);
  assert.equal((await api('GET', '/api/admin/talks?status=processing')).status, 400);
});

// --- Members --------------------------------------------------------------------

test('members see published talks only, in display order, with no admin data, no category; pages', async () => {
  const a = await published(ID.a, { displayOrder: 2, isFeatured: true });
  await published(ID.b, { displayOrder: 1 });
  await create({ youtubeUrl: `https://youtu.be/${ID.c}` }); // draft
  const d = await published(ID.d, { displayOrder: 3 });
  await api('PATCH', `/api/admin/talks/${d.id}/archive`);

  const res = await api('GET', '/api/talks', undefined, memberToken);
  assert.equal(res.status, 200);
  const { talks, categories, pagination } = res.body.data;
  assert.equal(categories, undefined);
  assert.deepEqual(talks.map((t) => t.youtubeVideoId), [ID.b, ID.a]);
  assert.equal(pagination.total, 2);
  const t = talks.find((x) => x.id === a.id);
  assert.deepEqual(Object.keys(t).sort(), [
    'channelName', 'description', 'durationSeconds', 'hifi', 'hifiCount', 'id', 'isFeatured',
    'publishedAt', 'saved', 'thumbnailUrl', 'title', 'viewCount', 'youtubeUrl', 'youtubeVideoId',
  ]);
  assert.equal(t.youtubeUrl, `https://www.youtube.com/watch?v=${ID.a}`);

  const p2 = (await api('GET', '/api/talks?pageSize=1&page=2', undefined, memberToken)).body.data;
  assert.deepEqual(p2.talks.map((x) => x.youtubeVideoId), [ID.a]);

  const featured = (await api('GET', '/api/talks/featured', undefined, memberToken)).body.data.talks;
  assert.deepEqual(featured.map((x) => x.id), [a.id]);
  assert.equal((await api('GET', '/api/talks/categories', undefined, memberToken)).status, 404, 'no category endpoint');
  // A draft, archived or unknown talk is not found for members.
  assert.equal((await api('GET', `/api/talks/${d.id}`, undefined, memberToken)).status, 404);
  assert.equal((await api('GET', '/api/talks', undefined, null)).status, 401);
  // Reading never calls YouTube.
  oembedCalls = [];
  await api('GET', '/api/talks', undefined, memberToken);
  assert.deepEqual(oembedCalls, []);
});

test('no featured talk: the featured list is empty', async () => {
  await published(ID.a);
  assert.deepEqual((await api('GET', '/api/talks/featured', undefined, memberToken)).body.data.talks, []);
});

test('featured: at most three, in the admin\'s display order; a fourth is refused until one is unfeatured', async () => {
  const c = await published(ID.c, { isFeatured: true, displayOrder: 3 });
  const a = await published(ID.a, { isFeatured: true, displayOrder: 1 });
  const b = await published(ID.b, { isFeatured: true, displayOrder: 2 });
  let featured = (await api('GET', '/api/talks/featured', undefined, memberToken)).body.data.talks;
  assert.deepEqual(featured.map((t) => t.id), [a.id, b.id, c.id]);

  // A fourth - on create or by editing - is refused with a clear message.
  const refused = await create({ youtubeUrl: `https://youtu.be/${ID.d}`, isFeatured: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'TALK_FEATURED_LIMIT');
  assert.match(refused.body.error.message, /Up to 3 talks can be featured/);
  assert.equal(await TalkVideo.countDocuments({ youtubeVideoId: ID.d }), 0);
  const d = (await create({ youtubeUrl: `https://youtu.be/${ID.d}`, status: 'published', displayOrder: 4 })).body.data.talk;
  assert.equal((await api('PUT', `/api/admin/talks/${d.id}`, { isFeatured: true })).body.error.code, 'TALK_FEATURED_LIMIT');
  // Editing one already featured is fine.
  assert.equal((await api('PUT', `/api/admin/talks/${a.id}`, { isFeatured: true, displayOrder: 5 })).status, 200);

  // Unfeature one, then the fourth can be featured; the order follows display order.
  await api('PUT', `/api/admin/talks/${b.id}`, { isFeatured: false });
  assert.equal((await api('PUT', `/api/admin/talks/${d.id}`, { isFeatured: true })).status, 200);
  featured = (await api('GET', '/api/talks/featured', undefined, memberToken)).body.data.talks;
  assert.deepEqual(featured.map((t) => t.id), [c.id, d.id, a.id]);

  // Archiving a featured talk frees its place.
  await api('PATCH', `/api/admin/talks/${c.id}/archive`);
  assert.equal((await TalkVideo.findById(c.id).lean()).isFeatured, false);
  assert.equal((await api('PUT', `/api/admin/talks/${b.id}`, { isFeatured: true })).status, 200);
  assert.equal(await TalkVideo.countDocuments({ isFeatured: true }), 3);
});

test('Hi-Fi and Save: one per account, counts move only on a real change; saved list; unpublish hides, keeps counts', async () => {
  const t = await published(ID.a);
  const results = await Promise.all([1, 2, 3].map(() => api('POST', `/api/talks/${t.id}/hifi`, undefined, memberToken)));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal((await TalkVideo.findById(t.id).lean()).hifiCount, 1);
  await api('POST', `/api/talks/${t.id}/hifi`, undefined, otherToken);
  let mine = (await api('POST', `/api/talks/${t.id}/save`, undefined, memberToken)).body.data.talk;
  assert.equal(mine.hifi, true);
  assert.equal(mine.saved, true);
  assert.equal(mine.hifiCount, 2);
  assert.equal((await api('DELETE', `/api/talks/${t.id}/hifi`, undefined, memberToken)).body.data.talk.hifiCount, 1);
  await api('DELETE', `/api/talks/${t.id}/hifi`, undefined, memberToken);
  assert.equal((await TalkVideo.findById(t.id).lean()).hifiCount, 1, 'never below what it should be');

  const saved = (await api('GET', '/api/talks/saved', undefined, memberToken)).body.data;
  assert.deepEqual(saved.talks.map((x) => x.id), [t.id]);
  assert.equal((await api('GET', '/api/talks/saved', undefined, otherToken)).body.data.talks.length, 0);

  await api('PATCH', `/api/admin/talks/${t.id}/unpublish`);
  assert.equal((await api('GET', '/api/talks/saved', undefined, memberToken)).body.data.talks.length, 0);
  assert.equal((await api('POST', `/api/talks/${t.id}/save`, undefined, memberToken)).status, 404);
  assert.equal(await TalkEngagement.countDocuments({ talksVideoId: t.id, saved: true }), 1, 'kept for when it returns');
  await api('PATCH', `/api/admin/talks/${t.id}/publish`);
  mine = (await api('GET', `/api/talks/${t.id}`, undefined, memberToken)).body.data.talk;
  assert.equal(mine.saved, true);
});

test('open and share events count once per account, talk and day; unknown kinds refused', async () => {
  const t = await published(ID.a);
  const first = await api('POST', `/api/talks/${t.id}/events`, { kind: 'open' }, memberToken);
  assert.equal(first.body.data.counted, true);
  assert.equal((await api('POST', `/api/talks/${t.id}/events`, { kind: 'open' }, memberToken)).body.data.counted, false);
  await api('POST', `/api/talks/${t.id}/events`, { kind: 'share' }, memberToken);
  await api('POST', `/api/talks/${t.id}/events`, { kind: 'share' }, otherToken);
  const doc = await TalkVideo.findById(t.id).lean();
  assert.equal(doc.openCount, 1);
  assert.equal(doc.shareCount, 2);
  for (const kind of ['view', 'start', 'complete', 'nope']) {
    assert.equal((await api('POST', `/api/talks/${t.id}/events`, { kind }, memberToken)).status, 400, kind);
  }
  const stats = (await api('GET', '/api/admin/talks/stats')).body.data.stats;
  assert.equal(stats.opens, 1);
  assert.equal(stats.shares, 2);
});

test('Talks never touch the Feed', async () => {
  const t = await published(ID.a);
  await api('POST', `/api/talks/${t.id}/save`, undefined, memberToken);
  await api('POST', `/api/talks/${t.id}/hifi`, undefined, memberToken);
  assert.equal(await Post.countDocuments(), 0);
  assert.equal(await PostSave.countDocuments(), 0);
});

test('seeding is idempotent: the same four videos twice make four talks, edits untouched', async () => {
  const seed = [
    { url: 'https://youtu.be/B6ecGgRE9D8?si=4rAMw8bOYnfY4EIl' },
    { url: 'https://youtu.be/8VpKjJvjhX8?si=_0QjDo3PZC7ihIJj' },
    { url: 'https://youtu.be/qtp_kJSGhD4?si=Re0FEfZYT7VDX97t' },
    { url: 'https://youtu.be/deRkelyrAuU?si=nSrCnGNH8n-Ba1Hz' },
  ];
  const run = async () => {
    for (const [i, s] of seed.entries()) {
      if (await TalkVideo.exists({ youtubeVideoId: parseYouTubeVideoId(s.url) })) continue;
      await createTalkService({ youtubeUrl: s.url, displayOrder: i + 1, status: 'published' }, null);
    }
  };
  await run();
  const first = await TalkVideo.find({}).sort({ displayOrder: 1 }).lean();
  assert.equal(first.length, 4);
  await TalkVideo.updateOne({ _id: first[0]._id }, { $set: { description: 'Edited' } });
  await run();
  const again = await TalkVideo.find({}).sort({ displayOrder: 1 }).lean();
  assert.equal(again.length, 4);
  assert.equal(again[0].description, 'Edited');
  assert.ok(again.every((t) => t.status === 'published' && t.metadataStatus === 'complete'));
  const listed = (await api('GET', '/api/talks', undefined, memberToken)).body.data.talks;
  assert.deepEqual(listed.map((t) => t.youtubeVideoId), [ID.a, ID.b, ID.c, ID.d]);
});
