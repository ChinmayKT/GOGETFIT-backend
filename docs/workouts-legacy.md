# Legacy Workout — discovery report

Read-only reverse engineering of the legacy Workout feature, before any new code.
Every statement cites legacy source or a read-only query against `staging-ggf`.

## 1. Tables

| Table | Rows | Role |
| --- | --- | --- |
| **`m_workout`** | **188** | the Workout master — the only table the Add/Edit form writes |
| `m_workout_type` | **0** | exists but is **never read or written by any code**; dead |
| `m_workout_category` | 1259 | plan *sections* ("Warm Up", "Chest Day"), not workout classification |
| `m_workout_plan` | 372 | a member's plan header (`user_id`, plan name) |
| `r_workout_plan` | 3977 | **plan → workout link**: `(workout_plan_id, workout_category_id, workout_id)` + `sets_count`, `reps_count` |
| `r_workout_plan_category` | 1257 | plan → category link |
| `r_workout_plan_dates` | 6283 | the dates a plan is scheduled for |
| `r_plan_workout` | 0 | dead table, never read |

### `m_workout` columns, verbatim

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `workout_id` | int(11) | NOT NULL | PK, auto_increment. **The only index on the table.** |
| `workout_name` | varchar(45) | NULL | longest actual value: 45 (at the ceiling) |
| `workout_type` | varchar(10) | NULL | Gym / Home / General |
| `equipment` | varchar(45) | NULL | 4 values |
| `primary_muscle` | varchar(50) | NULL | **free text** |
| `secondary_muscle` | varchar(50) | NULL | **free text**, 117 distinct values |
| `workout_level` | varchar(45) | NULL | "LEVEL 1".."LEVEL 5" |
| `youtube_link` | varchar(100) | NULL | |
| `description` | text | NULL | longest actual value 2679 chars |
| `video_file_name` | varchar(100) | NULL | GUID + `.mp4` |
| `thumbnail_file_name` | varchar(100) | NULL | GUID + `.jpg/.jpeg/.png` |
| `created_by` | varchar(45) | NULL | literally `"123"` on all 188 rows |
| `last_update_date` | datetime | NULL | |
| `last_update_by` | varchar(45) | NULL | literally `"123"` on all 188 rows |
| `delete_flg` | tinyint(1) | NOT NULL def 0 | 182 live / **6 deleted** |

**There is no `create_date` column.** `m_workout` is the only workout table without one, and
the insert never writes a creation timestamp. A migrated workout therefore has no legacy
creation date to carry — only `last_update_date`.

## 2. Where the dropdown values come from

All hardcoded in the **view**, not in any table (`Views/WorkOut/AddWorkOut.cshtml`).
`m_workout_type` is empty and unreferenced.

| Field | Source | Values (exact casing) | Actual data |
| --- | --- | --- | --- |
| Workout Type | view `:143-148` | `Gym`, `Home`, `General` | General 110 · Home 49 · Gym 29 |
| Equipment | view `:155-161` | `Gym Equipment`, **`Pair of Dumbells`** (one "b"), `Resistance Band`, `Body Weight` | Body Weight 102 · Pair of Dumbells 35 · Gym Equipment 29 · Resistance Band 22 |
| Level | view `:180-187` | `LEVEL 1` … `LEVEL 5` | L2 90 · L3 67 · L1 26 · L4 5 · **L5 never used** |
| Primary Muscle | `@Html.TextBoxFor` `:168` | **free text** | "Legs", "Back (Cool Down)", "Legs (Warm Up)", "Abdominal (Core)"… |
| Secondary Muscle | `@Html.TextBoxFor` `:174` | **free text** | 117 distinct, 0 empty |

The muscle fields are **not** dropdowns in legacy, and the values mix a muscle with a training
phase ("Back (Cool Down)"). They cannot be forced into an enum without losing data.

## 3. Workout List — `/WorkOut/WorkOutList`

```
Sidebar → /WorkOut/WorkOutList → WorkOutController.WorkOutList() → return View()
View (WorkOutList.cshtml) → $.ajax GET /WorkOut/GetWorkOutList
  → WorkOutService.GetWorkOutList() → WorkOutDAL.GetWorkOutList()
```

The exact SQL (`WorkOutDAL.cs:101-107`):

