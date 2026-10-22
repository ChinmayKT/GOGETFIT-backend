# Workout Plans — Legacy Audit and MongoDB Migration Brief

Investigation only. No application code, schema, data, config or env file was changed, no migration was run, and nothing was written to any database. Personal data is not reproduced here: plan names, people and user ids appear only as counts.

**Evidence labels used throughout**

- **[V-code]** Verified from code/schema (source file or `SHOW CREATE TABLE`).
- **[V-data]** Verified from read-only database data (aggregate queries run on 2026-10-20).
- **[Inferred]** Inferred — needs confirmation.
- **[Unknown]** Unknown — requires further investigation.

**Path prefixes**

- `api/` = `Old GGF/ggf/api/`
- `admin/` = `Old GGF/ggf/admin/`
- `oldapp/` = `Old GGF/GGF flutter/gogetfit/lib/`
- `be/` = `GoGETFIT backend/`
- `app/` = `GoGetFit 2.0/lib/`

**How the data was read**

- **Legacy MariaDB:** only through `be/migration/config/mariadb.js`. This read-only pool runs `SET SESSION TRANSACTION READ ONLY` on every connection (`:38-40`) and refuses any statement that is not SELECT/SHOW/DESCRIBE/EXPLAIN (`:8-19`). `assertMigrationEnv()` (`be/migration/config/migration.env.js:69-90`) ran first.
- **Which legacy database:** the configured legacy database is **`staging-ggf`**, a MariaDB 10.11 snapshot. Every legacy count in this document comes from it.
- **MongoDB:** the configured development cluster, database `gogetfit`. Only `countDocuments`, `find` projections and `indexes()` were run, with `autoCreate:false, autoIndex:false`. The connection matched the `dev-target.js` host pattern.
- **Scripts:** throwaway scripts lived only in `/private/tmp/claude-501/`.

> **Scope caveat.** `staging-ggf` is a snapshot frozen on 2024-06-28/29. Live production (`gogetfit`) is about 10× larger: 3,474 plans, 69,632 exercise rows, 119,606 date rows and 527 workouts. Those production figures come from a prior report (`Old GGF/oldggfsystemreport.md` §10, lines 740-766) and are **not re-verified here**: the migration env guard refuses the production database unless `MIGRATION_ALLOW_PRODUCTION` is set, and I did not set it. Every rule below must be re-measured on the real source before an apply run.

---

## 1. Executive summary

1. **Tables.** A legacy workout plan spans five live tables. **[V-code]**
   - `m_workout_plan` is the header, bound to one client.
   - `m_workout_category` holds the free-text "blocks", linked through `r_workout_plan_category`.
   - `r_workout_plan` holds one row per exercise in a block. Sets and reps are each `varchar(5)`.
   - `r_workout_plan_dates` holds one row per assigned calendar day and has **no PK**.
   - `m_workout` is the exercise master. It has already been migrated to Mongo `workouts`.
   - `r_plan_workout` and `m_workout_type` are empty and unused.
2. **No database integrity.** There are **no foreign keys, stored procedures, triggers or views** in the database. Every relationship is enforced only by inline, string-concatenated SQL in `api/ggf.Data/WorkoutDAL.cs`. There are no transactions and no authorization. **[V-code]**
3. **What a legacy plan really is: one training session.** In practice it is a single session (≤7 blocks, ≤29 exercises) that is repeated on sparse days.
   - 210 of 257 dated plans fall on exactly **2 weekdays**.
   - Gaps between assigned days are mostly 3 or 4 days.
   - A client gets several such plans interleaved over the same weeks: 55 of 61 clients have overlapping plan ranges. **[V-data]**
   - This matches the new app's **one session with 8 blocks** (`app/features/coach_workspace/domain/workout_plan_draft.dart`).
4. **The diet-plan layout does not fit.** Copying the diet-plan migration's "one document per contiguous date run" layout would produce **5,882 documents for 257 plans** in staging. Recommendation (proposal): one document per legacy plan, with embedded blocks and an explicit `selectedDates` list, which is the same convention app-created `dietplans` already use. **[V-data] / proposal**
5. **Day selection rule.** The member sees, for a given day, the plan with the newest `m_workout_plan.create_date` among that client's plans assigned to that day (`ORDER BY a.create_date DESC LIMIT 1`).
   - In staging, 513 of 5,591 client-days have 2 to 4 competing plans.
   - There are **0 ties**.
   - 5 plans are fully shadowed. **[V-code] / [V-data]**
6. **Sets and reps are free text.** **[V-data]**
   - Reps: 51% ranges (`12-15`), 25% integers, 23% seconds (`15sec`).
   - Sets: 99% integers.
   - About 12 values are malformed (`30cc`, `I `, `r`, `50/10`, …).
   - The new app models `sets:int`, `measure: reps|time` and `amount:int`, so ranges cannot be represented. The raw strings must be preserved.
7. **Mongo has no workout-plan or assignment model yet.** The only workout collection is the exercise library `workouts` (188 documents, all with `legacy.workoutId`). **[V-code] / [V-data]**
8. **Dev reference resolution (staging data against the dev Mongo):**
   - Plan owners: **138/372 plans** resolve to a Mongo user (22 of 62 owners).
   - Coach: 194 plans have a verified Coach, 162 have a creator with no Mongo Coach, and 16 were created by a non-coach.
   - Exercises: 173/175 referenced exercise ids resolve. The 2 that do not are legacy orphans, affecting 3 rows.
   - Media: only 3 of 188 Mongo workouts have a migrated video. **[V-data]**

---

## 2. Verified SQL schema and relationships

**Common properties.** All tables are InnoDB, `utf8mb3_general_ci`, so string comparisons and the UNIQUE index are case-insensitive and ignore trailing spaces. **[V-code]**

**Server settings:**

- `@@sql_mode` = `STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION,IGNORE_SPACE`.
- `@@time_zone=SYSTEM`; `@@system_time_zone=Asia/Calcutta`.

All of the following are confirmed against `information_schema` and `SHOW CREATE TABLE`, and all are **[V-code]**:

- `KEY_COLUMN_USAGE` with a referenced table: **0 rows**, so there are no FKs in the whole schema.
- `ROUTINES`: 0. `TRIGGERS`: 0. `VIEWS`: 0.
- No `.sql` files exist in the legacy repos.

### `m_workout_plan` (plan header)

