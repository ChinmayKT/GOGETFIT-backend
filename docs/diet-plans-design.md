# Coach Diet Plans — legacy behaviour and MongoDB design (Step 4)

Design and validation only. Nothing here has been implemented and no DietPlan
document has been written. Every number below was measured on 2026-10-06 by
`migration/scripts/analyze-diet-plans.js` (read-only: MariaDB read-only pool,
MongoDB reads only) against `staging-ggf` and the `gogetfit-dev` database. The
full machine-readable result is
`migration/reports/runs/diet-plan-analysis-2026-10-06T11-46-33-168Z.json`.

---

## 1. Legacy behaviour (the source of truth)

### 1.1 How the member app selects the plan for a day

Flow: member opens their plan calendar (`after_booking.dart` → `ViewPlan(isFrom: 3)`)
→ taps a day → `GET api/GetWorkoutDietPlanDetails?LoginToken&date&userId`
(`view_plans.dart:988`, `booking_api_provider.dart:560`) →
`WorkoutDAL.GetDietPlanDetails` (`api/ggf.Data/WorkoutDAL.cs:162`):

```sql
select a.diet_plan_id, a.diet_plan_name, b.diet_date, a.total_calories, a.fat, a.carbs, a.protein
from m_diet_plan a inner join r_diet_plan_dates b on a.diet_plan_id = b.diet_plan_id
where a.diet_plan_id in (select c.diet_plan_id from m_diet_plan c where c.user_id = '<userId>' order by c.create_date desc)
  and b.diet_date = STR_TO_DATE('<date>', '%d-%m-%Y %H:%i:%s')
order by a.create_date desc limit 1
```

| Question | Verified answer |
|---|---|
| Client | `m_diet_plan.user_id` = the `userId` the app sends, which is `prefsHelper.getUserId()` - the logged-in member's own `m_user.user_id`. (The `loginToken` branch is unused by the app.) |
| Date format sent | `d-M-yyyy`, unpadded, no time (`view_plans.dart:135`). `STR_TO_DATE('6-1-2026', '%d-%m-%Y %H:%i:%s')` = `2026-01-06 00:00:00` (verified on the server). |
| Date comparison | Exact `datetime` equality. All 7404 `diet_date` values are midnight (0 non-midnight, 0 NULL), so it is **date-only** in practice. |
| Timezone | None. `diet_date` is a naive IST wall-clock date (server `@@system_time_zone = Asia/Calcutta`); the day is the device's calendar day. |
| Several plans on the day | `order by a.create_date desc limit 1` → **newest `m_diet_plan.create_date` wins**. |
| Equal `create_date` | Undefined in legacy (no tie-break). **0 occurrences** in the data. |
| Duplicate date rows | Harmless: same plan twice, `limit 1`. 255 duplicate rows in 11 plans. |
| Plan with no dates | Never selectable for any day (81 plans). |
| Plan with dates but no meals | **Selected** - the member sees the plan name with empty meals, and it **hides any older plan** on those days (6 such plans have visible days). |
| Plan creation time | Only precedence; it does not limit applicability. |

### 1.2 What the member sees for the selected plan

`GET api/GetDietPlanMeals?planId=` → `DietService.GetDietPlanMeals` loops
`meal_id = 1..8` and runs `DietDAL.GetDietPlanMeals` (`DietDAL.cs:376`) per meal:

```sql
select a.food_id, c.food_name, c.brand_name, a.quantity, CAST(c.qty as INT) as originalqty, c.unit, c.image_file_name,
       a.calories, a.fats, a.carbs, a.proteins
from r_diet_plan_meal a inner join m_meal b on a.meal_id = b.meal_id inner join m_food c on a.food_id = c.food_id
where diet_plan_id = '<planId>' and a.meal_id = '<mealId>' order by a.meal_id, a.food_id
```

