# Legacy FoodList count — independent verification

Read-only investigation. Nothing was modified: no legacy source, no staging row, no
image, no config, no migration file. Every number below was re-derived this session
from the legacy source files and from read-only `SELECT`/`COUNT` queries against
staging. `docs/foods-legacy.md` was treated as a hypothesis only, not as evidence.

## 1. The answer

The same query was run against both databases on the same server. The screen that was
observed was reading **production**.

| Question | staging-ggf | gogetfit (production) |
| --- | --- | --- |
| Rows `GET /Food/GetFoodList` returns | **972** | **1382** |
| Pages at `paginationSize: 10` | 98 (97 full + 2) | **139 (138 full + 2)** |
| Rows per page | 10 | 10 |
| Rows visible without scrolling in the grid | ~5 | ~5 |
| `m_food` total | 983 | 1393 |

**`1382 = 138 × 10 + 2`.** The observation of "138 pages and 2 left over" was correct;
only the page size was wrong (10, not 5). `138 × 5 + 2 = 692` is therefore an
arithmetic artefact, not a count that exists anywhere in either database.

`692` is not produced by any layer against either database. The verified figures are
**972 from staging** and **1382 from production**.

## 2. The chain, traced end to end

1. Sidebar — `Views/Shared/_Layout.cshtml:260` → `<a href="/food/FoodList">`, labelled
   "Food Log".
2. Action — `Controllers/FoodController.cs:52` `FoodList()` → `return View();`, no model,
   no data.
3. View — `Views/Food/FoodList.cshtml:17-19`, one `$.ajax` `GET '/Food/GetFoodList'`.
4. Action — `FoodController.cs:46` `GetFoodList()` → `Json(objService.GetFoodList())`.
5. Service — `GGF.Service/FoodService.cs:65` → `objDAL.GetFoodList()`, returns the
   `DataTable` untouched. No filtering, no mapping, no paging.
6. DAL — `GGF.DAL/FoodDAL.cs:155-176`. The exact SQL, as the string concatenation builds it:

   ```sql
   select a.food_id, a.food_name, a.food_type, a.brand_name, a.unit, a.qty, a.comments ,
          b.calories, b.fat, b.carbs, b.protein , a.image_file_name
   from m_food a
   inner join r_food_energy b on a.food_id = b.food_id
   order by a.food_id desc
   ```

   No `WHERE`, no `LIMIT`, no `OFFSET`, no `DISTINCT`, no `GROUP BY`, and **no
   `delete_flg` filter**. `MySqlDataAdapter.Fill` materialises every row.
7. Serialisation — `Startup.cs:36` `services.AddMvc().AddNewtonsoftJson()`. Newtonsoft
   serialises a `DataTable` as a flat JSON array of row objects, keys = the column
   aliases in the SQL, which is why the Tabulator `field` names are lowercase
   (`food_id`, `image_file_name`). One JSON element per SQL row: **972**.
8. Client — `FoodList.cshtml:23-28`: `data: result` is handed to Tabulator verbatim.
   Grepped the whole view for `slice`, `splice`, `filter`, `unique`, `setFilter`,
   `setData`, `replaceData` — **zero matches**. Nothing trims the array.
9. Grid — `pagination: "local"`, `paginationSize: 10`, `height: 500`, virtual DOM.
   All 972 rows live in the client; 10 are rendered per page.

## 3. Reconciliation table

| # | Layer | Count | How verified |
| --- | --- | --- | --- |
| 1 | `m_food` rows | 983 | `COUNT(*)` |
| 2 | `r_food_energy` rows | 976 | `COUNT(*)` |
| 3 | **SQL result set (exact DAL query)** | **972** | `COUNT(*)` over the identical join |
| 4 | Distinct `food_id` in that result | 972 | `COUNT(DISTINCT a.food_id)` — join is strictly 1:1 |
| 5 | `r_food_energy` ids with >1 row | 0 | no join inflation is possible |
| 6 | `DataTable` rows after `Fill` | 972 | no filter exists between SQL and `Fill` |
| 7 | JSON array elements | 972 | Newtonsoft `DataTable` → one object per row |
| 8 | Array Tabulator receives | 972 | `data: result`, no mutation in the view |
| 9 | Rows Tabulator pages through | 972 | local pagination holds the whole array |
| 10 | Pages × size | 98 × 10, last page 2 | 97×10 + 2 = 972 |
| 11 | Rows on screen at once | 10 | `paginationSize: 10` |

## 4. Why 983 → 972: the 11 excluded foods

The `INNER JOIN` is the only filter in the query. 11 `m_food` rows have no
`r_food_energy` row and are therefore invisible on the screen:

```
food_id 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12
```

All 11 have `delete_flg = 0` — they are **live** foods, silently hidden because their
energy row is missing. (`food_id 9` does not exist; the id range is 1–987 with gaps.)

Separately, 4 `r_food_energy` rows are orphans with no `m_food` parent — `food_id`
115, 146, 147, 282 — which is why `r_food_energy` (976) is not simply a subset of
`m_food`. 976 − 4 = 972. Both exclusions are consistent: 983 − 11 = 972 = 976 − 4.