```sql
select a.workout_id, a.workout_name, a.workout_type, a.equipment, a.primary_muscle
from m_workout a
order by a.workout_id
```

- No `WHERE`, so **the 6 `delete_flg = 1` workouts are listed like any other**.
- No `LIMIT`: all 188 rows go to the browser, Tabulator pages them locally at
  `paginationSize: 10` (`pagination: "local"`).
- Returns **5 columns only** — no media, no level, no description, no status.
- Columns shown: Name, Type, Equipment, Primary Muscle, each with a `headerFilter`, plus an
  edit icon. **No thumbnail is displayed** (the image column is commented out).
- **No delete action exists at all** — the delete block is commented out and there is no
  delete endpoint on the controller.

## 4. Add Workout

```
GET /WorkOut/Index → AddWorkOut.cshtml (Mode = "Add")
POST /WorkOut/CreateWorkOut  (multipart/form-data)
  → validate ModelState → save video → save thumbnail
  → WorkOutService.InsertWorkOut → WorkOutDAL.InsertWorkOut → INSERT m_workout
  → ViewBag.CreateStatus → alert() → redirect to the empty form
```

**Server-side required fields** (`WorkOutModel.cs`): `WorkOut_Name`, `Primary_Muscle`,
`Description` — only three. Type, Equipment, Level and YouTube carry no `[Required]`, even
though the form marks Type/Equipment with `*`. The selects always post a value anyway
(first option is pre-selected), so they are never empty in practice.

Unlike the Food form, this view **does** load `jquery.validate.unobtrusive.js` (`:9`), so
client-side validation actually runs here.

Columns written by `InsertWorkOut`: name, type, equipment, primary/secondary muscle, level,
youtube_link, description, video_file_name, thumbnail_file_name, `created_by = 123`,
`last_update_date = CURRENT_TIMESTAMP()`, `last_update_by = 123`.

Media handling (`WorkOutController.cs:221-302`):

| | Video | Thumbnail |
| --- | --- | --- |
| Accepted | `.mp4` only, by **file extension** | `.jpg`, `.jpeg`, `.png`, by extension |
| Stored name | `Guid` + original extension | same |
| Directory | `wwwroot/WorkOut/Video` | `wwwroot/WorkOut/TempThumbnail` → resized → `wwwroot/WorkOut/Thumbnail` |
| Processing | **none** — copied byte-for-byte | ImageMagick `Resize(300,300)`, `Quality = 70` |
| Size limit | none in code | none in code |
| MIME sniffing | none | none |

**Legacy defect:** `SaveVideo`/`SaveImage` are called unconditionally (`:87-88`) and
dereference `file.FileName` immediately, so creating a workout **without** a video or
thumbnail throws a `NullReferenceException`. In practice every one of the 188 rows has both
files, which is consistent with the form being unusable without them.

## 5. Edit Workout

```
GET /WorkOut/EditWorkOut?WorkOutId=n
  → stores WorkOutId in SESSION  → SELECT * FROM m_workout WHERE workout_id = n
  → fields read positionally (dt.Rows[0][1..10]) → AddWorkOut.cshtml (Mode = "Edit")
POST /WorkOut/UpdateWorkOut → UPDATE m_workout ... WHERE workout_id = <session value>
```

Media on edit (`WorkOutDAL.cs:56-57`) — this is the important rule:

```csharp
string videoUpdate     = VideoFileName     == null ? null : " video_file_name = '" + ... + "',";
string thumbnailUpdate = ThumbnailFileName == null ? null : " thumbnail_file_name = '" + ... + "',";
```

So: **a media column is only written when a new file was uploaded**. Text-only edits,
YouTube-only edits and single-file replacements all leave the other media untouched. The old
physical file is **never deleted** — every replacement orphans a file on disk.

`last_update_by` is hardcoded `123`; the workout id comes from the **session**, not the form,
so two tabs editing different workouts overwrite each other.

## 6. Delete / status behaviour

- `delete_flg` exists and 6 rows carry `1`, but **no legacy code ever sets it** — there is no
  delete action, no `UPDATE ... delete_flg`, and no `DELETE` statement anywhere for workouts.
  Those 6 rows were flagged outside the application.