- **Meals**: always 8 slots (1..8, `m_meal` has exactly 8 rows named "Meal 1".."Meal 8"); empty slots are present and empty.
- **Food order**: `food_id` ascending within a meal. The same food twice in one meal with different values has an undefined order (4 occurrences: plans 27, 29, 51, 57).
- **Food identity/details**: name, brand, unit, image come **live** from `m_food`; inner joins hide rows whose food or meal is missing (0 such rows today).
- **Nutrition values**: from the **plan row** (`r_diet_plan_meal`), never recomputed by the server. They are the food master's *per-serving* values copied when the coach added the food (`food_list.dart:2074-2081` sends the food's own calories/fat/carbs/protein; `Quantity` is what the coach typed, in the food's unit).
- **What the member actually reads** (`get_meal_plan_list_screen.dart:139-192, 688-853`):
  `shown = rowValue / originalqty * quantity`, formatted `toStringAsFixed(1)`;
  meal and day totals are sums of those scaled values. `originalqty` is `CAST(m_food.qty AS INT)` read **live**.
  734 of 1164 visible rows have `quantity ≠ originalqty`, so the scaling is visible to users.
- **Header shown**: plan name, BMR, TDEE, goal (`view_plans.dart:382`, `get_meal_plan_list_screen.dart`). The stored `total_calories/fat/carbs/protein` are coach-entered targets; the app displays totals computed from the foods.

### 1.3 Coach side
Coaches build plans in `create_diet_plan.dart` and copy them onto dates (`AssignPlanToDates`).
`FetchDietPlanList` (plans `created_by` OR `user_id` = caller) is used only by the coach's
create-diet-plan flow; dateless plans are therefore coach-side drafts no member ever saw.

---

## 2. Legacy data profile (re-measured)

| Fact | Value |
|---|---|
| `m_diet_plan` / `r_diet_plan_meal` / `r_diet_plan_dates` / `m_meal` | 178 / 1173 / 7404 / 8 |
| Orphan meal rows (plan id 197, no header) | 9 - unreachable in legacy |
| Plans without meal rows / without visible foods | 51 / 51 |
| Plans without dates | 81 (36 of them have foods) |
| Duplicate plan/date rows | 255 (11 plans) |
| Contiguous / sparse dated plans | 78 / 19 |
| Clients with plans | 63 |
| Client-days where >1 plan applies | 728 |
| Date range | 2023-02-01 … 2024-09-30 |
| Visible food rows / distinct foods | 1164 / 84 |
| Foods with no Mongo Food | 5 rows, all plan 17 (food_id 1,2,3,5,6) - plan 17 is dateless and its owner no longer exists |
| `CAST(qty AS INT)` vs Mongo `Food.servingQuantity` on every visible row | 0 differences, 0 zero divisors |
| Plan creators (`created_by`) | 187 Prajwal (coach, 118 plans) · 332 Karthik M (coach `user_type C`, 47) · 123 Kausthub (`user_type U`, 12) · 166 (deleted user, 1) |
| Self-created (`created_by = user_id`) | 8 (staff/test accounts 123 and 187) |

**Clients not in dev Mongo (18).** Dev holds 50 of 482 legacy users by design
(`cleanup-users.js`). Of the 18 missing plan owners:
- **7 do not exist in `m_user` at all** (111, 161, 166, 188, 196, 197, 199): 76 plans, 252 "visible" days that no one can log in to see.
- **11 exist and were trimmed from dev** (incl. coach 332): 27 plans, 949 visible days. They migrate in a full-user environment.

**Selection replay.** The verbatim legacy query was run for **7248** client-days: every
assigned day of every client (6335) plus every gap day inside and at the edge of each
client's span (913). The reconstruction "newest `create_date` among plans holding the
exact date" matched **7248/7248**.

---

## 3. Proposed MongoDB `dietplans` document

One document = one plan applied to **one contiguous run of days**. A legacy plan with
sparse dates becomes several documents that share `planId` (section 7).

```js
{
  _id: ObjectId,
  planId: String,              // logical plan; shared by its date segments
  clientId: ObjectId,          // -> users._id
  enrollmentId: ObjectId|null, // -> enrolledclients._id, only when proven (section 6)
  coachId: ObjectId|null,      // -> coaches._id, only when proven
  name: String,
  fromDate: Date,              // start of the IST business day (startOfBusinessDay)
  toDate: Date,                // start of the IST business day, inclusive, >= fromDate
  assignedAt: Date,            // precedence key: newest wins (section 8)
  bmr: Number|null, tdee: Number|null, goal: String|null,
  targets: { calories, fat, carbs, protein },     // coach-entered, not derived
  meals: [{
    meal: Number,              // 1..8, ascending, unique within the doc
    foods: [{                  // array order IS the display order
      foodId: ObjectId,        // -> foods._id
      qty: Number,             // amount prescribed, in the food's unit
      portion: Number,         // the serving size the four values below describe
      calories: Number, fat: Number, carbs: Number, protein: Number   // per `portion`
    }]
  }],
  status: 'active'|'archived',
  legacy: { source, dietPlanId, createdBy, createDate, lastUpdateDate, segment: { index, of } },
  migration: { runId, migratedAt, version },
  createdBy: ObjectId|null, updatedBy: ObjectId|null, createdAt, updatedAt
}
```