```
workout_plan_id   int(11) NOT NULL AUTO_INCREMENT   PK
workout_plan_name varchar(45) DEFAULT NULL          UNIQUE KEY workout_plan_name (table-wide)
user_id           int(11) NOT NULL                  -> m_user.user_id (client)   [app-only]
create_date       datetime DEFAULT NULL
created_by        int(11) NOT NULL                  -> m_user.user_id (coach)    [app-only]
last_update_date  datetime DEFAULT NULL
last_update_by    int(11) NOT NULL
AUTO_INCREMENT=376
```

### `m_workout_category` (a block; global id, not per plan)

```
workout_category_id   int(11) NOT NULL AUTO_INCREMENT  PK
workout_category_name varchar(45) DEFAULT NULL
create_date datetime NULL | created_by int(11) NOT NULL | last_update_date datetime NULL | last_update_by int(11) NOT NULL
AUTO_INCREMENT=1265
```

### `r_workout_plan_category` (plan ↔ block link)

```
workout_plan_id     int(11) NOT NULL AUTO_INCREMENT  -- AI flag on a link column (schema quirk; never used as AI)
workout_category_id int(11) NOT NULL
create_date datetime NULL | created_by varchar(45) NULL | last_update_date datetime NULL | last_update_by varchar(45) NULL
PRIMARY KEY (workout_plan_id, workout_category_id)
```

### `r_workout_plan` (exercise in a block)

```
workout_plan_id     int(11) NOT NULL AUTO_INCREMENT  -- same AI quirk
workout_category_id int(11) NOT NULL
workout_id          int(11) NOT NULL                 -> m_workout.workout_id [app-only]
sets_count          varchar(5) DEFAULT NULL
reps_count          varchar(5) DEFAULT NULL
create_date datetime NULL | created_by varchar(45) NULL | last_update_date datetime NULL | last_update_by varchar(45) NULL
PRIMARY KEY (workout_plan_id, workout_category_id, workout_id)
```

### `r_workout_plan_dates` (assignment)

```
workout_plan_id int(11) NOT NULL                     -> m_workout_plan [app-only]
workout_date    datetime DEFAULT NULL
create_date datetime NULL | created_by int(11) NOT NULL | last_update_date datetime NULL | last_update_by int(11) NOT NULL
-- NO PRIMARY KEY, NO INDEX AT ALL
```

### `m_workout` (exercise master)

```
workout_id int(11) NOT NULL AUTO_INCREMENT PK | workout_name varchar(45) | workout_type varchar(10) | equipment varchar(45)
primary_muscle varchar(50) | secondary_muscle varchar(50) | workout_level varchar(45) | youtube_link varchar(100)
description text | video_file_name varchar(100) | thumbnail_file_name varchar(100)
created_by varchar(45) | last_update_date datetime | last_update_by varchar(45) | delete_flg tinyint(1) NOT NULL DEFAULT 0
(all nullable except PK and delete_flg; no create_date; AUTO_INCREMENT=195)
```

The prior report says `delete_flg` exists in staging only, not in production. **[Unknown]** for production.

### Dead tables

Both are empty and unused. **[V-code] / [V-data]**

- `m_workout_type`: PK `workout_type` int AI, plus `workout_Type_title varchar(45)` and audit columns.
- `r_plan_workout`: PK `(plan_id, workout_id, workout_type char(1))`, plus `plan_name` and audit columns. Only `GetWorkOutPlanList` reads it (`WorkoutDAL.cs:51-84`), and that endpoint is not called by the app.

### Relationship map

None of these relationships are enforced by the database.

```
m_user ─(user_id: client)──────────┐
m_user ─(created_by: coach)────────┤
                                   ▼
                           m_workout_plan ──1:N── r_workout_plan_dates      (no PK; duplicates allowed)
                                   │
                                   ├──1:N── r_workout_plan_category ──N:1── m_workout_category   (N:M; copy shares categories)
                                   │
                                   └──1:N── r_workout_plan ──N:1── m_workout
                                                │
                                                └─(workout_category_id)── m_workout_category
```

| Relationship | DB-enforced? | Enforced where |
|---|---|---|
| plan → client (`user_id`) | No | Not even in the app: any `UserId` is accepted (`WorkoutDAL.cs:270-271`) |
| plan → coach (`created_by`) | No | Subquery on `login_token` (`WorkoutDAL.cs:274`). In strict mode, NULL fails the insert. |
| link → plan / category | PK only, no FK | App inserts (`WorkoutDAL.cs:321-337`, `448-462`) |
| exercise → plan / category / workout | PK only (also prevents duplicates within a block), no FK | App only. The category is never checked against the plan (`WorkoutDAL.cs:369-390`). |
| date → plan | Nothing | App only (`WorkoutDAL.cs:554-577`) |
| plan name uniqueness | **Yes**, UNIQUE index, table-wide, case-insensitive | Also pre-checked in the app (`WorkoutDAL.cs:218-233`) |

---

## 3. Data dictionary

| Table.column | Meaning | Written by | Notes |
|---|---|---|---|
| `m_workout_plan.workout_plan_id` | Plan identity | AI | Max id 375 in staging |
| `.workout_plan_name` | Coach-typed name | E1 / E9 | ≤42 chars in data. UNIQUE table-wide. `'` is escaped on create only (`WorkoutDAL.cs:256`), not on copy. **[V-code/V-data]** |
| `.user_id` | Client (member) | E1 / E9 `UserId` | 45 plans have `user_id=0`. 79 plans (8 ids incl. 0) have no `m_user` row. **[V-data]** |
| `.create_date` | Server `NOW()` (IST wall clock) | insert | **The day-selection precedence key** |
| `.created_by` | Coach `m_user.user_id` | `login_token` subquery | 3 distinct creators: 2 `user_type C` (356 plans), 1 `U` (16 plans). **[V-data]** |
| `.last_update_*` | — | insert only | Equal to create values on all rows. There is no UPDATE statement. **[V-code/V-data]** |
| `m_workout_category.workout_category_id` | Block identity (global) | AI | Display order = this id ascending |
| `.workout_category_name` | Block name ("warm up", "cool down", "chest workout"…) | E2 | ≤36 chars. 143 distinct (case-folded). Not escaped. **[V-data/V-code]** |
| `m_workout_category.created_by` etc. | Audit | insert | int NOT NULL |
| `r_workout_plan_category.*` | Which blocks a plan has | E2, E9 | Audit columns are varchar. 4 rows have NULL `created_by` (token did not resolve). **[V-data]** |
| `r_workout_plan.workout_id` | Exercise | E5, E9 | 175 distinct ids; 2 missing from `m_workout` (3 rows) |
| `.sets_count` / `.reps_count` | Prescription, free text | E5, E9 | See §7.6 |
| `r_workout_plan.created_by` | Audit (varchar) | insert | 8 NULL rows. **[V-data]** |
| `r_workout_plan_dates.workout_plan_id` | Assigned plan | E7 | 7 rows have `0` (from the empty `''` plan id). **[V-data]** |
| `.workout_date` | Assigned calendar day | `STR_TO_DATE('d-M-yyyy','%d-%m-%Y %H:%i:%s')` | All midnight. 0 NULL. **[V-data]** |
| `.create_date` / `.created_by` | Assignment time and coach | insert | `created_by` equals the plan's `created_by` on all 6,276 joinable rows. **[V-data]** |
| `m_workout.*` | Exercise library | admin portal | Already migrated (see `docs/workouts-legacy.md`) |

