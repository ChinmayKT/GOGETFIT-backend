# GoGetFit Legacy Food Database — Reverse Engineering Report

Discovery only. Nothing was implemented, migrated or modified; the legacy
database was read with SELECT/SHOW statements through the project's read-only
query layer.

---

## 1. Executive summary

The legacy Food Database is **two tables, not one**: `m_food` holds identity,
classification and the image filename; `r_food_energy` holds the four nutrition
figures keyed by `food_id`. Every legacy read **inner-joins** them, so a food
without an energy row is invisible everywhere.

Seven findings that matter for the new implementation:

1. **Nutrition is stored twice.** `m_food` *also* has `calories/fat/carbs/protein`
   (int) alongside `r_food_energy` (float 8,4). Create writes only
   `r_food_energy`; Edit writes **both**. 471 of 983 foods have values in both,
   and one row already disagrees.
2. **Delete does nothing.** `FoodController.DeleteFood` returns `Json(1)` without
   touching the database. `m_food.delete_flg` exists (11 rows are `1`) but **no
   query filters it**, so "deleted" foods appear in the admin list, the app list
   and search.
3. **Edit silently destroys the image.** The controller sets
   `obj.ImageFileName = newFileName` unconditionally, and the form has no hidden
   field for the existing filename — so saving an edit without choosing a new
   file writes `image_file_name = 'NULL'` (the literal string, from C# null
   interpolation).
4. **No food image exists in this repository.** Images are written to the admin
   project's `wwwroot/Images`, and that directory is not in source control. The
   983 filenames in the database point at files that live only on the deployed
   admin host.
5. **Create and Edit resize differently.** Create runs ImageMagick (300×300,
   quality 70); Edit writes the uploaded bytes straight through, unresized.
6. **`r_plan_meal.food_id` is not a food reference** — confirmed again here. 737
   of 12,139 values coincidentally collide with an `m_food.food_id`; the Free
   Diet Plan templates store food *names*, not references.
7. **Nutrition is per `qty` of `unit`**, not per 100g by convention: 710 foods are
   `qty=100`, 238 are `qty=1`. Clients snapshot their own figures.

Volumes: **983 foods**, 976 energy rows, 970 with an image filename, 137
duplicated names, 1,553 favourites, 29,748 food-log rows, 1,173 diet-plan food
rows.

---

## 2. Legacy FoodList architecture

Route `/Food/FoodList` → the full chain, every file verified:

| Layer | File | What it does |
|---|---|---|
| View (list) | `admin/gogetfit-admin/Views/Food/FoodList.cshtml` | Tabulator grid, AJAX `GET /Food/GetFoodList`, client-side paging at 10 |
| View (create) | `admin/gogetfit-admin/Views/Food/Add_Food.cshtml` | multipart form → `POST /Food/CreateFood` |
| View (edit) | `admin/gogetfit-admin/Views/Food/EditFood.cshtml` | multipart form → `POST /Food/UpdateFood` |
| Controller | `admin/gogetfit-admin/Controllers/FoodController.cs` | `FoodList`, `GetFoodList`, `Add_Food`, `CreateFood`, `EditFood`, `UpdateFood`, `DeleteFood`, `Food_Log` |
| View model | `admin/gogetfit-admin/Models/FoodModel.cs` → AutoMapper → `admin/GGF.Model/FoodModel.cs` | 11 properties: FoodId, FoodName, FoodType, BrandName, Unit, Qty, Comments, Calories, Fat, Carbs, Protein, UserId, ImageFileName |
| Service | `admin/GGF.Service/FoodService.cs` | `IsFoodAdded` (m_food then r_food_energy), `IsFoodUpdated` (both), `GetFoodList`, `GetFoodRecord`, `GetBrandList` |
| DAL | `admin/GGF.DAL/FoodDAL.cs` | all SQL, string-concatenated, hardcoded connection string to `staging-ggf` |
| Tables | `m_food`, `r_food_energy` | (+ `m_food_brand`, which **does not exist** in the database) |

App-side (Flutter) chain:

| Layer | File |
|---|---|
| Controller | `api/ggfAPI/Controllers/FoodController.cs` |
| Service | `api/ggf.Services/FoodService.cs` |
| DAL | `api/ggf.Data/FoodDAL.cs` |
| Models | `api/ggf.Model/FoodModel.cs`, `FoodSearchModel.cs`, `FoodLog*.cs`, `MealFood.cs`, `DietMealFoodModel.cs` |

Related module (separate screen, same domain): `FoodRequestController.cs`,
`FoodRequestDAL.cs`, `Views/FoodRequest/RequestFood.cshtml`, table
`m_food_request` (107 rows) — members request a food, an admin adds it.

---

## 3. Database tables

### 3.1 `m_food` — 983 rows

