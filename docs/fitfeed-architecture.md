# GOGETFEED (Feed) architecture

One Feed system for every author. Coaches publish in release one; members will publish through the same collection, endpoints, media pipeline and Flutter card once the capability is switched on.

Code: `src/models/post*.js`, `src/services/feed.service.js`, `src/services/feed-media-storage.service.js`, `src/controllers/feed.controller.js`, `src/routes/feed.routes.js` (+ coach routes in `coach-workspace.routes.js`, saved posts in `user.routes.js`). Flutter: `lib/features/fitfeed/` and the coach screens in `lib/features/coach_workspace/presentation/screens/coach_{feed,create_post}_screen/`.

## Author types

| Field | Coach post | Member post (future) |
|---|---|---|
| `authorUserId` | the coach's account | the member's account |
| `authorType` | `coach` | `member` |
| `authorCoachId` | the coach profile (required) | absent |

Ownership is always `authorUserId`, taken from the JWT, never from the request body. Names and pictures are not stored on posts: they are read from `users` / `coaches` when a page is shown (one batched read per page). A coach is shown with their own professional photo (`coaches.profile.profilePicture`) and a verified badge; a member would be shown with their name and avatar only, unbadged.

## Collections and indexes

`posts`: `authorUserId`, `authorType`, `authorCoachId`, `type` (`article` | `transformation`), `title` (max 150), `text` (max 2000), `mediaType` (`images` | `video`), `media[]`, `status`, `likeCount` (min 0), `publishedAt`, `editedAt`, `removedAt`, `removedBy`, `clientRequestId`, timestamps.

`media[]` slot: `id`, `kind`, `position`, `url`, `storageKey`, `width`, `height`; video also `thumbnailUrl`, `thumbnailStorageKey`, `durationMs`. Width, height and duration are what the app measured on the device; they only size the frame before the file loads.

| Index | Serves |
|---|---|
| `{status, publishedAt:-1, _id:-1}` | the Feed, all types |
| `{status, type, publishedAt:-1, _id:-1}` | the Feed, filtered |
| `{authorUserId, status, publishedAt:-1, _id:-1}` | a coach's own posts |
| `{authorUserId, clientRequestId}` unique, partial | retried draft creates |

No `authorCoachId` index: no query filters on it alone (the Feed filters by status first).

`postlikes`: `{postId, userId}` unique, `{userId, postId}`. `postsaves`: `{userId, postId}` unique, `{userId, createdAt:-1, _id:-1}`.

## Lifecycle

`uploading` (draft) -> `published` -> `removed` (author deleted it) or `hidden` (reserved for future moderation; nothing sets it yet). Only published posts by visible authors are ever returned. Deleting is a soft delete that records `removedAt` and `removedBy`; files are kept.

## Upload flow