---

## 4. End-to-end data flow for one plan

The flow below is **[V-code]** unless marked otherwise. Endpoints are numbered E1–E10 as in §5.

1. **Create (E1).** The coach screen sends `{WorkoutPlanName, UserId:<client>, LoginToken}`.
   - `IsPlanNameExist` checks the name globally.
   - Then `INSERT m_workout_plan (…) VALUES (name, userId, NOW(), (select user_id from m_user where login_token=…), NOW(), …); SELECT LAST_INSERT_ID();`
   - Source: `WorkOutController.cs:79-131`, `WorkoutDAL.cs:252-291`.
2. **Blocks (E2), one call per block.** Two statements run on one connection **without a transaction**: `INSERT m_workout_category` + `LAST_INSERT_ID()`, then `INSERT r_workout_plan_category(planId, newCatId)` (`WorkoutDAL.cs:293-358`).
3. **Exercises (E5), one call per exercise.** `INSERT r_workout_plan(plan, category, workout, sets, reps, …)` (`WorkoutDAL.cs:363-405`).
4. **Remove (E6).** `DELETE FROM r_workout_plan WHERE plan AND category AND workout` (`WorkoutDAL.cs:521-546`).
5. **Assign (E7).**
   - The client sends `WorkoutDates:"1-11-2026,3-11-2026"` (`oldapp/views/appointments/view_plans.dart:882-891`).
   - The service splits on `,` (`WorkoutService.cs:78`).
   - The DAL runs one multi-row `INSERT r_workout_plan_dates` with `STR_TO_DATE(...)` (`WorkoutDAL.cs:548-593`).
6. **Member fetch for a date.**
   - E10 `GET api/GetWorkoutDietPlanDetails?LoginToken&date=d-M-yyyy&userId=<logged-in user>` (`oldapp/api/appointments/booking_api_provider.dart:560-571`) returns `{workout_plan_id, workout_plan_name, workout_date}` (`WorkoutDAL.cs:132-148`).
   - The app then opens `ViewWorkoutPlan(planId)`, which calls E3 `GET api/GetWorkoutPlanExercise?planId=` (`oldapp/views/appointments/workout/view_workout_plan.dart:903`).
   - E3 returns the header, the blocks and each block's exercises (`WorkoutService.cs:169-217`).

**SQL that reconstructs a plan.** These are the legacy queries, verbatim in shape.

```sql
-- header
select * from m_workout_plan where workout_plan_id = :plan;                              -- WorkoutDAL.cs:620
-- blocks (ordered by global category id)
select distinct a.workout_category_id, b.workout_category_name
from r_workout_plan_category a join m_workout_category b on a.workout_category_id=b.workout_category_id
where a.workout_plan_id = :plan order by b.workout_category_id;                          -- :671-681
-- exercises per block (NO ORDER BY; inner joins hide rows whose workout or category is missing)
select a.workout_id, b.workout_name, a.sets_count, a.reps_count, b.video_file_name, b.description video_description, b.thumbnail_file_name
from r_workout_plan a join m_workout b on a.workout_id=b.workout_id
join m_workout_category c on a.workout_category_id=c.workout_category_id
where a.workout_plan_id=:plan and a.workout_category_id=:cat;                            -- :636-655
-- plan for a member's day
select a.workout_plan_id, a.workout_plan_name, b.workout_date
from m_workout_plan a join r_workout_plan_dates b on a.workout_plan_id=b.workout_plan_id
where a.workout_plan_id in (select c.workout_plan_id from m_workout_plan c where c.user_id=:user)
  and b.workout_date = STR_TO_DATE(:d_M_yyyy,'%d-%m-%Y %H:%i:%s')
order by a.create_date desc limit 1;                                                     -- :132-148
```

The service then pads the block list to **8** with `{workoutCategoryId:0, workoutCategoryName:null, workoutCategoryExercise:[]}` (`WorkoutService.cs:186-190`).

**Illustrative example.** The values below are **made up** and are not real data.

```
m_workout_plan          (900, 'Demo Push A', user_id=5001, create_date='2024-03-01 10:00:00', created_by=7001)
m_workout_category      (4100,'Warm Up') (4101,'Chest Workout') (4102,'Cool Down')
r_workout_plan_category (900,4100) (900,4101) (900,4102)
r_workout_plan          (900,4100,12,'1','30sec') (900,4101,40,'4','12-15') (900,4101,41,'3','15') (900,4102,77,'1','20sec')
r_workout_plan_dates    (900,'2024-03-04 00:00:00') (900,'2024-03-07 00:00:00') (900,'2024-03-11 00:00:00') ...
```

For member 5001 on `4-3-2024`, E10 returns plan 900, unless another plan of 5001 assigned to that day has a later `create_date`.

---

## 5. API / SQL operation mapping

The following applies to every endpoint below. **[V-code]**

- **Auth:** none. There are no `[Authorize]` attributes in `api/`, and `app.UseAuthentication()` is registered *after* `UseEndpoints` (`api/ggfAPI/Startup.cs:67-75`).
- **Identity:** `LoginToken` from the body or query is used only to fill `created_by` and to filter E8. There is **no ownership check** on any plan, category or client id (IDOR).
- **SQL:** concatenated strings, so it is SQL-injectable.
- **Connection string:** a hard-coded, credential-bearing connection string at `WorkoutDAL.cs:14` (redacted here).
- **Transactions:** none.
- **Response envelope:** `{…, ResponseContext{StatusCode, Message, ResponseTimeStamp}}`.

