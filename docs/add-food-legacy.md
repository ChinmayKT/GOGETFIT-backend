# Legacy Admin Portal — "Add Food" screen

Read-only study of the legacy .NET admin. No code and no database row was modified.
Every statement below cites the legacy source; database figures come from read-only
`SELECT`s against production (`gogetfit`). Anything not verifiable is called out in
section 11.

## 1. What the screen is for

A single-record entry form for the **global food master** — the catalogue the mobile app
searches when a member logs a meal, and the same catalogue `/food/FoodList` lists. It is
admin-curated: there is no member-submitted path through this screen (food requests are a
separate table, `m_food_request`). One submission creates one food and its one nutrition
row.

It captures a food **at a specific portion**: name, veg/non-veg, a portion unit and
quantity, brand, a free-text comment, four macros, and one picture. The macros are
"per that portion", not per 100g — nothing in the form or the schema normalises them.
That is why the same food appears several times with different units (production has 60
distinct `(food_name, brand_name, unit, qty)` groups that occur more than once).

## 2. Route and entry points

| Step | Evidence |
| --- | --- |
| Sidebar "Add Food" → `/food/Add_Food` | `Views/Shared/_Layout.cshtml:251` |
| "Add Food" button on the food list → `Add_Food` (relative) | `Views/Food/FoodList.cshtml:147` |
| `GET /Food/Add_Food` builds an empty `FoodModel` and renders the view | `Controllers/FoodController.cs:37-44` |
| Form posts `multipart/form-data` to `/Food/CreateFood` | `Views/Food/Add_Food.cshtml:45` |

`CreateFood` carries **no `[HttpPost]` and no `[ValidateAntiForgeryToken]`**
(`FoodController.cs:146`), so it also answers GET and the antiforgery token the form
emits is never checked. There is no `[Authorize]` attribute on the controller either.

## 3. Fields

Page title "Add Food", card header "Food Log", breadcrumb "Add Food Iteam" (sic).

| Label on screen | Field name | Control | Required | Stored in |
| --- | --- | --- | --- | --- |
| Food Name | `FoodName` | text | **yes** | `m_food.food_name` |
| Food Type | `FoodType` | select | **yes** | `m_food.food_type` |
| Portion | `Unit` | select | **yes** | `m_food.unit` |
| Qty | `Qty` | text (bound to `int`) | **yes** | `m_food.qty` |
| Brand | `BrandName` | text | no | `m_food.brand_name` |
| Comments | `Comments` | text (single-line) | no | `m_food.comments` |
| Total Calories | `Calories` | text (bound to `float`) | **yes** | `r_food_energy.calories` |
| Fat in gm | `Fat` | text (bound to `float`) | **yes** | `r_food_energy.fat` |
| Carbs in gm | `Carbs` | text (bound to `float`) | **yes** | `r_food_energy.carbs` |
| Protein in gm | `Protein` | text (bound to `float`) | **yes** | `r_food_energy.protein` |
| Food Picture | `file` | file | no | `m_food.image_file_name` |

Required/optional comes from `[Required]` in `Models/FoodModel.cs:12-35`. `BrandName`,
`Comments` and the file carry no attribute. Buttons: **Add Food** (submit) and **Reset**
(native form reset, no handler). Placeholders are "Enter Name", "Qty", "Enter Brand",
"Enter Comments", "Calories", "Fat", "Carbs", "Protein".

Units are implicit and only in the labels: calories unlabelled ("Total Calories"), macros
"in gm". Nothing converts or checks them.

### Dropdown options and defaults

**Food Type** (`Add_Food.cshtml:59-63`) — two options, values differ from labels:

| Label | Submitted value |
| --- | --- |
| Vegetarian | `Veg.` |
| Non-Vegetarian | `NonVeg` |

**Portion** (`Add_Food.cshtml:72-83`) — ten options with **no `value` attribute**, so the
visible text is what is submitted: `Bowl`, `Cup`, `Glass`, `Grams`, `ML`, `Piece`,
`Scoop`, `Serving`, `Slice`, `Spoon`.