| Column | Type | Null | Default | Example | Meaning | Written by | Read by |
|---|---|---|---|---|---|---|---|
| `food_id` | int(11) PK | NO | — | 986 | Identity. No AUTO_INCREMENT flag reported. | implicit | every read; favourites, logs, diet plans |
| `food_name` | varchar(45) | YES | null | `Lemon Tea` | Display name | Create/Edit | list, search, app |
| `food_type` | varchar(45) | YES | null | `Veg.` | Veg/non-veg classification | Create/Edit (dropdown) | list, app filter |
| `brand_name` | varchar(45) | YES | null | `Amul` | Free-text brand. 472 blank, 126 distinct | Create/Edit | list, search |
| `unit` | varchar(45) | YES | null | `grams` | Portion unit the nutrition refers to | Create/Edit (dropdown) | list, app, food log |
| `qty` | varchar(45) | YES | null | `100` | Portion size the nutrition refers to | Create/Edit | list, app |
| `comments` | varchar(45) | YES | null | `Boiled` | Free note. 478 blank. **Searched by the app** | Create/Edit | list, app search |
| `calories` | int(11) | YES | null | 69 | **Duplicate** nutrition. Set by Edit only (471 rows) | Edit only | nothing — no read path found |
| `fat` | int(11) | YES | null | 1 | ditto | Edit only | nothing |
| `carbs` | int(11) | YES | null | 12 | ditto | Edit only | nothing |
| `protein` | int(11) | YES | null | 2 | ditto | Edit only | nothing |
| `image_file_name` | varchar(100) | YES | null | `066c1d23-…-….png` | GUID filename, no path | Create/Edit | admin grid, edit form, app |
| `create_date` | datetime | YES | null | 2021-11-27 14:40:42 | Insert timestamp | Create | nothing |
| `created_by` | varchar(45) | YES | null | `123` | **Hardcoded literal `123`** in the SQL | Create | nothing |
| `last_update_date` | datetime | YES | null | — | Updated on edit | Create/Edit | nothing |
| `last_update_by` | varchar(45) | YES | null | `123` | Hardcoded on insert, **not written on update** | Create | nothing |
| `delete_flg` | tinyint(1) | NO | 0 | 1 | Soft-delete flag — **never written and never read by any code** | nothing | nothing |

Indexes: `PRIMARY(food_id)` only. **No unique constraint on name or
name+brand**, no index on `food_name` despite every search using `LIKE '%…%'`.

### 3.2 `r_food_energy` — 976 rows

| Column | Type | Null | Meaning | Written by | Read by |
|---|---|---|---|---|---|
| `food_id` | int(11) PK | NO | 1:1 with `m_food` | Create (`select max(food_id)`) | all list/detail reads |
| `calories` | float(8,4) | YES | Calories per `m_food.qty` `unit` | Create + Edit | admin list/detail, app list/search |
| `fat` | float(8,4) | YES | grams | Create + Edit | ditto |
| `carbs` | float(8,4) | YES | grams | Create + Edit | ditto |
| `protein` | float(8,4) | YES | grams | Create + Edit | ditto |
| `create_date`, `created_by`, `last_update_date`, `last_update_by` | datetime/varchar | YES | Audit; `created_by`/`last_update_by` hardcoded `123` | Create/Edit | nothing |

Indexes: `PRIMARY(food_id)` only. **Not a declared foreign key** — 4 orphan rows
exist (`food_id` 115, 146, 147, 282) whose `m_food` rows are gone.

### 3.3 Related tables

| Table | Rows | Role |
|---|---|---|
| `r_user_food_favorite` | 1,553 | `(user_id, food_id)` PK. Member favourites |
| `t_food_log` | 29,748 | What a member ate: PK `(user_id, meal_id, food_id, log_date)`, plus `quantity` and **snapshotted** `calorie/fat/carbs/protein`, `delete_flg` |
| `r_diet_plan_meal` | 1,173 | Coach diet plans: `(diet_plan_id, meal_id, food_id)`, `quantity` and **snapshotted** `calories/fats/carbs/proteins` |
| `m_food_request` | 107 | Member food requests, with `food_status`, `message_status`, `delete_flg` |
| `m_food_brand` | — | **Does not exist.** `FoodDAL.GetBrandList()` would throw; the brand dropdown is commented out in the view |

### 3.4 Tables that do **not** exist

No food category table, no meal-type table, no unit/serving table, no nutrient
table, no alias, ingredient, substitution or food-image table, no per-user
food table, no deleted-food archive. Categories and units are **hardcoded in the
Razor views**.

---

## 4. The canonical legacy Food object

Reconstructed from `GetFoodRecord` (the exact 12 columns the admin reads). Real
values from food_id 986:

```json
{
  "food_id": 986,
  "food_name": "Lemon Tea",
  "food_type": "Veg.",
  "brand_name": "",
  "unit": "grams",
  "qty": "100",
  "comments": "",
  "calories": 69.0,
  "fat": 1.0,
  "carbs": 12.5,
  "protein": 2.5,
  "image_file_name": "066c1d23-1589-4e4b-97a2-515c589933b5.png"
}
```

| Field | Origin | Admin enters? | Calculated? | From another table? | Optional | Consumed by |
|---|---|---|---|---|---|---|
| food_id | `m_food` PK | no | no | — | no | edit link, all references |
| food_name | form text | yes | no | — | not enforced | list, search |
| food_type | form dropdown | yes | no | — | not enforced | list, app type filter |
| brand_name | form text | yes | no | — | yes (472 blank) | list, app search |
| unit | form dropdown | yes | no | — | not enforced | list, app, log |
| qty | form text | yes | no | — | not enforced | list, app |
| comments | form text | yes | no | — | yes (478 blank) | list, app search |
| calories/fat/carbs/protein | form text | yes | **no** | `r_food_energy` | not enforced | list, detail, app |
| image_file_name | file upload | yes (file) | filename generated | — | yes (13 blank) | grid thumbnail, edit preview, app |
| create_date / created_by / last_update_* | SQL literals | no | no | — | — | nothing reads them |
| delete_flg | DB default | no | no | — | — | nothing |

Not present anywhere: fibre, sugar, sodium, cholesterol, category, meal type,
serving size other than `qty`+`unit`, status, tags, barcode, source.

---

## 5. Create flow

`Add_Food.cshtml` → `POST /Food/CreateFood` (multipart) → `FoodController.CreateFood`.