- The admin list ignores `delete_flg`, so deleted workouts are still shown and still editable.
- The mobile API's own workout reads build a `whereQuery` (`api/ggf.Data/WorkoutDAL.cs:38`),
  which is where filtering happens for the app.

**Conclusion for the new system:** hard delete is unsafe. 175 of the 188 workouts are
referenced by `r_workout_plan` (3977 rows), so removing a document would orphan real plan
history. The new model uses the project's existing archive convention
(`status: active | archived` + `archivedAt`/`archivedBy`), identical to GoGetFit Plans and
Foods. Legacy `delete_flg = 1` maps to `archived`, which is the first time that flag has ever
had a visible effect.

## 7. Relationship map

```
m_workout (188)
   ├── r_workout_plan (3977 rows, 175 distinct workout_id)   ← sets/reps per plan+category
   │      ├── m_workout_plan (372)  → user_id
   │      └── m_workout_category (1259)
   ├── r_workout_plan_category (1257)
   └── r_workout_plan_dates (6283)
```

- 3 rows in `r_workout_plan` reference a `workout_id` that no longer exists in `m_workout`
  — pre-existing orphans in the legacy data, not caused by migration.
- `r_plan_workout` and `m_workout_type` are empty and unreferenced; both are ignored.
- **GoGetFit 2.0 has no workout-plan backend yet.** The Flutter workout plan
  (`lib/features/coaches/domain/workout_plan.dart`) states in its own header that no API
  exists and the content is placeholder. The new Admin Portal's workout screens are
  mock-backed (`src/mock/workouts/`). So there is no existing reference shape to conflict
  with; the Workout document is keyed by `_id`, which a future plan links to.

## 8. Media availability

Verified by read-only HEAD requests: the files are live on the legacy host.

```
https://apiimages.gogetfitonline.com/WorkOut/Video/<video_file_name>
https://apiimages.gogetfitonline.com/WorkOut/Thumbnail/<thumbnail_file_name>
```

Sampled 4 workouts — 8/8 files returned 200 with real content types
(`video/mp4` 2.3–7.2 MB, `image/png`/`image/jpeg` 10–78 KB). All 188 rows carry both
filenames and a YouTube link; none are empty.

## 9. Migration mapping

| Legacy | New | Note |
| --- | --- | --- |
| `workout_id` | `legacy.workoutId` (+ `legacy.source`) | unique partial index, the migration identity |
| `workout_name` | `name` | required |
| `workout_type` | `type` | enum `Gym` / `Home` / `General`, casing preserved |
| `equipment` | `equipment` | enum, legacy misspelling **`Pair of Dumbells`** preserved as stored |
| `primary_muscle` | `primaryMuscle` | free text, required |
| `secondary_muscle` | `secondaryMuscle` | free text, optional |
| `workout_level` | `level` | `"LEVEL 2"` → number `2` |
| `youtube_link` | `youtubeUrl` | |
| `description` | `description` | required |
| `video_file_name` | `video` | `{ url, storageKey }` after the file is copied |
| `thumbnail_file_name` | `thumbnail` | same |
| `delete_flg = 1` | `status: "archived"` | 6 rows |
| `last_update_date` | `legacy.updatedAt` | the only legacy timestamp that exists |
| `created_by`, `last_update_by` (`"123"`) | **dropped** | not Mongo user ids; `createdBy`/`updatedBy` record the real admin instead |

## 10. Deliberate deviations from legacy

| Legacy behaviour | New behaviour | Why |
| --- | --- | --- |
| `created_by = 123` | authenticated admin ObjectId | the ask, and legacy's value is meaningless |
| SQL built by string concatenation | Mongoose | injection |
| Workout id taken from the session | id in the route | two tabs corrupt each other |
| Extension-only file checks | byte-signature sniffing + size limit | a renamed file reaches the server |
| Replaced media files orphaned forever | old object removed after the DB update succeeds | disk leak |
| Deleted workouts shown in the list | archived rows hidden by default | `delete_flg` finally means something |
| No pagination (all rows to the browser) | server-side paging/search/filter/sort | project convention |
| Level stored as `"LEVEL 2"` text | `level: 2` number | the portal's existing `WorkoutLevel` type is already 1-5 |

`m_workout_type`, `r_plan_workout`, `created_by`/`last_update_by` are intentionally excluded —
the first two are empty and unreferenced, the last two are legacy login ids with no mapping.