Neither select is marked `selected`, so the browser pre-selects the first option:
**Food Type = Vegetarian (`Veg.`)** and **Portion = `Bowl`**. There is no blank/prompt
option, so a form submitted without touching them still saves `Veg.` + `Bowl`.

Production bears this out: `food_type` is `Veg.` 1220, `NonVeg` 172, plus one stray `Veg`
(1 row) the dropdown cannot produce. `unit` holds `Grams` 897, `Piece` 141, `Serving` 110,
`grams` 101, `ML` 68, `Scoop` 54, `Bowl` 8, `Slice` 6, `Cup` 4, `Spoon` 2, `ml` 2 — the
lowercase variants cannot come from this form, and `Glass` has never been used.

A brand **dropdown** was intended and is commented out (`Add_Food.cshtml:117-118`,
`FoodController.cs:41`), so `m_food_brand` / `GetBrandList()` are dead for this screen and
Brand is free text.

## 4. Client-side validation — effectively none

`Add_Food.cshtml:12` loads `jquery.validate.js`, but the **unobtrusive adapter is
commented out** (`Add_Food.cshtml:7-9`). `Views/Shared/_ValidationScriptsPartial.cshtml`
exists and loads the adapter, but no view in the project renders it (grepped — zero
references). Without the adapter, jQuery Validate never reads the `data-val-*` attributes
MVC emits, so **nothing is enforced in the browser**.

There are also no `maxlength`, `min`, `max`, `step`, `pattern` or `type="number"`
attributes — every numeric field is a plain text box. All enforcement is server-side via
`ModelState.IsValid` (`FoodController.cs:151`). Consequences:

- A missing required field, or letters typed into Qty/Calories/Fat/Carbs/Protein, only
  fails after a full round trip; the form redisplays with
  `@Html.ValidationMessageFor` text in red and the entered values preserved.
- Negative numbers, zero, and absurd values are accepted — no range check exists anywhere.
- No duplicate check, no cross-field check (e.g. macros vs calories).

## 5. Image upload

`FoodController.cs:153-209`. Optional — if no file is chosen the whole block is skipped.

1. Extension is taken from the **file name** and compared, lowercased, against `.jpg`,
   `.jpeg`, `.png` (`:166`). Anything else sets `ViewBag.FileInvalid = "only jpg and png
   format is allowed"` and redisplays the form — **nothing is written to the database**
   (`:201-205`).
2. The stored name is a fresh `Guid` plus the original extension (`:161`, `:170`), so the
   uploaded file name is discarded. Production confirms: the newest rows hold names like
   `6df0779c-9e33-4caf-bc4a-168cdf8d2157.png`.
3. The upload is written to `wwwroot/tempimage/`, then re-encoded with ImageMagick —
   `image.Resize(300, 300)`, `Quality = 70`, format unchanged — into `wwwroot/Images/`,
   and the temp file is deleted (`:173-191`). `Resize` fits the image inside the box
   preserving aspect ratio, so 300×300 is a bound, not an output size.
4. Only the extension is checked; there is no MIME or content sniffing, so a renamed file
   reaches ImageMagick. There is no explicit size cap, and `Startup.cs:34` sets
   `IISServerOptions.MaxRequestBodySize = int.MaxValue`.
5. `FoodList` serves the result from `/images/` (`FoodList.cshtml:38`), 75×75 in the grid.

With no file, `ImageFileName` stays `null` and the insert concatenates it into quotes, so
the column receives an **empty string, not NULL** (`FoodDAL.cs:37`). Production matches
exactly: 0 NULL, **12 empty**, out of 1393.

## 6. What happens on Save

`POST /Food/CreateFood` (`FoodController.cs:146-231`):

1. AutoMapper copies `gogetfit_admin.Models.FoodModel` → `GGF.Model.FoodModel`
   (`Models/MapperUtil.cs:15`), a plain property-name map.