1. **Fields entered:** Food Name, Food Type, Portion (unit), Qty, Brand,
   Comments, Total Calories, Fat, Carbs, Protein, Food Picture.
2. **Mandatory:** none. No `[Required]` attribute on any model property, no
   client-side validation, `ModelState.IsValid` is always true for this model. A
   completely empty food can be created.
3. **Optional:** all of them.
4. **Dropdowns:** both hardcoded in the view (see §9).
5. **Validation:** only the image extension — `.jpg`, `.jpeg`, `.png`
   (case-insensitive). No size limit, no MIME sniffing. Rejection re-renders the
   form with `ViewBag.FileInvalid = "only jpg and png format is allowed"`.
6. **Nutrition calculation:** none. Values are stored exactly as typed.
7-8. **Image:** GUID filename + original extension → saved to
   `wwwroot/tempimage/{guid}{ext}` → ImageMagick `Resize(300,300)`,
   `Quality = 70`, same format → written to `wwwroot/Images/{guid}{ext}` → temp
   file deleted.
9. **Inserts, in order:**
   - `INSERT INTO m_food (Food_Name, Food_Type, Brand_Name, Unit, Qty, Comments, Image_File_Name, Create_date, Created_by, last_update_date, Last_update_by)` — nutrition columns are **commented out**; `Created_by`/`Last_update_by` are the literal `123`.
   - `INSERT INTO r_food_energy (food_id, Calories, Fat, Carbs, Protein, …) VALUES ((select max(food_id) from m_food), …)` — a race condition under concurrent inserts.
   - Energy insert runs only if the first insert succeeded; its own failure is **ignored** (`IsFoodAdded` returns true regardless). This is the likely cause of the 11 foods with no energy row.
10. **Image reference:** bare filename, no path, no URL.
11. **Response:** re-renders `Add_Food` with `ViewBag.Status = "Success"`/`"Failure"`.
12. **Appearing in the list:** the grid re-fetches `GetFoodList`, ordered
    `food_id desc`, so a new food appears first — but only if its energy row was
    written, because of the inner join.

Hidden/default values inserted by the backend: `created_by=123`,
`last_update_by=123`, both timestamps, `delete_flg=0` (column default).
Transformations: `'` → `\'` in name/brand/comments (hand-rolled escaping);
image filename replaced by a GUID.

---

## 6. Edit flow

`EditFood?foodId=` → `GetFoodRecord` (inner join) → AutoMapper → `EditFood.cshtml`
→ `POST /Food/UpdateFood`.

- **Loaded fields:** the 12 columns above. Nutrition comes from
  `r_food_energy`, never from `m_food`'s own columns.
- **Editable:** everything except `food_id` (hidden field).
- **Read-only:** `food_id`; audit columns are not on the form.
- **Image replacement:** yes. The current image is shown as
  `<img src="~/Images/@Model.ImageFileName">`.
- **Old image file:** never deleted. The delete code is commented out in the
  controller. Replaced files accumulate forever.
- **Resize on edit:** **no** — unlike create, the uploaded file is written
  straight to `wwwroot/Images` at full size and quality.
- **Nutrition recalculated:** no.
- **Partial vs full:** full replacement of all editable columns.
- **The image bug:** `newFileName` is null when no file is chosen, and
  `obj.ImageFileName = newFileName` runs unconditionally, so the SQL becomes
  `image_file_name = 'NULL'` — a four-character string, not SQL NULL. Any edit
  that does not re-upload the picture loses it. (Today's data shows 0 literal
  `'NULL'` values, so either this path is rarely used or such rows were cleaned
  up — worth confirming before migrating.)
- **Updates:** `UPDATE m_food SET food_name, food_type, brand_name, unit, qty,
  comments, calories, fat, carbs, protein, image_file_name, last_update_date`
  then `UPDATE r_food_energy SET calories, fat, carbs, protein,
  last_update_date`. So edit is the only writer of `m_food`'s nutrition columns.
- **Audit:** `last_update_date` is set; `last_update_by` is **not** updated.
- **Response:** renders `FoodList` with `ViewBag.Status`, and the grid then
  re-fetches.

---

## 7. Delete / status flow

Traced completely. `FoodList.cshtml` has a `#BtnDelete` handler that sends the
selected rows to `GET /Food/DeleteFood`, and the action is:

```csharp
public IActionResult DeleteFood(List<DeleteModel> deleteItems)
{
    return Json(1);
}
```

**It does nothing.** No row is deleted, no flag is set, and the UI receives
success. There is no physical delete, no archive, no status change and no
usage check anywhere in the food module.

`m_food.delete_flg` is a real column with 11 rows set to `1` (food_id 977–987,
all created recently), but **no SQL in either project references it** — not the
admin list, not the API list, not search, not the food log. Those 11 foods are
fully visible to admins and members. Something outside this codebase set the
flag (direct SQL, most likely).

Consequences for history: nothing prevents deletion because nothing deletes.
Diet plans and food logs snapshot their own nutrition (§13), so they would
survive a food disappearing — but they would lose the join that supplies the
food *name* and *image*.

---

## 8. Search / list flow

**Admin list** (`GET /Food/GetFoodList`):

- SQL: the 12 columns, `m_food INNER JOIN r_food_energy`, `ORDER BY a.food_id DESC`.
- **Everything is server-fetched once and filtered in the browser** by Tabulator:
  `pagination: "local"`, `paginationSize: 10`, `headerFilter: true` on Food Name,
  Brand Name, Unit and Comments. All 976 joined rows cross the wire on every load.
- No total count, no server paging, no server search, no category filter, no
  status filter, no empty state. Deleted (`delete_flg=1`) foods are included.