| # | Operation | Endpoint | Inputs | Reads | Writes | Response | Tx / rollback | Implicit rules | Source |
|---|---|---|---|---|---|---|---|---|---|
| E1 | Create plan | `POST api/CreateWorkoutPlan` | `WorkoutPlanName, UserId, LoginToken` | `m_workout_plan` (name), `m_user` | `m_workout_plan` | `{PlanId, PlanNameExists}` | Single INSERT. Check-then-insert is not atomic; the UNIQUE index is the backstop (→ 400). | Name is global-unique; `'` escaped. Client not validated. | Ctl `:76-131`, DAL `:218-233, 252-291` |
| E2 | Create block | `POST api/CreateWorkoutCategory` | `WorkoutPlanId, CategoryName, LoginToken` | `m_user` | `m_workout_category`, `r_workout_plan_category` | `{WorkoutCategoryId}` | **None.** If the link insert fails, the category row is orphaned (14 unlinked categories exist). | Uniqueness check commented out (`Ctl :141-143`). Name not escaped. No 8-block limit server-side. | Ctl `:133-205`, DAL `:293-358` |
| E4 | Exercise library | `POST api/FetchWorkoutList` (also `GET api/workout/{name?}`) | `{WorkoutName?}` (the app sends `{}`) | `m_workout` | — | `{data:[rows]}` or "No data Exist" | — | **Does not filter `delete_flg`**. `LIKE` is injectable. | Ctl `:16-63`, DAL `:16-49` |
| E5 | Add exercise | `POST api/AddExerciseToWorkoutPlan` | `WorkoutPlanId, WorkoutCategoryId, WorkoutId, SetsCount, RepsCounts, LoginToken` | `m_user` | `r_workout_plan` | message only | Single INSERT. PK violation, or value over 5 chars in strict mode, → 400. | Category not checked against the plan. Sets/reps unvalidated. | Ctl `:207-255`, DAL `:363-405` |
| E6 | Remove exercise | `POST api/RemoveExerciseFromWorkoutPlan` | plan, category, workout | — | DELETE `r_workout_plan` | message (body 400 if 0 rows) | Single DELETE, hard. | No ownership check. | Ctl `:257-305`, DAL `:521-546` |
| E3 | Fetch plan with blocks and exercises | `GET api/GetWorkoutPlanExercise?planId=` | `planId` | `m_workout_plan`, `r_workout_plan_category`, `m_workout_category`, `r_workout_plan`, `m_workout` | — | `{WorkoutPlanDetails:{WorkoutPlanId, WorkoutPlanName, WorkoutCategories[8]:{…, WorkoutCategoryExercise[]}}}`, or the string `"null"` | — | Blocks sorted by category id. Exercises unordered. Padded to 8. Live join to `m_workout`. | Ctl `:358-394`, Svc `:169-230`, DAL `:615-690` |
| E9 | Copy plan | `POST api/CopyWorkoutPlan` | `WorkoutPlanId` (source), `WorkoutPlanName`, `UserId`, `LoginToken` | source rows | `m_workout_plan`, `r_workout_plan_category` (**same category ids**), `r_workout_plan` | `{SourcePlanId, DestinationPlanId (string), PlanNameExists}` | **None.** 3 separate statements; no try/catch, so a failure → 500. A header-only plan can remain. | Dates are **not** copied. Any plan can be copied (no permission check). Name not escaped. | Ctl `:439-524`, DAL `:407-518` |
| E7 | Assign dates | `POST api/AssignWorkoutToDates` | `WorkoutPlanId, WorkoutDates:"d-M-yyyy,…", LoginToken` | `m_user` | `r_workout_plan_dates` | "…assigned to N Dates" | One multi-row INSERT, so all-or-nothing as a statement | No dedupe, no PK, no overlap check, no client column. `''` plan id → 0. | Ctl `:307-356`, Svc `:74-92`, DAL `:548-593` |
| E10 | Member: plan for a date | `GET api/GetWorkoutDietPlanDetails?LoginToken&date&userId` | `date` = `d-M-yyyy`; `userId` = the **logged-in** user's id (`booking_api_provider.dart:571`) | `m_workout_plan`, `r_workout_plan_dates` (+ diet tables) | — | `{WorkoutPlanDetails:[{workout_plan_id, workout_plan_name, workout_date}], DietPlanDetails:[…]}` | — | Newest plan `create_date` wins. The `userId` path ignores the token. | Ctl `:527-552`, DAL `:86-160` |
| E8 | Coach plan lists | `GET api/FetchWorkoutPlanList[?LoginToken]` | token or nothing | `m_workout_plan`, `m_user` | — | `{PlanList:[select * rows]}` | — | "YOU": `created_by = me OR user_id = me`. "ALL" (no token): **every plan in the system**. | Ctl `:396-437`, DAL `:595-611` |

Other endpoints and screens:

- **E12** `GET api/workoutplan/{createdBy?}/{workoutType?}` reads the dead `r_plan_workout`. **[V-code]**
- **Admin portal (exercise library writes):** `admin/GGF.DAL/WorkOutDAL.cs:15-46` INSERT and `:48-78` UPDATE, with `created_by`/`last_update_by` hard-coded to `123`. There is no delete. **[V-code]**
- **UI-only rules (legacy Flutter):**
  - Assign calendar: today to 2080, past dates not selectable.
  - Member calendar: today and tomorrow only (`view_plans.dart:101-115`).
  - Copy-name limit of 50 chars (`work_out_list_screen.dart:574`).
  - Category-name limit of 50 chars (`create_workout_plan.dart:444`), above the 45-char column width.
  - Sets/reps: any text, no length limit. **[V-code]**

---

## 6. Edge cases, answered