2. `ModelState.IsValid` is checked first; invalid → re-render `Add_Food` with the model.
3. Image handling (section 5), then `obj.ImageFileName = newFileName`.
4. `FoodService.IsFoodAdded(obj)` (`GGF.Service/FoodService.cs:22-31`):
   ```csharp
   if (objDAL.IsFoodAddedAsync(objModel))
   {
       objDAL.IsFoodEnergyAdded(objModel);
       return true;
   }
   return false;
   ```
   Two separate inserts, **no transaction**, and the energy insert's return value is
   discarded — the service reports success whenever the `m_food` insert affected a row.

### Columns written

`m_food` (`GGF.DAL/FoodDAL.cs:15-47`), built by string concatenation:

| Column | Value |
| --- | --- |
| `food_name`, `food_type`, `brand_name`, `unit`, `qty`, `comments` | form values, all quoted as strings |
| `image_file_name` | GUID filename, or `''` |
| `create_date`, `last_update_date` | `CURRENT_TIMESTAMP()` |
| `created_by`, `last_update_by` | literal **`123`** |

`food_id` is `auto_increment`. **`m_food.calories`, `fat`, `carbs` and `protein` are
commented out of the insert** (`FoodDAL.cs:23`, `33-36`) although the columns exist, so
every food added through this form leaves them NULL. Verified in production: of the 97
rows with `food_id > 1300`, 86 have `m_food.calories` NULL, and the three newest rows have
NULL there while `r_food_energy.calories` holds 501, 114 and 174. `created_by` is `123`
for all 1393 rows — the model's `UserId` is never populated, so no real admin identity is
recorded.

`r_food_energy` (`FoodDAL.cs:49-71`):

| Column | Value |
| --- | --- |
| `food_id` | **`(select max(food_id) from m_food)`** |
| `calories`, `fat`, `carbs`, `protein` | form values, unquoted |
| `create_date`, `last_update_date` | `CURRENT_TIMESTAMP()` |
| `created_by`, `last_update_by` | literal `123` |

Two defects follow directly from this code, both of which the data shows:

- **`max(food_id)` instead of `LAST_INSERT_ID()`** — two admins saving at the same moment
  can attach one food's macros to the other's row. Single-user use hides it.
- **No transaction** — if the `m_food` insert succeeds and the energy insert fails, the
  food exists but is invisible everywhere, because every read inner-joins
  `r_food_energy`. Production has exactly 11 such foods (`food_id 1-8, 10, 11, 12`), and
  4 energy rows whose food is gone (`115, 146, 147, 282`).

### Injection and column limits

Values are concatenated into SQL. Only `'` is escaped, and only for `FoodName`,
`BrandName` and `Comments` (`FoodDAL.cs:18-19`, `:27`); `FoodType`, `Unit`,
`ImageFileName` and all numbers go in raw. `FoodType` and `Unit` come from selects and the
numbers are bound to `int`/`float`, which limits exposure in practice but is not a defence.

Column limits (production schema): `food_name`, `food_type`, `brand_name`, `unit`, `qty`,
`comments` are each `varchar(45)`; `image_file_name` `varchar(100)`; `m_food.calories`,
`fat`, `carbs`, `protein` are `int(11)` (unused by this form); `r_food_energy.*` are
`float(8,4)`, which caps any macro at **9999.9999**. `qty` is a **varchar**, not a number,
although the model binds it as `int`. `sql_mode` includes `STRICT_TRANS_TABLES`, so an
over-length value raises an error rather than truncating.

## 7. Duplicate validation — there is none

No `SELECT`, `EXISTS` or `COUNT` precedes either insert; grepped `FoodDAL.cs` and
`FoodService.cs` for `duplicate`, `exists` and `count(*)` — zero matches. There is no
unique index on `food_name` (the only key on `m_food` is `food_id`). Saving the same food
twice creates two rows, and production contains 60 repeated
`(food_name, brand_name, unit, qty)` combinations. The visible pair on the food list's
first page — two `High Protein Paneer` rows, Grams/100 and Bowl/0 — is a normal result of
this.

## 8. Success, error and navigation