- Sorters are declared as `sorter: "date"` on numeric and text columns — a
  copy-paste defect that makes client-side sorting on Unit, Qty, Comments,
  Calories, Fat, Carbs and Protein meaningless.
- An "export xlsx" button downloads the loaded rows.

**App list** (`GET /api/Food/{foodType?}/{foodName?}`): same join, `food_type`
filtered to exactly `'Veg.'`, `'NonVeg'`, or both; name matched with
`LOWER(food_name) LIKE '%…%'`. No paging.

**App search** (`POST /api/FetchFoodList`): same join plus

- term matched case-insensitively against `food_name` **or** `brand_name` **or**
  `comments`
- optional `INNER JOIN r_user_food_favorite` when `FavFlag` is set
- a correlated `IF(EXISTS(...))` subquery returning `FavoriteFlag` `'1'`/`'0'`
- `ORDER BY a.food_id DESC LIMIT 15 OFFSET (PageNumber-1)*15` — the only paged
  endpoint in the module, page size hardcoded to 15
- no total count is returned, so the client cannot know how many pages exist

Case sensitivity: search is explicitly lower-cased on both sides. Matching is
always partial (`%term%`). `food_type` comparison is **exact and
case-sensitive**, which is why the single `food_type = 'Veg'` row (food_id 281,
"Egg Roll") is invisible in the app — it matches neither branch.

---

## 9. Categories / types / units

Every dropdown is **hardcoded in the Razor view**. There is no reference table
and an admin cannot add an option.

**Food Type** — `Add_Food.cshtml:59-63`, `EditFood.cshtml:53-54`:

| ID | Stored value | Display label | Source |
|---|---|---|---|
| — | `Veg.` | Vegetarian | hardcoded `<option value="Veg.">` |
| — | `NonVeg` | Non-Vegetarian | hardcoded `<option value="NonVeg">` |

Actual stored data: `Veg.` 831, `NonVeg` 151, **`Veg` 1** (food_id 281 — not
producible by the form, and invisible to the app).

Note: this vocabulary is **not** the Free Diet Plan one (`Veg.`, `Veg/Egg`,
`Veg/NonVeg`). Foods have no egg category at all.

**Portion / Unit** — `Add_Food.cshtml:72-83`, `EditFood.cshtml:66-75`. No
`value` attributes, so the stored value is the label text:

| Stored / displayed | Rows in data |
|---|---|
| `Bowl` | 10 |
| `Cup` | 5 |
| `Glass` | 0 |
| `Grams` | 0 — but **`grams`** (lowercase) 680 |
| `ML` | 0 — but **`ml`** (lowercase) 56 |
| `Piece` | 127 |
| `Scoop` | 25 |
| `Serving` | 74 |
| `Slice` | 2 |
| `Spoon` | 4 |

So the two commonest stored values (`grams`, `ml`) **cannot be produced by
today's form** — they predate it or were written directly. Unit comparison is
never done in SQL, so the mismatch is invisible to the app but will matter to any
normalisation.

**Brand:** a free-text box (126 distinct values, 472 blank). A DB-driven
dropdown exists in commented-out code and points at the non-existent
`m_food_brand`.

**Not present:** no category, no meal type, no food-preference and no
serving-size vocabulary beyond `qty` + `unit`.

---

## 10. Nutrition logic

Only four figures exist anywhere: **calories, fat, carbs, protein**. No fibre,
sugar, sodium, cholesterol or micronutrients in any table or model.

1. **Manually entered** by the admin, as free text.
2. **Never calculated** in the food module — no formula, no derivation.
3-6. Stored **per `qty` of `unit`** as entered. Not normalised to 100 g: 710
   foods use `qty=100`, 238 use `qty=1`, the rest 2–250. Nothing records whether
   a figure is per-100g or per-piece beyond those two columns.
7. **No serving conversion** exists server-side. `t_food_log` and
   `r_diet_plan_meal` store a `quantity` plus their own nutrition numbers, and
   the insert takes those numbers **straight from the client payload** — the
   scaling happens on the device, not in the API:

   ```sql
   INSERT INTO t_food_log (…, quantity, calorie, fat, carbs, protein, …)
   VALUES (…, '" + objModel.Quantity + "', '" + objModel.Calorie + "', …)
   ```

8. **Decimals:** preserved in `r_food_energy` (`float(8,4)`) and in the log and
   plan tables. **Truncated** in `m_food`'s duplicate int columns — the one
   divergent row is exactly this.
9. **Rounding:** none in SQL or C#. The grid prints whatever the join returns.
10. The app does its own arithmetic for a logged quantity; the server stores the
    result.

**The duplication problem, precisely:** create fills `r_food_energy` only; edit
fills both; reads use `r_food_energy` only. 471 foods have both sets, 1 pair
already disagrees, and the `m_food` copy has no reader.

---

## 11. Image storage architecture

```
admin chooses file (Add_Food / EditFood, enctype=multipart/form-data, name="file")
      ↓
FoodController.CreateFood / UpdateFood
      ↓  extension check: .jpg | .jpeg | .png (lower-cased), nothing else
      ↓  filename = Guid.NewGuid() + original extension
CREATE: wwwroot/tempimage/{guid}{ext}
      ↓  MagickImage: Resize(300,300), Quality = 70, format unchanged
        wwwroot/Images/{guid}{ext}   (temp file deleted)
EDIT:   wwwroot/Images/{guid}{ext}   (written directly, NO resize, NO compression)
      ↓
m_food.image_file_name = "{guid}{ext}"        ← filename only, no path, no URL
      ↓
admin grid:  Tabulator image formatter, urlPrefix "/images/", 75×75 px
admin edit:  <img width="50" height="50" src="~/Images/@Model.ImageFileName">
app/API:     the raw filename is returned in every food row; the client prefixes
             its own base URL
```