1. **Shared vs copied categories on copy.** **Shared.** `CopyWorkoutPlanCategory` re-links the source's `workout_category_id`s into the new plan; `CopyWorkoutPlanExercise` clones the exercise rows under the same category ids (`WorkoutDAL.cs:442-518`). **[V-code]** In staging, 6 categories are each linked to 3 plans, and 9 plans share categories with other plans. **[V-data]** Category names are never updated, so sharing is harmless for reads. The migration must still **deep-copy** blocks per plan.
2. **Master reference vs snapshot.** **Reference.** Exercise name, description and media are joined live from `m_workout` at read time. Only `sets_count` and `reps_count` belong to the plan. **[V-code]**
3. **Duplicate exercise in a block.** Impossible: PK `(plan, category, workout)`. **[V-code]** The same exercise in *different* blocks of one plan is allowed: 60 (plan, workout) pairs. **[V-data]**
4. **Duplicate date assignments.** Allowed, because there is no PK. Staging has 130 (plan, date) groups with 134 extra rows, in 10 plans, max 3 copies. **[V-data]** They are harmless to reads (`LIMIT 1`) and should be deduplicated. Production reportedly has 822 duplicates. **[not re-verified]**
5. **Several plans for one client on one date.** All rows are kept. The read picks the **newest `m_workout_plan.create_date`** (plan creation, not assignment time). **[V-code]** Staging has 513 such client-days (max 4 plans), **0 ties**, and **5 plans that never win any day**. **[V-data]** Equal `create_date` has no tie-break in legacy. **[V-code]**
6. **DATE vs DATETIME, parsing and timezone.**
   - `workout_date` is `DATETIME`. All 6,283 values are midnight. **[V-data]**
   - Input is device-local `d-M-yyyy`, unpadded (`view_plans.dart:128-132`).
   - Probe results (a SELECT on literals only):
     - `STR_TO_DATE('1-11-2026','%d-%m-%Y %H:%i:%s')` → `2026-11-01 00:00:00`.
     - The ISO form `'2026-11-01'` → **NULL**, which the nullable column would accept silently.
     - `'31-2-2026'` → `2026-02-31` (rejected by strict mode on insert). **[V-data]**
   - There is no timezone handling. The dates are naive IST calendar days (server zone Asia/Calcutta), and audit columns use the server's `NOW()`. **[V-code/V-data]**
7. **Partial creation on failure.** Every step is its own auto-committed statement, so abandoned builders leave partial plans. **[V-code]** In staging: **[V-data]**
   - 57 plans have no blocks.
   - 87 plans have no exercises.
   - 120 categories never received an exercise.
   - 108 plan-block links are empty.
   - 14 categories are unlinked.
   - 115 plans are undated, 30 of which have exercises.
   - 2 dated plans have no exercises. They still win their days and hide older plans, showing an empty plan.
8. **Dangling references.** Counts are in §7.3. The legacy read hides exercise rows whose workout or category is missing (inner joins): 3,972 of 3,977 rows are visible. **[V-data]**
9. **Plan-name uniqueness scope.** Global (table-wide UNIQUE, case- and trailing-space-insensitive under `utf8mb3_general_ci`). There is no per-coach or per-client scope. **[V-code]** Block names are not unique at all.
10. **UI limits not enforced by the database.**
    - 8 blocks: padding and display only; data max is 7. **[V-data]**
    - Block-name 50 vs column 45: data max is 36.
    - Sets/reps unlimited in the UI vs `varchar(5)` in the column. Strict mode rejects longer values. 1,968 reps values sit exactly at 5 chars. **[V-data]**
    - No past dates: yet 12 assignment rows are dated before the day they were created. **[Inferred]** older app build or another path.
    - Today/tomorrow-only member view.

---

## 7. Real-data aggregates (staging-ggf, read-only)

### 7.1 Volumes

| Item | Count |
|---|---:|
| `m_workout_plan` | 372 (2023: 173, 2024: 199; create range 2023-02-19 → 2024-06-28) |
| `m_workout_category` | 1,259 (143 distinct names) |
| `r_workout_plan_category` | 1,257 |
| `r_workout_plan` | 3,977 (285 plans, 1,150 plan-block pairs, 175 distinct exercises) |
| `r_workout_plan_dates` | 6,283 (6,149 distinct plan-days; 258 plan ids incl. `0`) |
| `m_workout` | 188 (6 `delete_flg=1`, all 6 still referenced by 226 plan rows) |
| `r_plan_workout`, `m_workout_type` | 0, 0 |

### 7.2 Distribution

**Plans per client** (62 clients), as plans:clients: 1:3, 2:1, 3:18, 4:12, 5:4, 6:7, 7:5, 8:2, 9:1, 10:2, 11:2, 12:1, 13:1, 14:1, 17:1, 45:1. The single 45-plan "client" is `user_id=0`.