| Outcome | Behaviour |
| --- | --- |
| `m_food` insert affected a row | `ViewBag.Status = "Success"` |
| It affected none | `ViewBag.Status = "Failure"` |
| Bad file extension | `ViewBag.FileInvalid`, nothing saved |
| `ModelState` invalid | form redisplayed with messages, nothing saved |

Either way the controller calls `ModelState.Clear()` and returns `View("Add_Food")` **with
no model** (`FoodController.cs:222-223`), so the blank form is rendered again.
`@ViewBag.Status` and `@ViewBag.FileInvalid` are printed as bare unstyled text at the
bottom of the card (`Add_Food.cshtml:187-188`) — no alert, no colour, no toast.

There is **no redirect**: the URL stays `/Food/CreateFood`, so a browser refresh re-posts
the form and creates a duplicate. The admin is never taken to the new food, and never to
the food list; reaching the list means clicking the sidebar. There is no "save and add
another", no confirmation dialog and no draft state.

An unhandled exception would not show "Failure" — `Startup.cs:43` enables
`UseDeveloperExceptionPage()` unconditionally, so a stack trace is rendered instead.

## 9. End-to-end summary

```
/food/Add_Food (GET)
  └─ FoodController.Add_Food        → empty FoodModel → Views/Food/Add_Food.cshtml

/Food/CreateFood (form POST, multipart)
  └─ FoodController.CreateFood
       ├─ ModelState.IsValid                        (server-side only)
       ├─ file? → extension whitelist → GUID name
       │          → wwwroot/tempimage → Magick Resize(300,300) Q70
       │          → wwwroot/Images → delete temp
       ├─ AutoMapper → GGF.Model.FoodModel
       └─ FoodService.IsFoodAdded
            ├─ FoodDAL.IsFoodAddedAsync   → INSERT m_food          (no macros)
            └─ FoodDAL.IsFoodEnergyAdded  → INSERT r_food_energy   (max(food_id))
       → ViewBag.Status → re-render Add_Food, blank, no redirect
```

## 10. Confirmed facts

- One screen, one view (`Views/Food/Add_Food.cshtml`), one create action; no second
  implementation anywhere in the legacy tree.
- 11 fields: 8 required, 2 optional text, 1 optional image.
- Both selects default to their first option and have no empty choice.
- Client-side validation does not run; the unobtrusive adapter is never loaded.
- Only `.jpg`, `.jpeg`, `.png` by file extension; stored as a GUID, re-encoded to fit
  300×300 at quality 70.
- Macros are written to `r_food_energy` only; the `m_food` macro columns are left NULL.
- `created_by` / `last_update_by` are the literal `123` on every row.
- No duplicate detection of any kind, and no unique constraint on the name.
- No transaction across the two inserts; the energy insert's result is ignored.
- After a save the blank form is re-rendered at `/Food/CreateFood`, with "Success" or
  "Failure" as plain text; refresh re-submits.

## 11. Not verified

- **Whether the deployed build matches this source.** The repo's `bin/` folders are empty,
  `Old GGF` is not a git repository, and `gogetfit-admin/wwwroot` is absent from this copy,
  so the running binary could differ. The production data is consistent with this code
  (GUID `.png` names, `created_by = 123`, NULL `m_food.calories` on new rows), which is
  strong but indirect evidence.
- **No submission was performed.** The flow is read from code, not exercised; nothing was
  inserted.
- Whether `wwwroot/tempimage` and `wwwroot/Images` exist and are writable on the server —
  the folders are not in this copy. If `tempimage` is missing, `File.Create` throws and the
  developer exception page appears instead of "Failure".
- Which ImageMagick delegates are installed, so which formats actually decode once an
  acceptable extension is present.
- Whether the 6 rows whose `comments` are exactly 45 characters were truncated before
  `STRICT_TRANS_TABLES` was enabled, or are simply that long.
- Whether any authentication filter is applied outside the controller (no `[Authorize]`
  attribute is present; `Startup` wiring beyond session was not audited for this report).
- The Edit Food screen was out of scope and was not analysed.