## 4. Field contract

| Field | Type | Req. | Ref | Legacy source | Validation | Purpose |
|---|---|---|---|---|---|---|
| planId | String | yes | - | `${source}:${diet_plan_id}` for migrated; generated for new | non-empty | groups segments of one plan; admin "edit plan" edits all segments |
| clientId | ObjectId | yes | users | `user_id` → `users.legacy.userId` | user exists | ownership; the only lookup key |
| enrollmentId | ObjectId | no | enrolledclients | section 6 | if set: same `userId` as clientId; segment inside its window | coaching context |
| coachId | ObjectId | no | coaches | `created_by` → section 6 | if set and enrollment has a coach: must equal it | authorship / coach access |
| name | String | yes | - | `diet_plan_name` (verbatim, incl. trailing spaces) | ≤ 120 | shown to member |
| fromDate / toDate | Date | yes | - | contiguous run of `diet_date` | IST day starts; from ≤ to | applicability |
| assignedAt | Date | yes | - | `m_diet_plan.create_date` (IST) | - | overlap precedence |
| bmr, tdee | Number | no | - | `bmr`, `tdee` float(7,2) | ≥ 0 | shown to member |
| goal | String | no | - | `goal` verbatim | ≤ 50 | shown to member |
| targets.* | Number | yes | - | `total_calories`, `fat`, `carbs`, `protein` (int) | ≥ 0 | coach targets; not displayed as totals |
| meals[].meal | Int | yes | - | `meal_id` | 1..8, unique, ascending | slot |
| foods[].foodId | ObjectId | yes | foods | `food_id` → `foods.legacy.foodId` | Food exists (any status) | identity; name/brand/image/unit read live |
| foods[].qty | Number | yes | - | `r_diet_plan_meal.quantity` | > 0 | prescribed amount |
| foods[].portion | Number | yes | - | `CAST(m_food.qty AS INT)` at migration = `Food.servingQuantity` | > 0 | divisor for display |
| foods[].calories/fat/carbs/protein | Number | yes | - | `calories`, `fats`, `carbs`, `proteins` of the row | ≥ 0 | snapshot per portion |
| legacy.* | - | migrated only | - | as named | immutable | audit / idempotency |

Meals with no foods are not stored (the client renders slots 1..8). A document may have
`meals: []` - that is a real legacy state (section 1.1).

## 5. Food snapshot strategy

- **From Food (live):** name, brand, image, servingUnit (label for `qty`), foodType.
- **Frozen in DietPlan:** `qty`, `portion`, `calories`, `fat`, `carbs`, `protein` - copied from the legacy row, never recalculated.
- **Display rule (must be implemented identically by the API/app):**
  `shown = value / portion * qty`, rounded to 1 decimal; meal/day totals are sums of `shown`.
- Why `portion` is frozen: legacy reads the divisor live from `m_food`, so today it equals the
  Food master (0 differences). Freezing it at migration keeps what members see now even if
  the Food master's serving size is edited later - the stated snapshot intent.
- Storing per-portion values (not pre-multiplied totals) keeps the legacy numbers verbatim and
  matches how a coach adds a food in the new app (pick food → copy its per-serving values → type qty).

## 6. User / enrollment / coach mapping (deterministic)

- **clientId** = `users._id` where `legacy.userId = m_diet_plan.user_id`. Never by phone, name or role. Missing → plan not migrated (reported).
- **coachId**: `created_by` → `users.legacy.userId` → `coaches.userId`, **and** cross-checked with
  `m_user.email_id` → `m_coach.email` → legacy-coach mapping. Set only when both agree on one Coach.
  Otherwise null with `legacy.createdBy` kept. In dev: 39 plans resolve (Prajwal); 35 do not (Karthik M has no
  user/Coach in dev); 123 and 166 are not coaches → always null.