**Plans per creator:** 3 creators with 194, 162 and 16 plans. 17 plans have creator = owner (a coach's own plans).

**Blocks per plan:**

| Blocks | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Plans | 57 | 55 | 14 | 9 | 54 | 168 | 14 | 1 |

**Exercises:** per plan max 29 (avg 14.0); per block max 12 (avg 3.5).

**Most common block names** (generic, count ≥20): warm up 260 · cool down 227 · triceps workout 50 · chest workout 47 · back workout 45 · core workout 45 · shoulder workout 42 · biceps workout 36 · abs workout 31 · cardio 30.

### 7.3 Orphans and missing references

All figures are **[V-data]**.

| FK-like column | Orphans |
|---|---|
| `m_workout_plan.user_id` → `m_user` | **79 plans** (45 with `user_id=0`, 34 across 7 non-existent users). 14 of them have dates. |
| `m_workout_plan.created_by` → `m_user` | 0 |
| `r_workout_plan_category.workout_plan_id` / `.workout_category_id` | 0 / 0 |
| `r_workout_plan.workout_plan_id` | 0 |
| `r_workout_plan.workout_category_id` → `m_workout_category` | 2 rows |
| `r_workout_plan` (plan, category) not linked in `r_workout_plan_category` | 2 rows |
| `r_workout_plan.workout_id` → `m_workout` | 3 rows (2 distinct ids) |
| `r_workout_plan_dates.workout_plan_id` → `m_workout_plan` | 7 rows, all with plan id `0` |
| `m_workout_category` not linked to any plan | 14 |
| Audit `created_by` NULL | 8 in `r_workout_plan`, 4 in `r_workout_plan_category` |

### 7.4 Assignments

| Item | Value |
|---|---|
| Date range | 2023-02-01 → 2024-09-30. By year: 2023 = 794, 2024 = 5,489. |
| Dates per plan | max 61 distinct, avg 23.8 |
| Assignment batches per plan | 1: 249 plans · 2: 7 · 3: 2 |
| Contiguous runs per plan | 1: 15 · 2-3: 9 · 4-10: 5 · >10: **228**. Total **5,882 runs**, max 41. Max span 145 days. |
| Gap between consecutive days | 1d 260 · 2d 46 · **3d 2,694 · 4d 2,585** · 5-6d 9 · 7d 286 · >7d 5 |
| Distinct weekdays per plan | 1: 27 · **2: 210** · 3: 6 · 4: 2 · 5: 3 · 6: 1 · 7: 8 |
| Clients whose plan date ranges overlap | 55 of 61 (387 overlapping plan pairs) |
| Client-days with more than one plan | 513 of 5,591. Max 4. 0 ties. 5 plans fully shadowed. |
| Exercise rows added after the plan's first assignment | 5 |

### 7.5 Against MongoDB (dev `gogetfit`, legacy-id bridges)

All figures are **[V-data]**.

**Plan owners.** The bridge is `m_workout_plan.user_id` → `users.legacy.userId` (`be/migration/identity/legacy-id-map.js:13-22`).

- 22 of 62 owners resolve, covering **138 of 372 plans**.
- **234 plans are unresolved.** Dev holds only 26 legacy users.

**Coach.** I ran the diet-plan two-path verification read-only (`be/migration/loaders/diet-plan.loader.js:36-91`):

- **Verified: 194 plans.**
- "No Mongo Coach for this user": 162 plans (one coach).
- "Not a legacy coach": 16 plans (one `user_type U` creator).
- Coaches carry **no legacy id**. The bridge goes through `Coach.userId` → `users.legacy.userId`, cross-checked by email against `m_coach` (`be/migration/mappings/legacy-coach.mapping.js`).

**Exercises.** 175 distinct referenced ids. **2 are missing in `workouts.legacy.workoutId`, both are also missing in legacy** (3 rows). No exercise is missing from Mongo alone.

### 7.6 Sets/reps value shapes

All figures are **[V-data]**.

| Column | integer | range `a-b` | seconds `Nsec` | minutes | other |
|---|---:|---:|---:|---:|---:|
| `sets_count` | 3,952 | 19 | 0 | 0 | 6 |
| `reps_count` | 1,005 | 2,023 | 921 | 1 | 27 |

**Top values:**

- sets: `4` 1260 · `3` 1109 · `1` 858 · `2` 642 · `12` 19 · `5` 16.
- reps: `12-15` 575 · `15` 562 · `15-20` 471 · `15sec` 414 · `10-15` 318 · `30sec` 242 · `10` 232 · `20sec` 201.

**Unusual values:**

- sets: `20/3`, `30cc`, `50/10`, `1 `, `I `, `r`, plus odd ranges `2-10`, `12-12`, `22-10`, `20-40`, `30-30`.
- reps:
  - `30rep` 17, `15rep` 5, `20rep` 2
  - `10/3`, `40cc`, `30/10`
  - `01min` 1

**Other checks:**

- 0 NULL, 0 empty, 0 zero values.
- Max length 5, which is the column limit. 1,968 reps values are exactly 5 chars.
- Trailing spaces exist (`1 `, `I `) and are invisible to `TRIM` comparisons under PAD SPACE collation.

**Fit with the new app:** sets and reps were entered in the wrong field order in some rows (e.g. sets `12` with reps `15`, or sets `15`). **[Inferred]**

### 7.7 Document size

- Largest plan: 6 blocks and 29 exercises (max blocks in any plan: 7).
- Estimated JSON size in the proposed shape (§9): **≈5.4 KB**.
- Even with 61 embedded dates, a document stays far below 16 MB, so embedding is safe. **[V-data]**

---

## 8. Existing MongoDB schema and backend findings

**Collections (dev):** bodymetrics, cartitems, coaches, coupons, dietplans, enrolledclients, foodlogs, foods, freedietplans, gogetfitplans, migrationconflicts, otps, questionnaires, users, workouts. **[V-data]**

> **No workout-plan or assignment model exists.** **[V-code/V-data]** `be/src/models/` contains no such file, a grep for `workoutplan|workout_plan|workout-plan` in `be/src` returns nothing, and no such collection exists. The new Flutter app's plan screens run on local seed data (`app/features/coach_workspace/data/workout_plan_library_data.dart`).

### `workouts` (exercise library)

Source: `be/src/models/workout.model.js`. **[V-code]**

- **Fields:**
  - `name`
  - `type` (enum Gym/Home/General)
  - `equipment` (enum, incl. the legacy spelling "Pair of Dumbells")
  - `primaryMuscle`, `secondaryMuscle` (free text)
  - `level` (1-5)
  - `description`, `youtubeUrl`
  - `video` / `thumbnail` as `{url, storageKey}`
  - `status` active|archived, with `archivedAt` / `archivedBy`
  - `legacy{source, workoutId}`, `migration{runId, migratedAt, version}`
  - `createdBy`, `updatedBy`, timestamps
- **Indexes:**
  - Unique partial `uniq_legacy_source_workoutid` on `(legacy.source, legacy.workoutId)` (`:135-142`).
  - `workout_status_name`, `workout_classification`, `workout_name`.
  - Confirmed live. **[V-data]**
- **Not stored:** a reps/time **measure**. The new app's comment says the measure "comes from the library entry", but the schema has no such field. **[V-code]**
- **Data:** 188 documents, all with a legacy id; 182 active, 6 archived; 3 with a migrated video. **[V-data]**

### Routes and auth

**[V-code]**

- `GET /api/coach/workouts`, behind `requireAuth` and `requireRole(ROLE_COACH)`, returns active workouts only, paged (`be/src/routes/coach-workspace.routes.js:32,57`; `be/src/services/workout.service.js:237-280`).
- Admin CRUD lives at `/api/admin/workouts` (`be/src/routes/admin.routes.js:161-175`).
- `requireAuth` verifies a Bearer JWT whose `sub` is a Mongo `_id` and loads an active user (`be/src/middleware/auth.middleware.js:6-31`).
- Envelope: `{success:true, data}` on success and `{success:false, error:{code, message}}` on error (`be/src/middleware/error.middleware.js:69`).

### `dietplans` (closest analogue)

Source: `be/src/models/diet-plan.model.js`. **[V-code]**

- `planId` string (`"gogetfit:<id>"`), `clientId` (required, immutable), `enrollmentId?`, `coachId?`, `name`.
- Dates:
  - `fromDate` / `toDate` are IST start-of-business-day.
  - **`selectedDates`** (app-created gapped plans) is validated as ascending, from `fromDate` to `toDate`.
  - `assignedAt` is the precedence key.
- `meals[]` embedded, `status`.
- `legacy{source, dietPlanId, createdBy, createDate, lastUpdateDate, segment{index, of}}`, `migration{…}`.
- Indexes:
  - `dietplan_client_range_assigned`
  - unique partial `uniq_legacy_source_dietplan_segment`
- `findForDay` (`:216-228`) reproduces the legacy "newest wins" rule.
- Dev holds 62 documents, 61 of them legacy. **[V-data]**

### Migration toolkit

**[V-code]**

- **Read-only legacy pool:** `be/migration/config/mariadb.js`.
- **Production rail:** `assertMigrationEnv`.
- **Dev-only target guards:** `be/migration/config/dev-target.js:16-49`, which check NODE_ENV, refuse when production is allowed, and check the host and database name.
- **Run reports:** `be/migration/reports/runs/*.json`.
- **Diet-plan pattern** (`be/migration/scripts/migrate-diet-plans.js`):
  1. Extract.
  2. `buildReferences`.
  3. `transformAll` with explicit block statuses.
  4. `gateByClient`: a client is migrated whole or not at all (`be/migration/loaders/diet-plan.loader.js:142-151`).
  5. Schema `validate()` without saving.
  6. Field verification.
  7. **Day-by-day replay of the verbatim legacy SQL.**
  8. `--apply` refuses unless there are 0 mismatches.
  9. `applyDietPlans` is create-only and refuses conflicting re-runs (`:319-344`).
- **Rollback:** no generic rollback script exists. A rollback would filter on `migration.runId`. **[V-code]**

---

## 9. SQL → MongoDB field mapping

> The target collection `workoutplans` **does not exist**. Its shape below is a **PROPOSAL**, aligned with `diet-plan.model.js` conventions, and is not existing fact.
>
> **Proposed layout:** one document per legacy plan, with blocks embedded. Dates are stored in the app-created dietplan form: `fromDate`/`toDate` plus `selectedDates` for gapped days.
>
> **Why not the diet-plan migration layout:** one document per contiguous run would create 5,882 documents for 257 plans in staging, each duplicating the content.
>
> **Idempotency key:** unique partial `(legacy.source, legacy.workoutPlanId)`.

| Old SQL table | Old SQL column | Meaning | New collection | New field (proposal) | Transformation | Risk / notes |
|---|---|---|---|---|---|---|
| m_workout_plan | workout_plan_id | plan id | workoutplans | `planId = "gogetfit:<id>"`, `legacy.workoutPlanId` | Number → string key; never `_id` | Idempotency key (unique partial index) |
| m_workout_plan | workout_plan_name | name | workoutplans | `name` | **verbatim** | Drop global uniqueness; names may contain client names, so never log them |
| m_workout_plan | user_id | client | workoutplans | `clientId` (ObjectId → users) | `users.legacy.userId` bridge only | 79 plans have no `m_user` (45 `user_id=0`) → exception report; 234 unresolved in dev |
| m_workout_plan | created_by | coach | workoutplans | `coachId` (→ coaches) + `legacy.createdBy` (number) | Diet-plan two-path verification | Null when unverified (162 + 16 plans in dev); keep the raw id |
| m_workout_plan | create_date | creation and precedence | workoutplans | `assignedAt` + `legacy.createDate` | `legacyInstant()` (IST → instant), `be/migration/transformers/diet-plan.transformer.js:31-37` | Must stay the precedence key (newest wins) |
| m_workout_plan | last_update_date / _by | audit | workoutplans | `legacy.lastUpdateDate`; `_by` dropped | as above | Equal to create on all rows |
| m_workout_category | workout_category_id | block identity / order | workoutplans | `blocks[].order` (array index) + `blocks[].legacyCategoryId` | Sort by id ascending (legacy display order) | Shared across copies; **deep-copy** per plan |
| m_workout_category | workout_category_name | block name | workoutplans | `blocks[].name` | **verbatim** | 0 blank; max 36 chars |
| m_workout_category | create_date / created_by / last_update_* | audit | — | none | dropped | 14 unlinked categories: report only |
| r_workout_plan_category | workout_plan_id, workout_category_id | membership | workoutplans | embedding of `blocks[]` | join | 108 empty links → keep empty blocks? (U3) |
| r_workout_plan_category | audit columns | — | — | none | dropped | — |
| r_workout_plan | workout_id | exercise | workoutplans | `blocks[].workouts[].workoutId` (→ workouts) | `workouts.legacy.workoutId` bridge | 3 rows → missing exercise; legacy hides them, so exclude and report. Archived workouts (226 rows) must remain valid references. |
| r_workout_plan | (none) | exercise order | workoutplans | `blocks[].workouts[]` array order | `workout_id` ascending = the PK order the legacy read used (EXPLAIN: PK `ref` access) | **[Inferred]**: legacy order was not guaranteed |
| r_workout_plan | sets_count | sets | workoutplans | `setsRaw` (**verbatim**) + `sets` (int when integer) | Tolerant parse | 25 non-integer values → `sets:null` + exception report |
| r_workout_plan | reps_count | reps or time | workoutplans | `repsRaw` (**verbatim**) + `measure` (`reps`/`time`) + `amount` / `amountMax` | `^\d+$` → reps; `^\d+-\d+$` → reps range; `\d+sec` → time seconds; `\d+rep` → reps; `01min` → 60s | Ranges (2,023) do not fit the app's single `amount:int`; the app model needs `amountMax` or raw display (U1) |
| r_workout_plan | create_date, created_by, last_update_* | row audit | — | none | dropped | Not used by legacy reads |
| (none) | — | per-exercise note | workoutplans | `note: null` | — | App-only field (≤100 chars); no legacy source |
| r_workout_plan_dates | workout_plan_id + workout_date | assigned days | workoutplans | `fromDate`, `toDate`, `selectedDates[]` | `DATE_FORMAT('%Y-%m-%d')` → dedupe → `startOfBusinessDay()` | Duplicates (134) collapse. Plan id `0` (7 rows) → exception report. Must replay to 0 mismatches. |
| r_workout_plan_dates | create_date / created_by | assignment audit | workoutplans | optional `legacy.assignmentBatches` | — | Not used by legacy reads; equal to plan creator |
| (none) | — | status | workoutplans | `status: 'active'` | — | — |
| (none) | — | enrollment | workoutplans | `enrollmentId` (nullable) | Diet-plan enrollment rule, or null | Plans span enrollments → open decision (U4) |
| (none) | — | provenance | workoutplans | `migration{runId, migratedAt, version}` | run metadata | Used for rollback |
| m_workout (all) | — | library | workouts | already migrated | `docs/workouts-legacy.md` | Media: 3/188 videos migrated so far |
| m_workout_type, r_plan_workout | all | dead | — | none | ignore | 0 rows |

**Fields with no target:** all row-level audit columns, category audit columns, `last_update_by`, and the dead tables.

**Needs manual resolution or an exception report:**

- 79 owner-less plans
- 7 plan-id-0 date rows
- 3 + 2 hidden exercise rows
- 25 malformed sets/reps values
- 14 unlinked categories
- 115 undated plans (draft or library decision)
- Unresolved creators

---

## 10. Confirmed business rules (summary)

1. A plan belongs to exactly one client from creation and is never reassigned. **[V-code]**
2. Blocks are free-text, ordered by global category id, up to 8 in the UI (padding only). **[V-code]**
3. An exercise appears at most once per block (PK), possibly in several blocks of the same plan. **[V-code/V-data]**
4. Sets and reps are free text of at most 5 characters. Time is written inside reps (`15sec`). **[V-code/V-data]**
5. Assignment is a set of individual calendar days. There is no range, recurrence, unassign or edit. **[V-code]**
6. On a day, the plan with the newest plan `create_date` wins. A plan with no exercises still wins. **[V-code]**
7. Exercise details are read live from the library, and archived (`delete_flg`) exercises still show. **[V-code/V-data]**
8. Copy creates a new header for the current client, shares block rows, clones exercise rows, and copies no dates. **[V-code]**
9. Plan names are unique system-wide. **[V-code]**
10. There is no authorization: any caller can read, copy or modify any plan. **[V-code]**

---

## 11. Unknowns needing confirmation

- **U1.** How the new app should show ranges (`12-15`) and odd values. Options: extend `PlannedWorkout` with `amountMax` and raw text, or display `repsRaw`. **[Unknown]**
- **U2.** Where `measure` (reps vs time) lives for library exercises. Mongo `workouts` has no such field. **[Unknown]**
- **U3.** Whether to migrate empty blocks, plans with no exercises (87) and undated plans (115), or report them only. The diet-plan precedent is to report dateless plans and not migrate them (`docs/diet-plans-design.md` D2). **[Unknown]**
- **U4.** Enrollment linkage. Should workout plans be split at enrollment boundaries like diet plans, or carry `enrollmentId: null`? **[Unknown]**
- **U5.** Production differences. `delete_flg` may be absent there, and the real counts, duplicates and orphans are unverified (prior report only). **[Unknown]**
- **U6.** How `user_id=0` plans were created under strict mode (45 plans), and whether they are coach templates. **[Unknown]**
- **U7.** Whether the legacy display order of exercises in production matched `workout_id` ascending. **[Inferred]** from the PK access path only.
- **U8.** Whether the 12 assignment rows dated before their creation day came from an older app build. **[Inferred]**
- **U9.** The fate of the 162 plans whose creator has no Mongo Coach in dev, and the creator who is not a coach (16 plans). This matches the diet-plan doc's open coach-mapping issue. **[Unknown]**

---

## 12. Migration risks, validation checks and rollback

**Risks**

1. **Wrong plan on a day.** Partial client migration, or a wrong `assignedAt`, would surface an older plan on a day a newer one used to win. Mitigation: reuse `gateByClient` (client all-or-nothing) and the replay.
2. **Information loss.** Normalising sets and reps loses information. Keep `setsRaw`/`repsRaw` verbatim and parse additively.
3. **Shared categories.** If a block is edited later, shared categories must not be shared in Mongo. Embed and deep-copy.
4. **Unverified source.** Staging-only measurements. Production is about 10× larger and its columns may differ (U5).
5. **Dev-only references.** Owner and coach resolution in dev covers 138 of 372 plans. A full-user target is needed before an apply run.
6. **Exercise media.** Archived or missing exercise media: only 3 videos are migrated, so member playback depends on `migrate-workout-media`.
7. **Date conversion.** IST date conversion must follow `startOfBusinessDay`. ISO and `d-M-yyyy` mixing yields NULL in legacy, so never reuse legacy parsing.

**Validation checks (dry run, all must pass before `--apply`)**

- **Counts reconciliation:**
  - Plans: migrated + blocked + not-migrated = 372.
  - Exercise rows: migrated = legacy-visible rows (3,972) minus those in blocked plans.
  - Distinct plan-days: equal to 6,149 minus the excluded ones.
- **Field verification:** every document's name, `assignedAt`, `legacy.createdBy`, `setsRaw` and `repsRaw` must equal the source byte-for-byte.
- **Replay:** run the verbatim E10 SQL (`WorkoutDAL.cs:132-148`) for every client-day, ±1 day around each plan's range, and compare against an in-memory `findForDay` equivalent. Required result: **0 mismatches** in selected plan and in content (E3 SQL vs embedded blocks).
- **Schema validation:** every document must pass `validate()` without saving.
- **Exception report:** missing user, unverified coach, missing exercise, malformed sets/reps, plan id 0, unlinked categories. Report ids only, no names.

**Safe rollback strategy**

- Insert-only loader that never updates or deletes, as in the diet-plan precedent.
- Unique partial index `(legacy.source, legacy.workoutPlanId)`, so re-runs are idempotent.
- A re-run whose content differs is reported as a conflict, and nothing is written.
- Every document carries `migration.runId`. Rollback = a dev-guarded `deleteMany({'legacy.source':'gogetfit', 'migration.runId': <id>})`, run in a transaction, after a JSON export of the run's documents. **No such script exists yet.**
- The dev-only target guard (`dev-target.js`) and the production rail stay mandatory.
- No `syncIndexes` and no collection auto-creation during a dry run (`autoCreate:false, autoIndex:false`).

---

## 13. Recommended migration sequence

1. **Approve the target model** (this document's §9 proposal): `workoutplans` with embedded blocks and dates as `fromDate`/`toDate`/`selectedDates`. Resolve U1-U4. Add the model and its indexes in code, with tests.
2. **Prerequisites in the target:**
   - users migrated (`users.legacy.userId`)
   - coaches linked (`link-legacy-coaches.js`)
   - `workouts` migrated, including media (`migrate-workouts.js`, `migrate-workout-media.js`)
3. **Write the pipeline**, mirroring the diet-plan files:
   - `workout-plan.extractor.js`: SELECT-only, with the verbatim E3/E10 SQL.
   - `workout-plan.transformer.js`: pure, with block statuses.
   - `workout-plan.loader.js`: `buildReferences` reused, `gateByClient`, replay, `applyWorkoutPlans` create-only.
   - `migrate-workout-plans.js`: dry run by default.
4. **Dry run on dev** against `staging-ggf`. Review the run report, the exception list and the replay (0 mismatches).
5. **Re-measure on the real source** (an explicit production-read decision under `MIGRATION_ALLOW_PRODUCTION`, read-only). Re-run the dry run against a full-user target.
6. **Apply.** Verify counts and replay again. Keep the run report and the rollback filter (`migration.runId`).
7. **Switch the app.**
   - Coach endpoints under `/api/coach/enrollments/:id/workout-plans`, with ownership enforced as in diet plans.
   - A member day endpoint using `findForDay` semantics.
   - Then retire the legacy endpoints.