Answers to the specific questions:

1. **Local filesystem** of the admin web application — `wwwroot/Images`. Not a
   blob, not a CDN, not cloud storage, no external URL.
2. Exact path: `{admin app working directory}/wwwroot/Images/`, resolved at
   runtime via `new PhysicalFileProvider(Path.Combine(Directory.GetCurrentDirectory(), "wwwroot", "Images")).Root`. Staging area: `wwwroot/tempimage/`.
3-4. Filename = **`Guid.NewGuid()` + the original extension**. Not the food id,
   not the name, not a timestamp, not the original filename.
5. The database stores the **bare filename**; the path and host are implicit.
6. Upload code: `FoodController.cs:146-231` (create), `:67-145` (update).
7. Display code: `FoodList.cshtml:34-43` (grid, `/images/` prefix) and
   `EditFood.cshtml:161` (`~/Images/`). Note the **case difference** —
   `/images/` vs `/Images/`; it works on Windows/IIS and would break on a
   case-sensitive filesystem.
8. Resized **only on create** (300×300).
9. Compressed **only on create** (quality 70).
10. Allowed: `.jpg`, `.jpeg`, `.png`. No `.webp`, no `.gif`. Extension only —
    content is never sniffed.
11. **No maximum file size** is enforced anywhere in the module.
12. No thumbnails — the single 300×300 file is used at 75×75 and 50×50.
13. Old images are **never deleted** (the delete block is commented out at
    `FoodController.cs:97-102`).
14. No image: `image_file_name` is `''` or null (13 foods). The grid renders a
    broken 75×75 image; there is no placeholder.
15. Missing file: the same broken image. No existence check anywhere.
16. The API returns the same bare filename, so the app must know the admin host
    and the `/Images/` path. No image endpoint, no absolute URL, no config key
    for an image base URL was found in either project's `appsettings.json`.
17. Searched the whole legacy tree for image directory names, URL patterns,
    filename patterns, upload endpoints and `.jpg`/`.jpeg`/`.png`/`.webp` — the
    results are exactly what is listed above.

---

## 12. Real image examples

**The repository contains no food images.** The admin project has no `wwwroot`
directory at all under source control, so `wwwroot/Images` and
`wwwroot/tempimage` exist only on the deployed host. The only image assets in the
repo belong to the API project:

| Directory | Files |
|---|---|
| `api/ggfAPI/wwwroot/Images/UserUpdates` | 84 |
| `api/ggfAPI/wwwroot/Posts` | 46 |
| `api/ggfAPI/wwwroot/Images/Questionnaire` | 9 |
| `api/ggfAPI/wwwroot/Images` (root) | 0 — only the two subfolders |

Five real database records, to be completed once the live folder is available:

| food_id | food_name | image_file_name | physical file | admin URL | app URL |
|---|---|---|---|---|---|
| 986 | Lemon Tea | `066c1d23-1589-4e4b-97a2-515c589933b5.png` | **not in repo** | `/images/066c…png` | `{host}/Images/066c…png` |
| 985 | Black Coffee | `2e595d28-96bf-48dd-9b05-ad67bf2ebaf6.png` | not in repo | ditto | ditto |
| 984 | Lemon Tea | `ec56a1ce-4b17-44e0-a68b-ad8dce07b44c.png` | not in repo | ditto | ditto |
| 983 | Appam | `918df46b-357f-4ddb-9921-e9a69352ef53.png` | not in repo | ditto | ditto |
| 982 | Fish Curry | `6d0998b2-eb4b-40ed-a96e-b5734b8281dc.png` | not in repo | ditto | ditto |

Extensions across all 983 rows: `.jpg` 462, `.png` 450, `.jpeg` 58, blank 13.
Every non-blank value matches `{guid}.{ext}`; no row contains a path, a URL or a
legacy non-GUID filename. **Database-to-file matching could not be verified.**

---

## 13. Food ↔ diet plan relationships

| Consumer | Table | Reference | Nutrition | Snapshot? |
|---|---|---|---|---|
| Coach diet plans | `r_diet_plan_meal` | `food_id` (int, no FK) | own `calories/fats/carbs/proteins` + `quantity` | **yes** |
| Member food log | `t_food_log` | `food_id` (int, no FK) | own `calorie/fat/carbs/protein` + `quantity` | **yes** |
| Favourites | `r_user_food_favorite` | `food_id` | — | n/a |
| **Free Diet Plan templates** | `r_plan_meal` | **no food reference** | own copied values | n/a — stores `food_name` text |

Verified counts: 1,173 diet-plan food rows across 84 distinct foods; 29,748 log
rows across 740 foods; 1,553 favourites. **Zero orphans** in all three — every
referenced `food_id` exists in `m_food` today, and none points at a
`delete_flg=1` food.

`r_plan_meal.food_id` is that table's own auto-increment primary key, not a food
reference — re-confirmed here: 737 of its 12,139 values happen to collide
numerically with an `m_food.food_id`, which is coincidence, and the Free Diet
Plan reads join nothing (`SELECT food_name, food_type, unit, qty, calories, …
FROM r_plan_meal`).

What happens on change:

- **Rename a food:** diet plans and logs keep their stored numbers but display
  the *new* name, because the name is joined (`t_food_log … inner join m_food`).
  History silently re-labels itself.
- **Edit nutrition:** existing plans and logs keep their snapshots. Only new
  entries pick up the change.
- **Delete a food:** cannot happen through the UI. A direct SQL delete would
  break the joins and make logged entries unreadable (no name, no image), while
  the numbers survive.