- **enrollmentId**, per document (after splitting, below):
  1. Candidates = the client's enrollments with `startDate` and `endDate`, whose IST-day window contains **every** day of the document.
  2. Exactly one → use it. None → `null` (allowed: legacy was user/date driven).
  3. Several → the one whose coach (`legacy.coachId` via the coach mapping) equals the plan's creator; if still not exactly one → **ambiguous, not written**.
  - A document whose days cross an enrollment boundary is **split at the boundary** (same plan, same `assignedAt`, so selection is unchanged).
  - Dev result for migratable clients: 96 date runs → **153 documents**: 70 with one enrollment, 82 with none, 1 inside two (plan 173 from 2024-06-17: enrollments 118 Karthik / 135 Prajwal overlap; creator is Prajwal → rule 3 picks 135).
  - Only 5 plans lie entirely inside one enrollment; 29 lie entirely outside any. Forcing an enrollment would be invented data.

## 7. Date migration strategy (mandatory)

`fromDate/toDate` alone **cannot** represent the legacy plans faithfully:

| Representation | Documents | Day-level parity vs legacy (7248 days) |
|---|---|---|
| Z. one doc per plan, first..last date | 97 | **209 wrong days** (sparse gaps filled) |
| **A. one doc per contiguous run of the plan's own dates; newest `assignedAt` wins at read time** | 180 | **0 mismatches** |
| B. precedence resolved at migration; one doc per run of days the plan actually won; no overlaps | 188 | 0 mismatches |

**Recommended: A.** Each maximal run of consecutive `diet_date` values (after de-duplication)
becomes one document; all documents of a plan share `planId`, content and `assignedAt`.
No day is added (no gap is ever covered) and no day is removed. It keeps every assigned
day, including the 3 plans (69, 71, 122) that are fully hidden by newer plans and the days
other plans hide, so the legacy semantics survive future edits (deleting a newer plan
reveals the older one, exactly as legacy would). B loses those shadowed assignments.

Dates are stored as `startOfBusinessDay(yyyy-mm-dd)` (IST), the existing convention
(`src/utils/business-date.js`, used by enrollments). Queries take the member's
`yyyy-mm-dd` and convert it the same way.

Dateless plans (81) have no representable range - see open decision D2.

## 8. Overlap strategy

Read for client C on day D (both representations validated):

```js
DietPlan.find({ clientId: C, status: 'active', fromDate: { $lte: D }, toDate: { $gte: D } })
  .sort({ assignedAt: -1, planId: -1 }).limit(1)
```

`assignedAt` = legacy `create_date` for migrated plans and the creation time for new ones,
which is exactly the legacy rule. `planId` is a deterministic tie-break (legacy had none;
0 ties exist). Never `_id`, insertion order or `updatedAt`.

## 9. Legacy plan metadata

| Legacy | Decision |
|---|---|
| plan name | `name` (business; shown) |
| total_calories / fat / carbs / protein | `targets` (business; coach targets, not derivable from foods) |
| bmr, tdee, goal | `bmr`, `tdee`, `goal` (business; shown) |
| create_date | `assignedAt` (precedence) + `legacy.createDate` |
| created_by | `coachId` when proven; always `legacy.createdBy` |
| last_update_date | `legacy.lastUpdateDate` (audit) |
| diet_plan_id | `planId = "gogetfit:<id>"` + `legacy.dietPlanId`; never `_id` |
| row create_date / created_by | not kept (row audit only; used for nothing in legacy reads) |

## 10. Classification (all 178 plans)

| Class | Plans | IDs / reason |
|---|---|---|
| A. Migratable | 1 | - |
| B. Migratable with metadata | 65 | sparse (7), days outside any enrollment (59), creator not a Mongo coach (35), fully shadowed (1) |
| B'. Migratable once all users are migrated (trimmed from dev only) | 13 | 42, 89, 90, 102, 103, 104, 107, 109, 114, 119, 120, 139, 140 |
| C. Ambiguous - needs approval | 23 | dateless: 17, 30, 31, 55, 56, 57, 58, 60, 75, 91, 93, 94, 97, 99, 101, 106, 110, 111, 112, 113, 161, 174 · two enrollments: 173 (rule 6.3 resolves it) |
| D. Unmigratable | 76 | owner absent from `m_user` (111, 161, 166, 188, 196, 197, 199): 1, 3-16, 18-29, 32-41, 43-54, 59, 62-74, 76-88 |
| (orphan rows) | - | 9 meal rows of nonexistent plan 197 |

