# GoGetFit Plans — legacy behaviour and migration note

Source of truth: `Old GGF/ggf/admin/gogetfit-admin` (PackageController, Views/Package/*),
`GGF.DAL/PackageDAL.cs`, `GGF.Model/PackageModel.cs`, and the live `staging-ggf.m_package`
schema (read-only).

"GoGetFit Plans" are the legacy **Packages** (`m_package`): the paid coaching products the
app sells (e.g. "12 WEEKS GOGETFIT PLAN", ₹4,999). The admin menu said "Packages"; the form
fields said "Plan Name / Plan Type / Plan Level". Not to be confused with `m_plan`
(Free Diet Plan templates, already migrated to `freedietplans`).

## Table `m_package` (staging: 9 rows, prod: 20)

| column | type | notes |
|---|---|---|
| package_id | int PK AI | only index |
| package_type | varchar(25) NULL | `Enrollment` / `Challenge` |
| package_name | varchar(45) NULL | |
| coach_level | varchar(25) NULL | `LEVEL 1`..`LEVEL 5` (display only, never enforced) |
| duration | int NOT NULL DEFAULT 0 | weeks |
| person_allowed | int NOT NULL DEFAULT 0 | |
| base_price | int NOT NULL | INR, incl. taxes |
| reward | int NULL | refund money; required for Challenge on create |
| description, inclusions, what_next, tandc, eligibility | text NULL | free text; inclusions is newline "* ..." text |
| created_by, last_update_date, last_update_by | audit | always "123"; **no create date column** |

No status, delete flag, ordering, image, or currency column. Currency is implicitly INR.

## Old list (`/Package/PackageList`)
- All rows fetched once; Tabulator client-side pagination (10/page), header sort.
- Columns: Plan Name (text filter), Plan Type (select filter), Plan Level (select filter),
  Duration (weeks), Person(s), Base Price, Edit icon.
- Actions: Create Package, Edit. **No view, no delete** (delete UI commented out).
- Order: package_id ascending.

## Old form (Create / Edit share `AddPackage.cshtml`)
| label | field | type | rule |
|---|---|---|---|
| Plan Level * | coach_level | select LEVEL 1–5 | required, default LEVEL 1 |
| Plan Type * | package_type | select Enrollment/Challenge | required, default Enrollment |
| Plan Name * | package_name | text | required (DB max 45) |
| Duration * | duration | int, "Week" suffix | required |
| Persons Allowed * | person_allowed | int | required |
| Base Price (Incl. of taxes) * | base_price | int, "INR" suffix | required |
| Reward (Refund Money) | reward | int, "INR" suffix | optional; **mandatory when Challenge** ("Reward (Refund Amount) is mandatory when challenge is selected") — enforced on create only |
| Description, Package Inclusions, What Next, Terms and Conditions, Eligibility | text | textarea | optional |

Messages: "Package Added Successfully" / "Package Add Failed" / "Updated Successfully" /
"Update Failed" / "Form invalid, Please fill all the required fields!!".

## Old edit
Every field editable (type, level, price included). Loads by id; overwrites all columns.
Past enrollments keep their own paid amount (`t_enrollment.amount`), so editing a price
never rewrites history.

## Old delete
**None.** No action, no DAL method, no status. Packages were never removed.

## Duplicates
No duplicate check and no unique constraint. (Resubmitting the form created duplicates.)

## Relationships
- `t_enrollment.package_id` → package (prod 1,168 rows / 7 packages; staging 83 rows / packages 15, 16).
  Not migrated yet; the legacy package id is preserved so enrollments can be linked later.
- coach_level is a label only; the app listed every Enrollment package under every coach.
- The member app read `package_type='Enrollment'` for plans and `'Challenge'` for challenges.

## Decisions for the new system (and why)
1. **Delete = archive (soft delete), reversible.** The prompt asks for delete; the old system
   had none, and packages are referenced by enrollments, so hard delete would orphan history.
   Archived plans are hidden from the default list and can be restored. Same pattern as
   FreeDietPlan.
2. **No uniqueness rule.** Legacy had none; none is invented.
3. **Challenge ⇒ reward required** on create **and** edit (legacy only checked create; the
   edit path was a known gap, and the rule is clearly the intended business rule).
4. Numeric limits added (legacy had none beyond `int`): duration 1–520 weeks, persons 1–20,
   price 0–10,000,000, reward 0–price. Name max 45 (the DB column). Text fields max 20,000.
5. Texts are migrated **verbatim** (including stray leading quotes in inclusions).
6. Legacy Enrollment rows hold reward `0` (the old form wrote `''`); preserved as 0.
7. Server-side pagination/search/filters replace the old client-side Tabulator.