The inverse defect also holds: because the query has no `delete_flg` filter, the
**11 soft-deleted foods are displayed**, ids 977–987. They sort first under
`order by a.food_id desc`, so the very first page of the grid is entirely
soft-deleted records — `987 carbs`, `986 Lemon Tea`, `985 Black Coffee`, … Net:
961 live + 11 deleted = 972.

## 5. The "138 pages × 5 + 2 = 692" observation

Not reproducible, and the premise does not hold against the source:

- `paginationSize` is **10**, not 5. Verified in the view (`FoodList.cshtml:28`) and
  across the whole legacy admin: all 26 `paginationSize` occurrences in
  `Old GGF/ggf/admin` are `10`. There is no page size of 5 anywhere.
- At 972 rows and 10 per page the grid has **98** pages, not 138. At 5 per page it
  would be 195. Neither is 138.
- The "+ 2" is real and does reconcile: 972 = 97×10 + 2, so the last page genuinely
  holds exactly 2 rows. That remainder of 2 is the one part of the observation the
  data confirms.

Tested whether 692 corresponds to anything in staging. Every candidate was wrong:

| Candidate | Count |
| --- | --- |
| Join + `delete_flg = 0` | 961 |
| Join with an image | 967 · without 5 |
| Join with `calories > 0` | 967 |
| Distinct `food_name` | 786 |
| Distinct (`food_name`, `brand_name`) | 831 |
| Join with `food_type = 'Veg.'` | 822 |
| Join with non-empty `brand_name` | 500 |
| Join with non-empty `comments` | 494 |
| `food_id <= 692` | 677 |
| `m_food_request` | 107 |
| Distinct foods in `t_food_log` | 740 |
| Cumulative by `create_date` | crosses from 681 (2023-11-02) to 695 (2023-11-11) — never 692 |

No filter, no snapshot date, and no neighbouring table yields 692.

## 6. Which database the portal is configured against

`GGF.DAL/FoodDAL.cs:13` hardcodes the connection string in the DAL, not in config:
host `103.76.228.78`, port 3306, database **`staging-ggf`**. 18 of the 19 connection
strings in `GGF.DAL` point at `staging-ggf`.

My queries ran against that same server and database — confirmed from inside the
session with `select database(), @@hostname, version()`:
`staging-ggf` on `103-76-228-78`, MariaDB 10.11.18. No other schema was queried.

Two configuration facts worth recording:

- `GGF.DAL/BannerDAL.cs:15` is the one exception: same host, database **`gogetfit`**.
  Only the banner screen reads it. It was **not** queried here.
- `appsettings.json` carries `ConnectionStrings:Default` pointing at
  `localhost/ggfadmin`. Nothing in the food path reads it — the DAL never consults
  configuration — so it is a dead leftover, not the portal's real target.

## 7. Confirmed facts

- The screen calls exactly one endpoint, `GET /Food/GetFoodList`, once, on document ready.
- That endpoint runs one SQL statement with no `WHERE`, `LIMIT` or `DISTINCT`.
- Against staging that statement returns **972** rows, and the join is 1:1 (no duplicate
  `r_food_energy.food_id`, no NULL `food_id` in either table).
- No code between the SQL and Tabulator removes, dedupes or truncates rows.
- `paginationSize` is 10, pagination is client-side, so the browser holds all 972.
- 11 live foods are hidden by the inner join; 11 soft-deleted foods are shown.
- The configured database for food is `staging-ggf` on 103.76.228.78.

## 8. Inferences

- The response is ~972 JSON objects of ~11 small fields, so nothing in ASP.NET Core's
  default limits would truncate it; no truncation mechanism was found in the code.
- A page holds 10 rows, but only about 5 of them are **visible without scrolling**.
  `height: 500` is a fixed CSS height on the grid and the `formatter: "image"` column
  forces a row height of roughly 83px (75px image plus padding), so the scrollable body
  (~400px after header and footer) shows ~4.8 rows. Rows 6-10 of each page sit below the
  fold inside the grid's own scroll area. This is why the screen reads as "5 per page"
  even though pagination steps 10 at a time.
- `Download XLSX` calls `table.download(...)` on the full dataset, so the export should
  contain all 972 rows — including the 11 soft-deleted ones.
- Most plausible explanations for 692, none of which the repository can settle:
  a header filter was active (`food_name`, `brand_name`, `unit` and `comments` all have
  `headerFilter: true`, and a filtered Tabulator repaginates); the deployed build points
  at a different database than the source does; or the observation came from a different
  screen or an older snapshot.

## 9. Unknown / not verified

- **Confirmed afterwards from a user screenshot** (not from a request made here): the
  deployed admin at `apiimages.gogetfitonline.com/food/FoodList` shows page 1 starting at
  `Pista Peanut Butter Chikki`, `Paneer Cubes`, `High Protein Paneer` - production
  `food_id` 1397, 1396, 1395. Staging's first page would start at `987 carbs`. The
  deployed portal therefore reads **`gogetfit` (production)**, and the applicable figure
  is **1382**. The same screenshot shows ~5 rows on screen, which the `height: 500`
  viewport explains (see section 8): the grid has its own scrollbar, so rows 6-10 of each
  page sit below the fold and are reached by scrolling inside the grid, not by paging.