Migratable now in dev: 67 plans, 5134 visible client-days. The 4 duplicate-food
ordering cases are migratable with a documented order (`food_id`, then row
`create_date`, then quantity).

## 11. Replay validation (Step 5 acceptance)

For every migrated client and every day from (first assigned day − 1) to (last + 1):
1. Legacy: run the verbatim `GetDietPlanDetails` query (`d-M-yyyy`), then `GetDietPlanMeals` 1..8.
2. New: the section 8 query, then the document's meals.
3. Compare: selected legacy plan id (`legacy.dietPlanId`) or none; name, bmr, tdee, goal;
   meal numbers and order; per food `foodId↔food_id`, order, `qty`, `portion↔originalqty`,
   the four raw values, and the displayed `value/portion*qty` to 1 decimal; meal and day totals.
4. Any difference fails the run and lists client, day and field. Target: 0 differences
   (the analysis already shows 0 for selection on all 7248 days).

## 12. Indexes

- `{ clientId: 1, fromDate: 1, toDate: 1, assignedAt: -1 }` - the member's day lookup.
- `{ planId: 1 }` - edit/display all segments of a plan.
- `{ enrollmentId: 1, fromDate: 1 }` (partial: enrollmentId exists) - coach view of one coaching cycle.
- `{ coachId: 1, assignedAt: -1 }` (partial) - coach's plan list.
- Unique `{ 'legacy.source': 1, 'legacy.dietPlanId': 1, 'legacy.segment.index': 1 }` (partial) - migration idempotency.

## 13. Ownership invariants

- `clientId` is required and immutable; members read only `clientId = me`.
- `enrollmentId`, when set, belongs to `clientId` and its window contains the whole range.
- A coach may read/write a plan only through an enrollment whose `coachId` is theirs; plans with `enrollmentId: null` are member history, visible to the member and admins only.
- `coachId` is never inferred from an enrollment for migrated plans; it records authorship.
- `foods[].foodId` must reference an existing Food; archived Foods remain valid references.

## 14. Risks

1. Dev contains 50 of 482 users: dev can validate only 67 plans; a full-user environment must be used for the real run.
2. Coach 332 (Karthik M, 47 plans) needs a User and Coach in the target environment, or those plans keep `coachId: null`.
3. Display parity depends on clients implementing `value / portion * qty`; storing pre-multiplied values would silently change numbers.
4. Undefined legacy order for 4 duplicate-food cases; the chosen order may differ from what a member once saw.
5. Splitting plans into segments duplicates meals; edits must apply to all documents of a `planId`.
6. Enrollment windows are themselves migrated data (IST convention); a wrong window moves an `enrollmentId`, not visibility.
7. Members' devices send their local day; the new app must send the business-day `yyyy-mm-dd` the same way.

## 15. Open decisions (need approval)

- **D1 - Date representation:** approve A (contiguous segments + `assignedAt` precedence) over B (pre-resolved, non-overlapping).
- **D2 - Dateless plans (81; 22 for existing owners, 36 with foods):** never shown to members. Options: (a) do not migrate, keep in the migration report; (b) migrate as unscheduled drafts (`fromDate/toDate` null, excluded from day lookup) for a coach plan library. Recommendation: (a) unless the new coach app has a plan library.
- **D3 - `portion` without unit:** `qty` is labelled with the Food's live `servingUnit`. Approve, or also freeze the unit in the snapshot.
- **D4 - `planId` format:** `"gogetfit:<legacy id>"` for migrated plans and a generated id for new plans.

## 16. Verdict

**BLOCKED — awaiting approval of D1–D4.** No data or behavioural blocker was found: the
legacy selection rule is reproduced on 7248/7248 client-days, every visible food resolves,
and representation A reproduces every day with 0 mismatches.