---

## 14. Legacy API inventory

| Method | Route | Purpose | Request | Response | Auth | Used by |
|---|---|---|---|---|---|---|
| GET | `/Food/FoodList` | list page | — | HTML | session | admin |
| GET | `/Food/GetFoodList` | all foods (joined) | — | JSON array of the 12 columns | session | admin grid |
| GET | `/Food/Add_Food` | create form | — | HTML | session | admin |
| POST | `/Food/CreateFood` | create | multipart: FoodName, FoodType, Unit, Qty, BrandName, Comments, Calories, Fat, Carbs, Protein, file | HTML + ViewBag.Status | session | admin |
| GET | `/Food/EditFood?foodId=` | edit form | query | HTML | session | admin |
| POST | `/Food/UpdateFood` | update | multipart incl. hidden FoodId | HTML + ViewBag.Status | session | admin |
| GET | `/Food/DeleteFood` | **no-op** | JSON body of selected rows | `1` | session | admin |
| GET | `/Food/Food_Log` | food-log page | — | HTML | session | admin |
| GET | `/api/Food/{foodType?}/{foodName?}` | app list | path params | raw DataTable JSON | **none found** | Flutter |
| POST | `/api/FetchFoodList` | app paged search | `{Foodtype, FoodName, FavFlag, LoginToken, PageNumber}` | `{data, ResponseContext{StatusCode, Message, ResponseTimeStamp}}` | `LoginToken` in body | Flutter |
| GET | `/api/AddFavFood` | favourite | `loginToken`, `foodId` | wrapped | token in query | Flutter |
| GET | `/api/RemoveFavFood` | unfavourite | same | wrapped | token in query | Flutter |
| POST | `/api/AddFood` | **member food request** → `m_food_request`, not `m_food` | `{FoodName, Brand, Description, LoginToken}` | wrapped | token in body | Flutter |
| POST | `/api/AddFoodLog` | log a food | `{LoginToken, MealId, FoodId, Quantity, Calorie, Fat, Carbs, Protein}` | wrapped | token in body | Flutter |
| POST | `/api/RemoveFoodLog` | remove log | same key | wrapped | token in body | Flutter |
| GET | `/api/GetFoodLog` | day's log | `LoginToken`, `LogDate`, `userId` | meals 1..n with foods | token in query | Flutter |

No image endpoint, no dropdown/reference endpoint, no count endpoint. No
`[Authorize]` attribute appears on the food controller — authentication is the
`LoginToken` parameter, interpolated into SQL.

**Security note, since it affects any migration tooling:** every query in both
projects is built by string concatenation with user input, including
`LoginToken`. The whole module is SQL-injectable. Nothing in the new system
should reuse these query strings.

---

## 15. Data counts (staging, read-only)

| Metric | Value |
|---|---|
| Total foods (`m_food`) | **983** |
| `delete_flg = 0` | 972 |
| `delete_flg = 1` (invisible to no one) | 11 — food_id 977–987 |
| Energy rows (`r_food_energy`) | 976 |
| Foods with **no** energy row (invisible everywhere) | **11** — food_id 1–8, 10, 11, 12 |
| Energy rows with no food (orphans) | **4** — food_id 115, 146, 147, 282 |
| Foods visible in the admin list (the inner join) | **972** |
| Foods with `m_food` nutrition also filled | 471 |
| Rows where `m_food` and `r_food_energy` disagree | **1** |
| Foods with an image filename | 970 |
| Foods without an image | 13 |
| Image types | jpg 462, png 450, jpeg 58 |
| Distinct brands | 126 (472 foods blank) |
| Foods with blank comments | 478 |
| `food_type` values | `Veg.` 831, `NonVeg` 151, `Veg` 1 |
| Distinct units | 9 (`Glass` unused; `grams`/`ml` lowercase dominate) |
| Duplicate food names | **137 names**, worst: "Potato Chips" ×9 |
| Categories / food types as tables | 0 — none exist |
| Foods referenced by diet plans | 84 distinct |
| Foods referenced by food logs | 740 distinct |
| Orphaned food references | **0** in all three consumer tables |
| `created_by` distinct | 1 (`123`) |
| Date range | 2021-11-27 → 2025-10-21 |

---

## 16. New `/nutrition/foods` current state

**Backend:** no Food model, no food service, no food routes — nothing. The food
domain does not exist in the new backend yet.

Reusable infrastructure that does exist:

| Thing | Where | Note |
|---|---|---|
| Storage driver behind an interface | `src/services/storage/index.js` (`getStorage`, local driver) | already used by three features |
| Folder helpers | same file: `PROFILE_PICTURE_FOLDER`, `coachImageFolder(id, slot)`, `planImageFolder(id)` | a `foodImageFolder(foodId)` would follow the pattern |
| `image: { url, storageKey }` sub-document | `coach.model.js`, `gogetfit-plan.model.js` | the established convention |
| Image service pattern | `coach-image.service.js`, `gogetfit-plan-image.service.js` | validate bytes → store → atomic `$set` → delete the previous file |
| Byte-level validation | `src/utils/image.js` (`assertValidImage`, sniffs the real type) | with `env.storage.maxUploadBytes` |
| Raw-body upload middleware | `src/middleware/upload.middleware.js` | PUT `/…/image` convention |
| Admin list conventions | `gogetfit-plan.service.js`, `coupon.service.js` | capped pagination, allow-listed sort, allow-listed projection |
| Archive-not-delete convention | `free-diet-plan`, `gogetfit-plan` (`status: active\|archived`) | the project's answer to legacy hard deletes |
| Migration conventions | extractor → transformer → loader → script, dry-run default, `legacy.*` identity, partial unique index | five migrations already follow it |