- **The deployed instance was not contacted by me.** No HTTP request was made to any legacy
  admin host and no browser was driven, so the live `/Food/GetFoodList` response body was
  not captured. The 972 is the verified output of the deployed code's exact query against
  the database that code names. No browser result is being reported, because none was run.
- The deployed binaries could not be inspected: every `bin/` directory in
  `Old GGF/ggf/admin` is empty, and `Old GGF` is not a git repository, so there is no
  history and no compiled artifact to compare the source against.
- `gogetfit-admin/wwwroot` is absent from this copy, so the deployed Tabulator version
  (and therefore its exact footer/page-count rendering) could not be read.
- Whether a header filter was active when 692 was observed.
- The row count in the `gogetfit` database, deliberately: it was not queried.

## 10. Other FoodList implementations

Searched the whole legacy tree. One admin implementation only:

- `Views/Food/FoodList.cshtml` is the single copy of the view anywhere under
  `GoGetFit project`.
- `Views/Food/Food_Log.cshtml` exists but is a static hand-written `<table>` with no
  AJAX and no Tabulator — a dead view, not a second grid.
- `api/ggf.Data/FoodDAL.cs` is the mobile app's path, not this screen's. It pages with
  `LIMIT 15 OFFSET (PageNumber-1)*15` and filters, so it can never produce the admin
  figure.

## 11. Production (`gogetfit`) — same query, read-only

Run at the user's explicit request, read-only `SELECT`/`COUNT` only. Nothing was
written. Connection verified from inside the session: database `gogetfit`, host
`103-76-228-78`, MariaDB 10.11.18 — the same server as staging, a different schema.
Credentials were taken from `GGF.DAL/BannerDAL.cs:15`, the only place in the legacy
source that names the production schema.

| Layer | staging-ggf | gogetfit |
| --- | --- | --- |
| `m_food` | 983 | **1393** |
| `r_food_energy` | 976 | **1386** |
| **Exact DAL join** | **972** | **1382** |
| Distinct `food_id` in join | 972 | 1382 (1:1, 0 duplicate energy rows) |
| `m_food` with no energy row | 11 | **11 — identical ids** `1-8,10,11,12` |
| Orphan energy rows | 4 | **4 — identical ids** `115,146,147,282` |
| `food_id` range | 1–987 | 1–1397 |
| Newest `create_date` | 2025-10-21 | **2026-09-26** |
| Pages × 10, last page | 98, last 2 | **139, last 2** |

1393 − 11 = 1382 = 1386 − 4. Both exclusion sets reconcile exactly as they do on
staging, and they are the *same rows* — staging is an older fork of production, frozen
around 2025-10-21, while production has kept growing (171 foods added in 2024, 157 in
2025, 191 in 2026 so far).

### Schema difference: production `m_food` has no `delete_flg`

Production `m_food` columns end at `last_update_by`; **`delete_flg` does not exist
there**. It exists only on staging, which is where the 11 soft-deleted rows (977–987)
live. Consequences:

- On production there is no soft delete at all, so all 1382 displayed rows are live.
  The staging-only oddity of "page 1 is entirely deleted records" does not occur on
  production, where page 1 starts at `1397 Pista Peanut Butter Chikki`.
- No food query in either legacy app references `m_food.delete_flg` — checked
  `admin/GGF.DAL/FoodDAL.cs` and `api/ggf.Data/FoodDAL.cs`, zero matches — so the
  admin food screen runs unchanged against either database. The hardcoded
  `staging-ggf` in the source does not prevent a deployed build from reading
  production, and the page-count evidence says the observed instance was doing exactly
  that.
- For migration planning this matters: a `deletedAt` mapped from `delete_flg` has a
  source column on staging and **no source column on production**.

None of the 692 candidates match production either: distinct `food_name` 1071, rows
with an image 1378, `food_type = 'Veg.'` 1211, `calories > 0` 1377. And
`food_id <= 987` on production returns exactly **972** — the same set staging holds,
confirming the fork point rather than any filter.

## 12. Verdict

**Production (what was observed): the API returns 1382 rows; the UI pages through the
same 1382, 10 per page, 139 pages, 2 on the last page.**

**Staging: 972 rows, 98 pages, 2 on the last page.**

`692` exists in neither. It comes from multiplying the observed 138 full pages by 5
instead of the actual `paginationSize: 10`: `138 × 10 + 2 = 1382`, exactly the
production join count. No header filter and no truncation is involved — the page count
was read correctly all along.

For migration planning the real numbers are production `m_food` = **1393**, of which
the legacy admin screen can show **1382**; the 11 it can never show are
`food_id 1-8, 10, 11, 12`, live foods with no `r_food_energy` row. Staging is a stale
fork (983 / 972) and must not be used as the migration source.