1. `POST /api/coach/feed/posts` `{type, title, text, mediaType, mediaCount, clientRequestId}` creates a draft with one empty slot per file (1-10 images, or exactly one video). The same `clientRequestId` returns the same draft.
2. `PUT /api/coach/feed/posts/:id/media/:index?width=&height=&durationMs=` with the raw bytes; for a video also `PUT .../media/0/thumbnail`. The bytes decide the type (JPEG, PNG, WebP; MP4/ISO media), never the header or name. Limits: `MAX_UPLOAD_BYTES` (5 MB) for images, `MAX_VIDEO_UPLOAD_BYTES` (50 MB) for video. Uploading a slot again replaces it and removes the old file.
3. `POST /api/coach/feed/posts/:id/publish` checks every slot (and the video's thumbnail) is uploaded and the file still exists, then publishes. Publishing again returns the same post.

A published post's media is fixed: uploads return `409 POST_NOT_EDITABLE`, and `PATCH` accepts only `title` and `text`.

Drafts older than 24 hours are deleted with their files by `cleanupAbandonedDrafts()`. It runs for the author whenever they start a new draft; call it with no author (for example from a scheduled job) to sweep everyone. It deletes the draft document first, only while it is still a draft, and only then its files, so published media is never removed.

Storage goes through `feed-media-storage.service.js`, which only talks to the storage driver interface (`save`, `remove`, `exists`, `keyFor`, `urlFor`). Keys are built by the server: `posts/<postId>/media-<n>[-thumbnail]/<content-hash>.<ext>`.

## API

All endpoints require a signed-in account. Responses are `{ success, data }`.

| Method | Path | Who |
|---|---|---|
| GET | `/api/feed?type=all\|article\|transformation&limit=&cursor=` | any |
| GET | `/api/feed/posts/:id` | any |
| PUT / DELETE | `/api/feed/posts/:id/like` | any |
| PUT / DELETE | `/api/feed/posts/:id/save` | any |
| GET | `/api/users/me/saved-posts?limit=&cursor=` | any |
| GET | `/api/coach/feed/posts?type=&limit=&cursor=` | coach |
| POST | `/api/coach/feed/posts` | coach |
| PUT | `/api/coach/feed/posts/:id/media/:index` (`/thumbnail`) | coach, own draft |
| POST | `/api/coach/feed/posts/:id/publish` | coach, own draft |
| PATCH | `/api/coach/feed/posts/:id` | coach, own post |
| DELETE | `/api/coach/feed/posts/:id` | coach, own post |

Another author's post is always `404 POST_NOT_FOUND`, the same as a removed or unknown one. Draft creation, uploads and publishing are rate limited per account (30 drafts, 300 uploads, 60 publishes per hour).

A post as returned: `id, authorType, type, title, text, status, publishedAt, editedAt, author {userId, coachId, name, role, verified, avatarUrl}, mediaType, media[] {id, kind, url, width, height, position, thumbnailUrl?, durationMs?}, likeCount, likedByMe, savedByMe, canEdit`. Storage keys are never returned. `canEdit` is a hint for the menu; the server checks ownership on every write.

## Visibility

The Feed shows published posts whose coach profile is active and whose account is active. It is not limited to the member's own coach. Posts of a coach who becomes inactive, or whose account is blocked, disappear everywhere (Feed, details, likes, saves, Saved Posts) without being changed.

## Pagination

Cursor pagination on `(publishedAt desc, _id desc)` (Saved Posts: the save's `createdAt`). The cursor is an opaque base64url of the last item's time and id; the next page is strictly after it, so pages never overlap. Default 20, maximum 50. Saved Posts leaves out saves whose post is no longer visible, so a page can be shorter than `limit` while `nextCursor` continues.

## Likes and saves

A like is a `postlikes` row plus `likeCount`, changed together in one transaction: the row is upserted and the count incremented only when a row was actually inserted; an unlike decrements only when a row was deleted, and never below 0. The unique index means concurrent likes by one account count once. Saves are private rows; save and unsave are idempotent, and an unsave works even after the post was removed.

## Member publishing (future)

`env.feed.memberPublishing` (`FEED_MEMBER_PUBLISHING`, default `false`). While off, `publisherOf()` refuses non-coaches with `403 POST_PUBLISHING_DISABLED`, and member posts are excluded from every read. To enable member publishing:

1. Add member authoring routes that call the same service functions (`createDraft`, `uploadPostMedia`, `publishPost`, `editPost`, `deletePost`) under a member path; today those routes live only under `/coach`, behind the coach role.
2. Set `FEED_MEMBER_PUBLISHING=true`.
3. Ship the Flutter composer for members (the coach Create Post screen and `FeedRepository` already do the work; only routing and entry points differ).

No schema change, migration or second Feed is needed. Member posts are already covered by tests with the switch turned on.

## Flutter

- One model: `FeedPost` / `FeedAuthor` / `FeedMedia` in `fitfeed_entities.dart`, parsed from the API, for both author types.
- `FeedRepository` (`fitfeed/data/feed_repository.dart`): every Feed call, including raw-byte uploads with progress.
- `fitfeed_providers.dart`: one paging controller (`PagedPostsController`) behind the member Feed, the coach's own posts and Saved Posts; `FeedInteractions` applies likes, saves, edits and deletes to every list showing the post: optimistic, then the server's numbers, rolled back on failure, one request per post at a time. Double tap only likes.
- The existing screens and `FeedPostCard` are unchanged in design; they now read these providers. Published videos show their thumbnail and start a player only when tapped.

## Tests

- Backend: `tests/integration/feed.test.js` (identity and permissions, content limits, media, publishing, Feed visibility, filters, pagination, likes, saves, retries, failures, clean-up, rate limits). Run against a test database (`npm run test:integration`, which wipes `TEST_DB_NAME`).
- Flutter: `test/features/fitfeed/feed_api_test.dart` (model parsing, Feed, filters, paging, refresh, errors, likes, saves, Saved Posts, video, gallery, coach list, edit, delete, validation, upload), plus `feed_media_test.dart` and `feed_filter_test.dart`.

## Known limits

- No device verification yet; see the delivery report.
- Image and video sizes and duration come from the app; the server checks the file type and size only.
- The Feed reads every active coach id per request (fine for dozens of coaches; denormalise an author status onto posts if the roster grows large).
- `hidden` has no admin tooling yet. Physical deletion of a removed post's files is not implemented.
- Share sends the title, caption and the GOGETFIT website; posts have no deep link yet.
- Comments, follows, notifications and member posting UI are not implemented.