**Admin Portal:** the screens exist and are **mock-backed**.

- `src/features/nutrition/FoodListPage.tsx` and `FoodFormPage.tsx`, routes
  `nutrition/foods`, `nutrition/foods/new`, `nutrition/foods/:id/edit`
- data from `src/mock/nutrition/foodRepository.ts` (`listFoods`, `getFood`,
  `createFood`, `updateFood`, `deleteFood`, `foodOptions`)
- `src/types/nutrition.ts` → `Food { id, foodName, foodType, brandName, unit,
  qty, comments, calories, fat, carbs, protein, image: string | null, createdAt }`
  — almost exactly the legacy 12 columns
- `FoodType` is currently `"Vegetarian" | "Non-Vegetarian"`, `FoodUnit` is the
  ten capitalised units — neither matches the stored legacy values
- `FoodRequestsPage.tsx` and `FoodLogPage.tsx` also exist, also mock

---

## 17. Legacy → MongoDB mapping proposal

**Recommendation, not a decision.**

| Legacy | New MongoDB | Transformation | Notes |
|---|---|---|---|
| `m_food.food_id` | `legacy.foodId` | as-is | migration identity with `legacy.source`; partial unique index |
| `food_name` | `name` | trim | no unique index — 137 duplicate names exist |
| `food_type` | `foodType` | keep verbatim (`Veg.`/`NonVeg`/`Veg`) | do not normalise during migration; decide the canonical vocabulary separately |
| `brand_name` | `brand` | trim, `''` → null | 472 blank |
| `unit` | `serving.unit` | **keep verbatim** (`grams` ≠ `Grams`) | normalising is a separate, reported step |
| `qty` | `serving.quantity` | varchar → Number | all values numeric today |
| `comments` | `notes` | trim, `''` → null | searched by the app, so keep it indexed |
| `r_food_energy.calories/fat/carbs/protein` | `nutrition.{calories,fat,carbs,protein}` | float, **authoritative** | the only values any legacy read uses |
| `m_food.calories/fat/carbs/protein` | `legacy.nutritionOnFood` | preserve verbatim | the duplicate int copy; keeps the 1 divergence visible instead of silently picking a winner |
| `image_file_name` | `legacy.imageFileName` + `image: {url, storageKey}` | filename preserved; `image` only once the file is actually copied | see §18 |
| `create_date` | `legacy.createdAt` | Date | |
| `created_by`, `last_update_by` | `legacy.createdBy`, `legacy.updatedBy` | verbatim strings (`123`) | not Mongo user ids |
| `last_update_date` | `legacy.updatedAt` | Date | |
| `delete_flg` | `legacy.deleted` + `status` | `1` → `status: 'archived'`, else `'active'` | the project's existing archive convention; the flag becomes meaningful for the first time |
| — | `createdBy` / `updatedBy` (ObjectId) | null for migrated rows | matches the coupon/plan precedent |
| — | `migration: {runId, migratedAt, version}` | per run | |
| no energy row (11 foods) | `nutrition` all null + reported | never invented | they are invisible in legacy; migrating them makes them visible — a decision to confirm |
| orphan energy rows (4) | not migrated, reported | — | no food to attach to |

Suggested indexes: unique partial `legacy.source + legacy.foodId`; `name` text
or prefix index for search; `{status, foodType}`; `{brand}`.

### A. Confirmed facts from legacy code
Two tables with an inner join; four nutrition fields only; nutrition per
`qty`+`unit`; hardcoded dropdowns; GUID image filenames in a local folder; delete
is a no-op; `delete_flg` unused by code; edit writes nutrition to both tables;
create resizes and edit does not; snapshots in logs and diet plans; no FKs; no
category/unit tables; the exact counts in §15.

### B. Existing new-system facts
No food backend. Mock-backed portal screens whose `Food` type already mirrors the
legacy columns. A storage driver, an `image:{url,storageKey}` convention, two
image services, byte-level image validation, capped-pagination list conventions
and an archive-not-delete pattern are all in place and reusable.

### C. Recommended design decisions (to be confirmed)
`r_food_energy` wins for nutrition and the `m_food` copy is preserved as legacy
history; `delete_flg=1` becomes `status: 'archived'`; legacy `food_type` and
`unit` values are migrated verbatim and normalised later as a separate reported
step; the 11 energy-less foods migrate with null nutrition and a conflict report;
images migrate only when the physical file can be found.

### D. Unknowns requiring confirmation
See §20.

---

## 18. Image migration proposal

The blocker is access, not code. The 970 filenames are useless without the
`wwwroot/Images` folder from the live admin host, which is not in this repository.

Proposed sequence:

1. Obtain a copy of the deployed `wwwroot/Images` directory (970 files expected).
2. **Audit before migrating:** for every food, does `{guid}{ext}` exist? Report
   present / missing / extra, and compare dimensions against the 300×300 the
   create path produced (edited foods will be larger, since edit never resized).
3. For each matched file: `assertValidImage` on the real bytes → store through
   the existing driver under a `foods/{foodId}` folder → set
   `image: {url, storageKey}`.
4. Keep `legacy.imageFileName` on every food regardless, so an unmatched image
   can be reconciled later.
5. A food whose file is missing migrates with `image: null` and is reported. No
   placeholder is invented.
6. Idempotent on `legacy.foodId`: re-running must not re-upload or duplicate.
7. The 13 foods with no filename need no work and should not appear as errors.

---

## 19. Migration strategy

Following the pattern the five existing migrations use:

