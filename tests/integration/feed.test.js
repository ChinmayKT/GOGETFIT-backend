import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import jwt from 'jsonwebtoken';

import env from '../../src/config/env.js';
import Coach from '../../src/models/coach.model.js';
import Post from '../../src/models/post.model.js';
import PostLike from '../../src/models/post-like.model.js';
import PostSave from '../../src/models/post-save.model.js';
import User from '../../src/models/user.model.js';
import { cleanupAbandonedDrafts, createDraft, publishPost, uploadPostMedia } from '../../src/services/feed.service.js';
import { resetStorage } from '../../src/services/storage/index.js';
import { resetRateLimits } from '../../src/middleware/rate-limit.middleware.js';
import { clearTestDb, connectTestDb, disconnectTestDb, startTestServer } from '../helpers/test-server.js';

let server;
let uploadRoot;
let seq = 0;

const tokenFor = (user) => jwt.sign({ sub: String(user._id), type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const seedUser = async (roles = ['user'], { status = 'active', name } = {}) => {
  seq += 1;
  const phone = `9177${String(seq).padStart(8, '0')}`;
  const user = await User.create({ phone: { raw: phone, normalized: phone }, profile: { name: name ?? `User ${seq}` }, roles, status });
  return { user, token: tokenFor(user) };
};

const seedCoach = async ({ status = 'active', name } = {}) => {
  const { user, token } = await seedUser(['user', 'coach'], { name: name ?? `Coach ${seq + 1}` });
  const coach = await Coach.create({
    userId: user._id,
    status,
    profile: { level: 'LEVEL 1', profilePicture: { url: `http://example.test/uploads/coaches/${user._id}/p.jpg`, storageKey: 'x' } },
  });
  return { user, coach, token };
};

// Real file signatures: the server checks bytes, not headers or names.
const jpeg = (fill = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 5)]);

const api = (method, url, token, body) => server.request(method, url, { token, body });

const raw = async (method, url, token, buffer, contentType = 'image/jpeg') => {
  const response = await fetch(`${server.baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: buffer,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const draftBody = (overrides = {}) => ({
  type: 'article',
  title: 'Protein basics',
  text: 'Eat enough protein every day.',
  mediaType: 'images',
  mediaCount: 1,
  ...overrides,
});

const createPostDraft = async (token, overrides) => {
  const res = await api('POST', '/api/coach/feed/posts', token, draftBody(overrides));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.post;
};

const uploadImage = (token, postId, index, bytes = jpeg(index + 1), qs = '?width=1080&height=1350') =>
  raw('PUT', `/api/coach/feed/posts/${postId}/media/${index}${qs}`, token, bytes);

/** Draft -> every image -> publish. Returns the published post. */
const publishImages = async (token, count = 1, overrides = {}) => {
  const draft = await createPostDraft(token, { mediaCount: count, ...overrides });
  for (let i = 0; i < count; i += 1) assert.equal((await uploadImage(token, draft.id, i)).status, 200);
  const res = await api('POST', `/api/coach/feed/posts/${draft.id}/publish`, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.post;
};

const publishVideo = async (token, overrides = {}) => {
  const draft = await createPostDraft(token, { mediaType: 'video', mediaCount: 1, type: 'transformation', ...overrides });
  assert.equal((await raw('PUT', `/api/coach/feed/posts/${draft.id}/media/0?width=720&height=1280&durationMs=28000`, token, mp4(), 'video/mp4')).status, 200);
  assert.equal((await raw('PUT', `/api/coach/feed/posts/${draft.id}/media/0/thumbnail`, token, jpeg(9))).status, 200);
  const res = await api('POST', `/api/coach/feed/posts/${draft.id}/publish`, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.post;
};

const feed = async (token, qs = '') => {
  const res = await api('GET', `/api/feed${qs}`, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

const feedIds = async (token, qs = '') => (await feed(token, qs)).posts.map((p) => p.id);

const fileExists = (storageKey) => fs.access(path.join(uploadRoot, storageKey)).then(() => true, () => false);

before(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ggf-feed-'));
  env.storage.localRoot = uploadRoot;
  resetStorage();
  await connectTestDb();
  server = await startTestServer();
});

after(async () => {
  await server.close();
  await clearTestDb();
  await disconnectTestDb();
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearTestDb();
  resetRateLimits();
  env.feed.memberPublishing = false;
});

// --- author identity and permissions -------------------------------------------

test('a coach creates, uploads and publishes an article; it is stored as a coach post', async () => {
  const coach = await seedCoach({ name: 'Asha Rao' });
  const post = await publishImages(coach.token, 2);

  assert.equal(post.authorType, 'coach');
  assert.equal(post.type, 'article');
  assert.equal(post.title, 'Protein basics');
  assert.equal(post.text, 'Eat enough protein every day.');
  assert.equal(post.mediaType, 'images');
  assert.deepEqual(post.media.map((m) => [m.kind, m.position, m.width, m.height]), [['image', 0, 1080, 1350], ['image', 1, 1080, 1350]]);
  assert.deepEqual(post.author, {
    userId: String(coach.user._id),
    coachId: String(coach.coach._id),
    name: 'Asha Rao',
    role: 'coach',
    verified: true,
    avatarUrl: `http://example.test/uploads/coaches/${coach.user._id}/p.jpg`,
  });
  assert.equal(post.canEdit, true);
  assert.ok(post.publishedAt);

  const stored = await Post.findById(post.id).lean();
  assert.equal(String(stored.authorUserId), String(coach.user._id));
  assert.equal(String(stored.authorCoachId), String(coach.coach._id));
  assert.equal(stored.status, 'published');
  // Storage keys are server-built under the post's own folder.
  assert.ok(stored.media.every((m) => m.storageKey.startsWith(`posts/${post.id}/media-`)));
});