- `migration/extractors/food.extractor.js` — read-only, `m_food LEFT JOIN
  r_food_energy` (a **left** join, so the 11 energy-less foods are visible to the
  migration even though legacy hides them)
- `migration/transformers/food.transformer.js` — values only, nothing invented
- `migration/loaders/food.loader.js` — upsert on `(legacy.source, legacy.foodId)`
- `migration/scripts/migrate-foods.js` — dry run by default, `--apply` to write,
  plus a separate `--images` phase once the files are available
- Reports: foods inspected, created, updated, unchanged; no-energy foods; orphan
  energy rows; nutrition divergences; duplicate names; junk `food_type`; unit
  case variants; missing images; malformed `qty`
- Verification: re-read every written document and compare field by field with
  the legacy row, counting whitespace-only differences separately (as the
  enrollment migration does)
- Rollback: the collection is new, so rollback is dropping it; no legacy write
  ever happens, and re-running is safe by construction

No migration script was created in this task.

---

## 20. Risks / unknowns

| # | Item | Why it matters |
|---|---|---|
| 1 | **The image files are not available.** | 970 references cannot be verified or migrated until the live `wwwroot/Images` is copied. Highest-impact unknown. |
| 2 | Should the 11 energy-less foods be migrated? | They are invisible in legacy. Migrating makes them appear for the first time. |
| 3 | Should `delete_flg=1` become archived? | Those 11 foods are currently visible to members. Archiving them is a visible behaviour change — arguably a fix, but a change. |
| 4 | Canonical `foodType` vocabulary | Legacy has `Veg.`/`NonVeg`/`Veg`; the portal type says `Vegetarian`/`Non-Vegetarian`; diet plans use a third set. Someone must choose. |
| 5 | Unit normalisation | `grams` vs `Grams`, `ml` vs `ML`. 736 rows affected. |
| 6 | 137 duplicate names | Does the new system deduplicate, or carry them? No legacy unique rule exists. |
| 7 | Which nutrition copy is authoritative? | Recommended `r_food_energy`; one row disagrees, so the choice is visible in the data. |
| 8 | Who set `delete_flg=1`? | No code writes it. Possibly direct SQL, possibly a newer tool outside this repo. |
| 9 | Did the edit image bug ever fire? | Today there are no literal `'NULL'` values, which is inconsistent with the code path. Either it is rarely used or rows were cleaned. |
| 10 | `m_food.food_id` has no AUTO_INCREMENT flag in `SHOW COLUMNS` | Worth confirming how ids are allocated before assuming a max+1 pattern. |
| 11 | App image base URL | No config key found. The Flutter app must hardcode the admin host; the value could not be confirmed from this repo. |
| 12 | `m_food_request` (107 rows) | A related module with its own screen. In scope for `/nutrition/foods` or not? |
| 13 | Food log and favourites | 29,748 + 1,553 rows referencing foods. Migrating them is separate work, but the food migration must not break their future mapping. |

---

## 21. Files inspected

**Legacy admin:** `Controllers/FoodController.cs`, `Controllers/FoodRequestController.cs`,
`Views/Food/FoodList.cshtml`, `Views/Food/Add_Food.cshtml`,
`Views/Food/EditFood.cshtml`, `Views/Food/Food_Log.cshtml`,
`Views/FoodRequest/RequestFood.cshtml`, `Models/FoodModel.cs`,
`GGF.Model/FoodModel.cs`, `GGF.Service/FoodService.cs`, `GGF.DAL/FoodDAL.cs`,
`GGF.DAL/FoodRequestDAL.cs`, `Startup.cs`

**Legacy API:** `ggfAPI/Controllers/FoodController.cs`,
`ggf.Services/FoodService.cs`, `ggf.Data/FoodDAL.cs`, `ggf.Model/FoodModel.cs`,
`FoodSearchModel.cs`, `FoodLog.cs`, `FoodLogDetails.cs`, `FoodLogModel.cs`,
`MealFood.cs`, `DietMealFoodModel.cs`, `ggfAPI/wwwroot/*`

**Database (read-only):** `m_food`, `r_food_energy`, `m_food_request`,
`r_user_food_favorite`, `t_food_log`, `r_diet_plan_meal`, `r_plan_meal`,
`m_food_brand` (absent) — schemas, indexes, counts and distributions

**New backend:** `src/models/*`, `src/services/storage/index.js`,
`src/services/coach-image.service.js`, `gogetfit-plan-image.service.js`,
`src/utils/image.js`, `src/middleware/upload.middleware.js`,
`src/services/gogetfit-plan.service.js`, `coupon.service.js`

**New portal:** `src/features/nutrition/FoodListPage.tsx`, `FoodFormPage.tsx`,
`src/mock/nutrition/foodRepository.ts`, `src/types/nutrition.ts`,
`src/app/router/routes.tsx`

---

## 22. Recommended next implementation steps

1. Resolve unknowns 1–4 (images, energy-less foods, `delete_flg`, vocabulary) —
   each changes the model or the migration.
2. Build the `Food` Mongoose model from §17, reusing `image:{url,storageKey}`,
   `status: active|archived` and the `legacy` block.
3. Admin CRUD under `/api/admin/foods` following the GoGetFit Plan module:
   capped pagination, allow-listed sort and projection, archive instead of
   delete, a separate `PUT /:id/image` using the existing image service.
4. Migration (extractor → transformer → loader → script), dry-run first, with the
   conflict report in §19.
5. Image migration as its own phase, after the files are in hand.
6. Point the portal's `/nutrition/foods` at the real API, replacing
   `mock/nutrition/foodRepository`.
7. Only then consider `m_food_request`, favourites and the food log.