test('a member cannot create a post: refused by role, and by the capability, which is off by default', async () => {
  assert.equal(env.feed.memberPublishing, false);
  const member = await seedUser();

  const direct = await api('POST', '/api/coach/feed/posts', member.token, draftBody());
  assert.equal(direct.status, 403);

  // Even past the route, the service refuses while the capability is off.
  await assert.rejects(createDraft(member.user, draftBody()), (error) => error.code === 'POST_PUBLISHING_DISABLED' && error.statusCode === 403);
  assert.equal(await Post.countDocuments(), 0);
});

test('identity comes from the token: author fields in the body are ignored', async () => {
  const a = await seedCoach();
  const b = await seedCoach();
  const draft = await createPostDraft(b.token, { authorUserId: String(a.user._id), authorCoachId: String(a.coach._id), authorType: 'member' });

  const stored = await Post.findById(draft.id).lean();
  assert.equal(String(stored.authorUserId), String(b.user._id));
  assert.equal(String(stored.authorCoachId), String(b.coach._id));
  assert.equal(stored.authorType, 'coach');
});

test('a coach can edit and delete only their own posts', async () => {
  const a = await seedCoach();
  const b = await seedCoach();
  const post = await publishImages(a.token);

  assert.equal((await api('PATCH', `/api/coach/feed/posts/${post.id}`, b.token, { title: 'Mine now' })).status, 404);
  assert.equal((await api('DELETE', `/api/coach/feed/posts/${post.id}`, b.token)).status, 404);
  assert.equal((await raw('PUT', `/api/coach/feed/posts/${post.id}/media/0`, b.token, jpeg())).status, 404);
  const stored = await Post.findById(post.id).lean();
  assert.equal(stored.title, 'Protein basics');
  assert.equal(stored.status, 'published');

  // Coach B sees A's post in the Feed but cannot edit it.
  const seenByB = (await feed(b.token)).posts.find((p) => p.id === post.id);
  assert.equal(seenByB.canEdit, false);

  const edited = await api('PATCH', `/api/coach/feed/posts/${post.id}`, a.token, { title: 'Protein, simply', text: 'Every meal.' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.post.title, 'Protein, simply');
  assert.equal(edited.body.data.post.text, 'Every meal.');
  assert.ok(edited.body.data.post.editedAt);
  assert.equal((await api('DELETE', `/api/coach/feed/posts/${post.id}`, a.token)).status, 200);
});

test('the schema holds both author types; a member post needs no coach profile', async () => {
  const member = await seedUser();
  const coach = await seedCoach();
  const base = { type: 'transformation', title: 't', text: 'x', mediaType: 'images', media: [], status: 'uploading' };

  await Post.create({ ...base, authorUserId: member.user._id, authorType: 'member' });
  await assert.rejects(Post.create({ ...base, authorUserId: coach.user._id, authorType: 'coach' }), /authorCoachId/);
  assert.equal(await Post.countDocuments({ authorType: 'member', authorCoachId: null }), 1);
});

test('with the capability switched on (tests only), a member post uses the same flow, collection and Feed', async () => {
  const member = await seedUser(['user', 'client'], { name: 'Ravi' });
  const viewer = await seedUser();
  env.feed.memberPublishing = true;

  const draft = await createDraft(member.user, draftBody({ type: 'transformation', mediaCount: 1 }));
  await uploadPostMedia(member.user, draft.id, 0, png(), { width: '800', height: '800' });
  const post = await publishPost(member.user, draft.id);

  assert.equal(post.authorType, 'member');
  assert.equal(post.author.coachId, null);
  assert.equal(post.author.role, 'member');
  assert.equal(post.author.verified, false);
  assert.equal(post.author.name, 'Ravi');
  const stored = await Post.findById(draft.id).lean();
  assert.equal(stored.authorCoachId, null);
  assert.deepEqual(await feedIds(viewer.token), [draft.id]);

  // Switched back off: member posts leave the Feed and new ones are refused.
  env.feed.memberPublishing = false;
  assert.deepEqual(await feedIds(viewer.token), []);
  await assert.rejects(createDraft(member.user, draftBody()), (error) => error.code === 'POST_PUBLISHING_DISABLED');
});

// --- content -------------------------------------------------------------------

test('article and transformation posts; title and caption limits are enforced, never truncated', async () => {
  const coach = await seedCoach();
  const article = await publishImages(coach.token, 1, { type: 'article', title: 'a'.repeat(150), text: 'b'.repeat(2000) });
  assert.equal(article.title.length, 150);
  assert.equal(article.text.length, 2000);
  assert.equal((await publishImages(coach.token, 1, { type: 'transformation' })).type, 'transformation');

  const refused = async (overrides, pattern) => {
    const res = await api('POST', '/api/coach/feed/posts', coach.token, draftBody(overrides));
    assert.equal(res.status, 400, JSON.stringify(overrides));
    assert.match(res.body.error.message, pattern);
  };
  await refused({ title: 'a'.repeat(151) }, /title must be at most 150/);
  await refused({ text: 'b'.repeat(2001) }, /text must be at most 2000/);
  await refused({ title: '   ' }, /title is required/);
  await refused({ text: '' }, /text is required/);
  await refused({ type: 'story' }, /type must be one of/);
  await refused({ mediaType: 'audio' }, /mediaType/);

  const tooLong = await api('PATCH', `/api/coach/feed/posts/${article.id}`, coach.token, { title: 'a'.repeat(151) });
  assert.equal(tooLong.status, 400);
  assert.equal((await Post.findById(article.id).lean()).title, 'a'.repeat(150));
});

// --- media -----------------------------------------------------------------------

test('images: 1 and 10 are accepted, 11 is refused; order is kept', async () => {
  const coach = await seedCoach();
  assert.equal((await publishImages(coach.token, 1)).media.length, 1);
  const ten = await publishImages(coach.token, 10);
  assert.deepEqual(ten.media.map((m) => m.position), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(ten.media.map((m) => m.id), Array.from({ length: 10 }, (_, i) => `media_${i + 1}`));
  // Each slot holds its own file, in the order uploaded.
  assert.equal(new Set(ten.media.map((m) => m.url)).size, 10);

  const eleven = await api('POST', '/api/coach/feed/posts', coach.token, draftBody({ mediaCount: 11 }));
  assert.equal(eleven.status, 400);
  assert.match(eleven.body.error.message, /1 to 10 images/);
});

test('video: one video with a thumbnail publishes; no thumbnail or two videos are refused', async () => {
  const coach = await seedCoach();
  const post = await publishVideo(coach.token);
  assert.equal(post.mediaType, 'video');
  assert.equal(post.media.length, 1);
  const [video] = post.media;
  assert.equal(video.kind, 'video');
  assert.ok(video.url.endsWith('.mp4'));
  assert.ok(video.thumbnailUrl.endsWith('.jpg'));
  assert.deepEqual([video.width, video.height, video.durationMs], [720, 1280, 28000]);

  const two = await api('POST', '/api/coach/feed/posts', coach.token, draftBody({ mediaType: 'video', mediaCount: 2 }));
  assert.equal(two.status, 400);

  const noThumb = await createPostDraft(coach.token, { mediaType: 'video', mediaCount: 1 });
  await raw('PUT', `/api/coach/feed/posts/${noThumb.id}/media/0`, coach.token, mp4(), 'video/mp4');
  const res = await api('POST', `/api/coach/feed/posts/${noThumb.id}/publish`, coach.token);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'POST_INCOMPLETE');
  assert.match(res.body.error.message, /thumbnail/);
});

test('mixed media and fake files are refused by their bytes', async () => {
  const coach = await seedCoach();
  const images = await createPostDraft(coach.token, { mediaCount: 2 });
  // A video into an image post, labelled as an image or as a video.
  assert.equal((await raw('PUT', `/api/coach/feed/posts/${images.id}/media/0`, coach.token, mp4(), 'image/jpeg')).status, 400);
  assert.equal((await raw('PUT', `/api/coach/feed/posts/${images.id}/media/0`, coach.token, mp4(), 'video/mp4')).status, 400);
  // A thumbnail only exists for a video.
  assert.equal((await raw('PUT', `/api/coach/feed/posts/${images.id}/media/0/thumbnail`, coach.token, jpeg())).status, 400);

  const video = await createPostDraft(coach.token, { mediaType: 'video', mediaCount: 1 });
  assert.equal((await raw('PUT', `/api/coach/feed/posts/${video.id}/media/0`, coach.token, jpeg())).status, 400);

  const fake = await raw('PUT', `/api/coach/feed/posts/${images.id}/media/1`, coach.token, Buffer.from('not really a jpeg'), 'image/jpeg');
  assert.equal(fake.status, 400);
  assert.equal(fake.body.error.code, 'UNSUPPORTED_IMAGE_TYPE');
  assert.equal((await raw('PUT', `/api/coach/feed/posts/${images.id}/media/5`, coach.token, jpeg())).status, 400);
  assert.equal((await uploadImage(coach.token, images.id, 0, jpeg(), '?width=0')).status, 400);

  const stored = await Post.findById(images.id).lean();
  assert.ok(stored.media.every((m) => m.url === null), 'nothing refused was attached');
});

test('an incomplete draft cannot publish, including when a stored file has gone missing', async () => {
  const coach = await seedCoach();
  const draft = await createPostDraft(coach.token, { mediaCount: 2 });
  await uploadImage(coach.token, draft.id, 0);

  const missingOne = await api('POST', `/api/coach/feed/posts/${draft.id}/publish`, coach.token);
  assert.equal(missingOne.status, 400);
  assert.equal(missingOne.body.error.code, 'POST_INCOMPLETE');

  await uploadImage(coach.token, draft.id, 1);
  const { media } = await Post.findById(draft.id).lean();
  await fs.rm(path.join(uploadRoot, media[1].storageKey));
  const missingFile = await api('POST', `/api/coach/feed/posts/${draft.id}/publish`, coach.token);
  assert.equal(missingFile.status, 400);
  assert.match(missingFile.body.error.message, /missing/);

  assert.equal((await Post.findById(draft.id).lean()).status, 'uploading');
  const viewer = await seedUser();
  assert.deepEqual(await feedIds(viewer.token), [], 'a draft is never in the Feed');
});

test('media cannot be changed after publishing; edits take title and text only', async () => {
  const coach = await seedCoach();
  const post = await publishImages(coach.token, 2);

  const replace = await uploadImage(coach.token, post.id, 0, jpeg(42));
  assert.equal(replace.status, 409);
  assert.equal(replace.body.error.code, 'POST_NOT_EDITABLE');

  const withMedia = await api('PATCH', `/api/coach/feed/posts/${post.id}`, coach.token, { title: 'x', media: [] });
  assert.equal(withMedia.status, 400);
  assert.match(withMedia.body.error.message, /Only title and text/);
  assert.equal((await api('PATCH', `/api/coach/feed/posts/${post.id}`, coach.token, { type: 'transformation' })).status, 400);

  const stored = await Post.findById(post.id).lean();
  assert.deepEqual(stored.media.map((m) => m.url), post.media.map((m) => m.url));
  assert.equal(stored.type, 'article');
});

test('abandoned drafts are cleaned up with their files; published posts and their files are never touched', async () => {
  const coach = await seedCoach();
  const published = await publishImages(coach.token);
  const draft = await createPostDraft(coach.token);
  await uploadImage(coach.token, draft.id, 0);
  const draftKey = (await Post.findById(draft.id).lean()).media[0].storageKey;
  const publishedKey = (await Post.findById(published.id).lean()).media[0].storageKey;

  // Two days old, published post included.
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await Post.collection.updateMany({}, { $set: { createdAt: old } });

  assert.equal(await cleanupAbandonedDrafts(), 1);
  assert.equal(await Post.exists({ _id: draft.id }), null);
  assert.equal(await fileExists(draftKey), false);
  assert.ok(await Post.exists({ _id: published.id }));
  assert.equal(await fileExists(publishedKey), true);

  // A fresh draft is not abandoned.
  const fresh = await createPostDraft(coach.token);
  assert.equal(await cleanupAbandonedDrafts(), 0);
  assert.ok(await Post.exists({ _id: fresh.id }));
});

// --- the Feed ----------------------------------------------------------------------

test('members see published posts from every active coach, not only their own coach', async () => {
  const a = await seedCoach();
  const b = await seedCoach();
  const member = await seedUser(['user', 'client']);
  const fromA = await publishImages(a.token);
  const fromB = await publishVideo(b.token);

  const { posts } = await feed(member.token);
  assert.deepEqual(posts.map((p) => p.id), [fromB.id, fromA.id]);
  assert.ok(posts.every((p) => p.canEdit === false && p.likedByMe === false && p.savedByMe === false));
  // Storage keys never leave the server.
  assert.ok(posts.every((p) => p.media.every((m) => !('storageKey' in m))));
});

test('inactive coaches, blocked coach accounts, removed and hidden posts are never shown', async () => {
  const active = await seedCoach();
  const inactive = await seedCoach();
  const blocked = await seedCoach();
  const member = await seedUser();
  const shown = await publishImages(active.token);
  const fromInactive = await publishImages(inactive.token);
  const fromBlocked = await publishImages(blocked.token);
  const removed = await publishImages(active.token);
  const hidden = await publishImages(active.token);

  await Coach.updateOne({ _id: inactive.coach._id }, { status: 'inactive' });
  await User.updateOne({ _id: blocked.user._id }, { status: 'blocked' });
  await api('DELETE', `/api/coach/feed/posts/${removed.id}`, active.token);
  await Post.updateOne({ _id: hidden.id }, { status: 'hidden' });

  assert.deepEqual(await feedIds(member.token), [shown.id]);
  for (const id of [fromInactive.id, fromBlocked.id, removed.id, hidden.id]) {
    assert.equal((await api('GET', `/api/feed/posts/${id}`, member.token)).status, 404, id);
    assert.equal((await api('PUT', `/api/feed/posts/${id}/like`, member.token)).status, 404, id);
    assert.equal((await api('PUT', `/api/feed/posts/${id}/save`, member.token)).status, 404, id);
  }
  // A deleted post keeps its audit trail.
  const audit = await Post.findById(removed.id).lean();
  assert.equal(audit.status, 'removed');
  assert.equal(String(audit.removedBy), String(active.user._id));
  assert.ok(audit.removedAt);
});

test('the type filter is applied by the server', async () => {
  const coach = await seedCoach();
  const member = await seedUser();
  const article = await publishImages(coach.token, 1, { type: 'article' });
  const transformation = await publishImages(coach.token, 1, { type: 'transformation' });

  assert.deepEqual(await feedIds(member.token, '?type=article'), [article.id]);
  assert.deepEqual(await feedIds(member.token, '?type=transformation'), [transformation.id]);
  assert.deepEqual(await feedIds(member.token, '?type=all'), [transformation.id, article.id]);
  assert.equal((await api('GET', '/api/feed?type=story', member.token)).status, 400);
});

test('cursor pagination walks every post once, newest first, across a larger set', async () => {
  const coach = await seedCoach();
  const member = await seedUser();
  // 45 posts, several sharing a publication time so the id breaks ties.
  const base = Date.now();
  const docs = Array.from({ length: 45 }, (_, i) => ({
    authorUserId: coach.user._id,
    authorType: 'coach',
    authorCoachId: coach.coach._id,
    type: i % 3 === 0 ? 'transformation' : 'article',
    title: `Post ${i}`,
    text: 'x',
    mediaType: 'images',
    media: [{ id: 'media_1', kind: 'image', position: 0, url: `http://example.test/uploads/posts/${i}.jpg`, storageKey: `posts/${i}.jpg` }],
    status: 'published',
    publishedAt: new Date(base - Math.floor(i / 3) * 1000),
  }));
  await Post.insertMany(docs);

  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const data = await feed(member.token, `?limit=10${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...data.posts);
    cursor = data.nextCursor;
    pages += 1;
    assert.ok(pages < 10);
  } while (cursor);

  assert.equal(pages, 5);
  assert.equal(seen.length, 45);
  assert.equal(new Set(seen.map((p) => p.id)).size, 45, 'no post appears twice');
  for (let i = 1; i < seen.length; i += 1) {
    const [prev, cur] = [seen[i - 1], seen[i]];
    assert.ok(prev.publishedAt > cur.publishedAt || (prev.publishedAt === cur.publishedAt && prev.id > cur.id));
  }

  // Filtered pages walk only that type.
  const transformations = (await feed(member.token, '?type=transformation&limit=50')).posts;
  assert.equal(transformations.length, 15);
  assert.equal((await feed(member.token, '?limit=500')).posts.length, 45, 'limit is capped at 50');
  assert.equal((await feed(member.token)).posts.length, 20, 'default page size');
  assert.equal((await api('GET', '/api/feed?cursor=nonsense', member.token)).status, 400);
});

test('post details: a visible post for anyone signed in; unknown ids and drafts are 404; no token is 401', async () => {
  const coach = await seedCoach();
  const member = await seedUser();
  const post = await publishImages(coach.token);
  const draft = await createPostDraft(coach.token);

  const res = await api('GET', `/api/feed/posts/${post.id}`, member.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.post.id, post.id);
  assert.equal((await api('GET', `/api/feed/posts/${draft.id}`, member.token)).status, 404);
  assert.equal((await api('GET', '/api/feed/posts/not-an-id', member.token)).status, 404);
  assert.equal((await api('GET', `/api/feed/posts/${post.id}`)).status, 401);
  assert.equal((await api('GET', '/api/feed')).status, 401);
});

test('the coach own-post list shows only that coach\'s published posts', async () => {
  const a = await seedCoach();
  const b = await seedCoach();
  const mine = await publishImages(a.token);
  await publishImages(b.token);
  await createPostDraft(a.token);

  const res = await api('GET', '/api/coach/feed/posts', a.token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.posts.map((p) => p.id), [mine.id]);
  assert.equal(res.body.data.posts[0].canEdit, true);
  const member = await seedUser();
  assert.equal((await api('GET', '/api/coach/feed/posts', member.token)).status, 403);
});

// --- likes --------------------------------------------------------------------------

test('like and unlike: once per account, never negative, and the state survives a reload', async () => {
  const coach = await seedCoach();
  const post = await publishImages(coach.token);
  const m1 = await seedUser();
  const m2 = await seedUser();

  const liked = await api('PUT', `/api/feed/posts/${post.id}/like`, m1.token);
  assert.equal(liked.status, 200);
  assert.deepEqual(liked.body.data.like, { postId: post.id, liked: true, likeCount: 1 });
  assert.equal((await api('PUT', `/api/feed/posts/${post.id}/like`, m1.token)).body.data.like.likeCount, 1, 'a duplicate like');
  assert.equal((await api('PUT', `/api/feed/posts/${post.id}/like`, m2.token)).body.data.like.likeCount, 2);

  // Reloaded: each account sees its own state and the shared count.
  const forM1 = (await feed(m1.token)).posts[0];
  const forCoach = (await feed(coach.token)).posts[0];
  assert.deepEqual([forM1.likedByMe, forM1.likeCount], [true, 2]);
  assert.deepEqual([forCoach.likedByMe, forCoach.likeCount], [false, 2]);

  assert.deepEqual((await api('DELETE', `/api/feed/posts/${post.id}/like`, m1.token)).body.data.like, { postId: post.id, liked: false, likeCount: 1 });
  assert.equal((await api('DELETE', `/api/feed/posts/${post.id}/like`, m1.token)).body.data.like.likeCount, 1, 'unlike without a like');
  await api('DELETE', `/api/feed/posts/${post.id}/like`, m2.token);
  assert.equal((await api('DELETE', `/api/feed/posts/${post.id}/like`, m2.token)).body.data.like.likeCount, 0);
  assert.equal((await Post.findById(post.id).lean()).likeCount, 0);
});

test('concurrent likes: one account counts once, many accounts each count once', async () => {
  const coach = await seedCoach();
  const post = await publishImages(coach.token);
  const member = await seedUser();
  const others = await Promise.all(Array.from({ length: 8 }, () => seedUser()));

  const same = await Promise.all(Array.from({ length: 10 }, () => api('PUT', `/api/feed/posts/${post.id}/like`, member.token)));
  assert.ok(same.every((r) => r.status === 200), JSON.stringify(same.map((r) => r.status)));
  assert.equal(await PostLike.countDocuments({ postId: post.id }), 1);
  assert.equal((await Post.findById(post.id).lean()).likeCount, 1);

  await Promise.all(others.map((o) => api('PUT', `/api/feed/posts/${post.id}/like`, o.token)));
  assert.equal((await Post.findById(post.id).lean()).likeCount, 9);

  // Likes and unlikes racing still end at the true count.
  await Promise.all(others.map((o, i) => api(i % 2 ? 'PUT' : 'DELETE', `/api/feed/posts/${post.id}/like`, o.token)));
  const count = await PostLike.countDocuments({ postId: post.id });
  assert.equal((await Post.findById(post.id).lean()).likeCount, count);
});

// --- saves ----------------------------------------------------------------------------

test('save and unsave: private, idempotent, and Saved Posts belongs to one account', async () => {
  const coach = await seedCoach();
  const first = await publishImages(coach.token);
  const second = await publishImages(coach.token);
  const m1 = await seedUser();
  const m2 = await seedUser();

  assert.deepEqual((await api('PUT', `/api/feed/posts/${first.id}/save`, m1.token)).body.data.save, { postId: first.id, saved: true });
  await api('PUT', `/api/feed/posts/${first.id}/save`, m1.token);
  await api('PUT', `/api/feed/posts/${second.id}/save`, m1.token);
  assert.equal(await PostSave.countDocuments({ userId: m1.user._id }), 2, 'a duplicate save');

  const saved = await api('GET', '/api/users/me/saved-posts', m1.token);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.posts.map((p) => p.id), [second.id, first.id], 'most recently saved first');
  assert.ok(saved.body.data.posts.every((p) => p.savedByMe));
  assert.deepEqual((await api('GET', '/api/users/me/saved-posts', m2.token)).body.data.posts, []);
  assert.equal((await feed(m1.token)).posts.find((p) => p.id === first.id).savedByMe, true);

  assert.deepEqual((await api('DELETE', `/api/feed/posts/${first.id}/save`, m1.token)).body.data.save, { postId: first.id, saved: false });
  assert.deepEqual((await api('GET', '/api/users/me/saved-posts', m1.token)).body.data.posts.map((p) => p.id), [second.id]);
});

test('Saved Posts pages with a cursor and leaves out posts that are no longer visible', async () => {
  const coach = await seedCoach();
  const member = await seedUser();
  const posts = [];
  for (let i = 0; i < 7; i += 1) posts.push(await publishImages(coach.token));
  for (const p of posts) await api('PUT', `/api/feed/posts/${p.id}/save`, member.token);

  const page1 = (await api('GET', '/api/users/me/saved-posts?limit=4', member.token)).body.data;
  const page2 = (await api('GET', `/api/users/me/saved-posts?limit=4&cursor=${page1.nextCursor}`, member.token)).body.data;
  assert.equal(page1.posts.length, 4);
  assert.equal(page2.posts.length, 3);
  assert.equal(page2.nextCursor, null);
  assert.equal(new Set([...page1.posts, ...page2.posts].map((p) => p.id)).size, 7);

  await api('DELETE', `/api/coach/feed/posts/${posts[0].id}`, coach.token);
  const after = (await api('GET', '/api/users/me/saved-posts?limit=50', member.token)).body.data.posts;
  assert.equal(after.length, 6);
  assert.ok(!after.some((p) => p.id === posts[0].id));
  // The deleted post can still be unsaved.
  assert.equal((await api('DELETE', `/api/feed/posts/${posts[0].id}/save`, member.token)).status, 200);
});

// --- uploads and publishing ---------------------------------------------------------------

test('retries: the same draft request, re-uploading a slot, and publishing twice all resolve to one post', async () => {
  const coach = await seedCoach();
  const first = await createPostDraft(coach.token, { clientRequestId: 'tap-1' });
  const again = await createPostDraft(coach.token, { clientRequestId: 'tap-1' });
  assert.equal(again.id, first.id);

  await uploadImage(coach.token, first.id, 0, jpeg(1));
  const firstKey = (await Post.findById(first.id).lean()).media[0].storageKey;
  await uploadImage(coach.token, first.id, 0, jpeg(2));
  const secondKey = (await Post.findById(first.id).lean()).media[0].storageKey;
  assert.notEqual(firstKey, secondKey);
  assert.equal(await fileExists(firstKey), false, 'the replaced file is removed');
  assert.equal(await fileExists(secondKey), true);

  const publishes = await Promise.all(Array.from({ length: 4 }, () => api('POST', `/api/coach/feed/posts/${first.id}/publish`, coach.token)));
  assert.ok(publishes.every((r) => r.status === 200 && r.body.data.post.id === first.id));
  assert.equal(await Post.countDocuments({ status: 'published' }), 1);
  const member = await seedUser();
  assert.deepEqual(await feedIds(member.token), [first.id]);
});

test('a failed upload leaves the slot empty and no stray file; a failed database write removes its file', async (t) => {
  const coach = await seedCoach();
  const draft = await createPostDraft(coach.token);

  const tooBig = Buffer.concat([jpeg(), Buffer.alloc(env.storage.maxUploadBytes + 1, 1)]);
  const res = await raw('PUT', `/api/coach/feed/posts/${draft.id}/media/0`, coach.token, tooBig);
  assert.ok([400, 413].includes(res.status), String(res.status));
  assert.equal((await Post.findById(draft.id).lean()).media[0].url, null);

  const filesBefore = await fs.readdir(uploadRoot, { recursive: true }).catch(() => []);
  t.mock.method(Post, 'findOneAndUpdate', () => ({ lean: () => Promise.reject(new Error('database unavailable')) }));
  await assert.rejects(uploadPostMedia(coach.user, draft.id, 0, jpeg(7), {}), /database unavailable/);
  t.mock.restoreAll();
  const filesAfter = await fs.readdir(uploadRoot, { recursive: true }).catch(() => []);
  assert.equal(filesAfter.filter((f) => f.endsWith('.jpg')).length, filesBefore.filter((f) => f.endsWith('.jpg')).length);
  assert.equal((await Post.findById(draft.id).lean()).media[0].url, null);
});

test('authorization failures: no token, a member on coach routes, another coach\'s draft', async () => {
  const a = await seedCoach();
  const b = await seedCoach();
  const member = await seedUser();
  const draft = await createPostDraft(a.token);

  assert.equal((await api('POST', '/api/coach/feed/posts', undefined, draftBody())).status, 401);
  assert.equal((await raw('PUT', `/api/coach/feed/posts/${draft.id}/media/0`, member.token, jpeg())).status, 403);
  assert.equal((await api('POST', `/api/coach/feed/posts/${draft.id}/publish`, member.token)).status, 403);
  assert.equal((await raw('PUT', `/api/coach/feed/posts/${draft.id}/media/0`, b.token, jpeg())).status, 404);
  assert.equal((await api('POST', `/api/coach/feed/posts/${draft.id}/publish`, b.token)).status, 404);
  assert.equal((await api('PUT', `/api/feed/posts/${draft.id}/like`, undefined)).status, 401);
});

test('deleting a post keeps its files; cleanup is a separate step that never touches published media', async () => {
  const coach = await seedCoach();
  const post = await publishVideo(coach.token);
  const stored = await Post.findById(post.id).lean();
  await api('DELETE', `/api/coach/feed/posts/${post.id}`, coach.token);
  assert.equal((await api('DELETE', `/api/coach/feed/posts/${post.id}`, coach.token)).status, 200, 'deleting again is quiet');

  assert.equal(await fileExists(stored.media[0].storageKey), true);
  assert.equal(await fileExists(stored.media[0].thumbnailStorageKey), true);
  assert.equal(await cleanupAbandonedDrafts({ now: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }), 0);
});

test('publishing and uploads are rate limited per account', async () => {
  const coach = await seedCoach();
  let last;
  for (let i = 0; i < 31; i += 1) last = await api('POST', '/api/coach/feed/posts', coach.token, draftBody());
  assert.equal(last.status, 429);
  const other = await seedCoach();
  assert.equal((await api('POST', '/api/coach/feed/posts', other.token, draftBody())).status, 201);
});

test('aspect ratio and crops: each photo keeps its own ratio and crop, shown to every viewer, files untouched', async () => {
  const coach = await seedCoach();
  const member = await seedUser();
  const crops = [
    { aspectRatio: '4:5', x: -0.5, y: 0.25, zoom: 1.6 },
    { aspectRatio: '1:1', x: 0, y: 0, zoom: 1 },
    { aspectRatio: '9:16', x: 1, y: -1, zoom: 2 },
    { aspectRatio: 'original', x: 0, y: 0, zoom: 1 },
  ];
  const post = await publishImages(coach.token, 4, { aspectRatio: '4:5', crops });
  assert.equal(post.aspectRatio, '4:5');
  const own = (p) => p.media.map((m) => ({ aspectRatio: m.aspectRatio, ...m.crop }));
  assert.deepEqual(own(post), crops);
  assert.deepEqual(post.media.map((m) => m.position), [0, 1, 2, 3]);
  // The original upload is what is served: nothing was re-encoded or copied.
  assert.deepEqual([post.media[0].width, post.media[0].height], [1080, 1350]);
  const stored = await Post.findById(post.id).lean();
  assert.equal(new Set(stored.media.map((m) => m.storageKey)).size, 4);

  const seen = (await feed(member.token)).posts.find((p) => p.id === post.id);
  assert.deepEqual(own(seen), crops);

  for (const ratio of ['original', '1:1', '1.91:1', '9:16']) {
    assert.equal((await publishImages(coach.token, 1, { aspectRatio: ratio })).aspectRatio, ratio);
  }
  const video = await publishVideo(coach.token, { aspectRatio: '1:1', crops: [{ aspectRatio: '1:1', x: 0, y: 0.4, zoom: 2 }] });
  assert.equal(video.media[0].aspectRatio, '1:1');
  assert.deepEqual(video.media[0].crop, { x: 0, y: 0.4, zoom: 2 });
});

test('aspect ratio and crops: a retried draft keeps the first crops', async () => {
  const coach = await seedCoach();
  const body = { mediaCount: 2, clientRequestId: 'retry-1', crops: [{ aspectRatio: '1:1', x: 0.5, y: 0, zoom: 1.2 }, null] };
  const first = await createPostDraft(coach.token, body);
  const again = await createPostDraft(coach.token, body);
  assert.equal(again.id, first.id);
  assert.equal(again.media[0].aspectRatio, '1:1');
  assert.deepEqual(again.media[0].crop, { x: 0.5, y: 0, zoom: 1.2 });
  assert.equal(again.media[1].crop, null);
});

test('aspect ratio and crops: old posts read as none; bad values are refused', async () => {
  const coach = await seedCoach();
  const legacy = await publishImages(coach.token, 2);
  assert.equal(legacy.aspectRatio, null);
  assert.deepEqual(legacy.media.map((m) => [m.aspectRatio, m.crop]), [[null, null], [null, null]]);

  const bad = [
    { aspectRatio: '16:9' },
    { crops: [{ aspectRatio: '3:2', x: 0, y: 0, zoom: 1 }] },
    { mediaCount: 2, crops: [{ x: 0, y: 0, zoom: 1 }] },
    { crops: [{ x: 2, y: 0, zoom: 1 }] },
    { crops: [{ x: 0, y: 0, zoom: 0.5 }] },
    { crops: [{ x: 0, y: 0, zoom: 6 }] },
    { crops: [{ x: '0', y: 0, zoom: 1 }] },
    { crops: ['centre'] },
    { crops: 'centre' },
  ];
  for (const overrides of bad) {
    const res = await api('POST', '/api/coach/feed/posts', coach.token, draftBody(overrides));
    assert.equal(res.status, 400, JSON.stringify(overrides));
  }
});
