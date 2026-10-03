# EnrolledClient — legacy discovery

What the legacy enrollment/purchase flow actually stores, column by column, and
where each value goes in MongoDB. Written before the model, from the staging
schema (`staging-ggf`) and the legacy C# code, not from the screens.

Sources inspected:

| What | Where |
|---|---|
| Enrollment insert | `api/ggf.Data/BookingDAL.cs` → `CreateBooking` |
| Enrollment start | `api/ggf.Data/BookingDAL.cs` → `SpawnBooking` |
| Member's plan list | `api/ggf.Data/BookingDAL.cs` → enrollment + package + coach join |
| Active-plan check | `api/ggf.Data/RegisterDAL.cs:160`, `api/ggf.Data/UserDAL.cs:259` |
| Coach's client list | `api/ggf.Data/CoachDAL.cs:157` |
| Admin client list | `admin/GGF.DAL/UserDAL.cs:75-95` |
| Payment insert | `api/ggf.Data/PaymentDAL.cs` |

Row counts at the time of writing (staging): `t_enrollment` 83, `t_payment` 120,
`m_package` 9, `m_coach` 2, `m_coupon` 15.

---

## 1. `t_enrollment` — every column

| Column | Type | Legacy meaning (from the code) | Destination | Transformation |
|---|---|---|---|---|
| `enrollment_id` | int PK | The enrollment's identity. Used by `SpawnBooking` and the coach's client list. | `legacy.enrollmentId` | Migration identity. Unique with `legacy.source`. |
| `package_id` | int | FK → `m_package.package_id`. Joined in every read. | `planId` → `GogetfitPlan._id` | Resolved through `GogetfitPlan.legacy.packageId`. Original kept in `legacy.packageId`. |
| `coach_id` | int | FK → `m_coach.coach_id`. Proven by `inner join m_coach c on a.coach_id = c.coach_id` in both the member list and the admin list. **Not** a `m_user.user_id`. | `coachId` → `Coach._id` when resolvable, else `null` | See §5. Original always kept in `legacy.coachId`. |
| `user_id` | int | FK → `m_user.user_id`. Written as a subquery on `login_token`. | `userId` → `User._id` | Resolved through `User.legacy.userId`. Original kept in `legacy.userId`. |
| `enroll_date` | datetime | When the purchase happened. Set by `CreateBooking` from the client's supplied date (`%d-%m-%Y %H:%i:%s`). Never null in staging. | `enrollDate` | Date. |
| `start_date` | datetime | **Not set at purchase.** `SpawnBooking` sets it to `CURDATE() + 1 day` when the member starts the plan. Null until then (5 rows). | `startDate` | Date or null. |
| `end_date` | datetime | Also set by `SpawnBooking`: `start_date + m_package.duration weeks`. Null until started. Verified: `DATEDIFF(end,start)/7` equals the package duration exactly. | `endDate` | Date or null. |
| `delete_flg` | char(1) | Soft-delete flag. `CoachDAL` filters `delete_flg='0'`. All 83 staging rows are `'0'`. | `isDeleted` | `'1'` → true, anything else → false. Raw value kept in `legacy.deleteFlg`. |
| `created_by` | varchar(45) | The legacy user id that created the row (the member themselves — `CreateBooking` writes the same subquery). 62 distinct values. | `legacy.createdBy` | Verbatim string. Not a Mongo reference. |
| `last_update_date` | datetime | Legacy audit timestamp. | `legacy.updatedAt` | Date. |
| `last_update_by` | varchar(45) | Legacy audit user id. | `legacy.updatedBy` | Verbatim string. |
| `start_flg` | char(1) | `'0'` at purchase, `'1'` once `SpawnBooking` ran. This is what "has the member started?" means. 78 × `'1'`, 5 × `'0'`. | `hasStarted` | `'1'` → true. Raw value kept in `legacy.startFlg`. |
| `transaction_id` | varchar(500) | The payment reference. **This is the join key to `t_payment`** — `admin/GGF.DAL/UserDAL.cs:89` joins `t_payment a inner join t_enrollment b on a.transaction_id = b.transaction_id`. Never null/blank, no duplicates in staging. | `payment.transactionId` | Trimmed string. |
| `amount` | varchar(10) | What the member paid, duplicated from the payment row. Always numeric; always equal to `t_payment.amount` (verified: 0 mismatches). | `payment.amount` (from the payment row) + `legacy.enrollmentAmount` | The enrollment's own copy is preserved separately so the duplication is not silently collapsed. |
| `currency` | varchar(20) | `'INR'` for all 83 rows. | `payment.currency` | — |

### Status: derived, never stored

`t_enrollment` has **no status column**. The member's plan list computes it:

```sql
CASE WHEN a.end_date < NOW() THEN 'inactive' ELSE 'active' END AS status
```

`UserDAL.cs:259` uses a different test for "currently on a plan":
`start_date <= curdate() and end_date >= curdate()`.

So there are two legacy notions and neither is persisted. No status field is
invented here: `hasStarted`, `startDate`, `endDate` and `isDeleted` are stored,
and status is computed on read with the legacy rule documented next to it.

---

## 2. `t_payment` — the fields that matter to an enrollment

Join key: `t_payment.transaction_id = t_enrollment.transaction_id` (verified in
the legacy admin SQL, not assumed). Every enrollment has exactly one payment;
37 payments have no enrollment and are out of scope here.

| Column | Type | Meaning | Destination | Notes |
|---|---|---|---|---|
| `transaction_id` | varchar(99) PK | Gateway payment id (`pay_…` for Razorpay rows). | `payment.transactionId` | The join key. |
| `user_id` | int | The paying member. Never conflicts with the enrollment's `user_id` (0 mismatches). | — | Redundant; the enrollment's own `user_id` is authoritative. |
| `payment_date` | datetime | When payment was recorded. | `payment.paidAt` | Never null for enrolled rows. |
| `original_amount` | int | Pre-discount amount. **`0` on all 83 enrolled rows** — the legacy client sent nothing useful. | `payment.originalAmount` | Preserved verbatim, including the zero. Not a usable historical price; see §6. |
| `discount_percent` | int(3) | **`0` on all 83 enrolled rows**, even where a coupon code is present. | `payment.discountPercent` | Preserved verbatim. No discount is inferred from it. |
| `coupon_code` | varchar(20) | The code the member typed. Only two values across enrolled rows: `''` (70) and `GGFLAUNCH10` (13). | `couponId` + `legacy.couponCode` | See §4. |
| `amount` | int | What was actually charged. 4999 (77) / 8999 (6). | `payment.amount` | Matches the enrollment's own `amount` in every row. |
| `currency` | varchar(5) | `'INR'` throughout. | `payment.currency` | — |
| `status` | varchar(15) | `'Success'` for all 120 rows. The admin list filters on it. | `payment.status` | Verbatim. No normalization — a second value has never been seen, so no mapping can be verified. |
| `reference_id` | varchar(99) | Gateway reference. **NULL on all 83 enrolled rows.** | `payment.referenceId` | Preserved (null today). |
| `description` | text | **NULL on all 83 enrolled rows.** | `payment.description` | Preserved (null today). |
| `customer_name`, `contact`, `email_id` | varchar | Billing identity captured at checkout. Populated on all enrolled rows. | `payment.customerName`, `payment.contact`, `payment.email` | Historical facts about the purchase — kept, because today's user profile may differ from what was entered then. |
| `last_update_date` | datetime | Audit timestamp. | `payment.updatedAt` | — |

---

## 3. What is *not* in the legacy data

Not invented here:

- no plan price snapshot on the enrollment (only the paid `amount`)
- no coupon id on the payment — only a code
- no refund, cancellation or renewal fields
- no per-enrollment status, expiry job or usage counter
- no `coach_name`, `plan_name`, `username` or `phone` on the enrollment: every
  legacy read joins for them, so they are relationships, not stored data

---

## 4. Coupon: code only, and codes are not unique

`PaymentDAL.CreateTransaction` writes `coupon_code` and never a coupon id, so
the legacy data does not record *which* coupon row was used.

`m_coupon` contains a genuine duplicate: `GOGETFIT10` exists twice
(`coupon_id` 4, 10 — "New Year Offer" 10% and "Summer Shredd Offer" 10%). A
code lookup is therefore not safe in general.

In the staging data the only code used by an enrollment payment is
`GGFLAUNCH10`, which is unique in `m_coupon` (`coupon_id` 3). So every enrolled
row resolves unambiguously today.

Migration rule:

1. blank code → `couponId: null`, no conflict
2. exactly one `m_coupon` row with that code → resolve to that coupon's
   `Coupon._id` via `Coupon.legacy.couponId`
3. more than one → **ambiguous**: `couponId` stays null, the code is preserved
   in `legacy.couponCode`, and the row is reported. Nothing is picked.
4. no `m_coupon` row at all → reported as missing, code preserved

---

## 5. Coach: the unfinished mapping

`t_enrollment.coach_id` is `m_coach.coach_id` — proven by the joins, not
assumed. Staging uses two coaches: 13 (Prajwal A T,
`prajwal@gogetfitonline.com`) with 42 enrollments and 17 (Karthik M,
`karthik@gogetfitonline.com`) with 41.

The new `Coach` model has **no legacy identity field**: coaches were created in
the new portal, not migrated. So there is no verified mapping from
`m_coach.coach_id` to `Coach._id`.

Migration rule: `coachId` is left `null` and `legacy.coachId` always preserves
the original number, with the row reported as an unmapped coach. Nothing is
invented and no current coach is assigned.

An opt-in `--link-coaches-by-email` flag resolves a coach only when the legacy
`m_coach.email` matches exactly one new `Coach`'s user email. On today's data
that links legacy coach 13 (42 rows) to the existing Prajwal coach and leaves 17
(41 rows) unmapped, because Karthik has no coach document. When a coach is
linked this way the document records `legacy.coachResolvedBy: 'email'`, so an
inferred link is never mistaken for a legacy-proven one.

---

## 6. Historical values worth keeping

Kept because they are facts about the purchase that today's documents cannot
reproduce:

- `payment.amount` / `currency` — what was actually charged
- `payment.customerName` / `contact` / `email` — the billing identity as typed
- `legacy.enrollmentAmount` — the enrollment's own copy of the amount
- `legacy.couponCode` — the code as typed, even when it resolves to a coupon
- `payment.originalAmount` / `discountPercent` — preserved as the zeros they
  are, so nobody later mistakes a computed figure for legacy truth

Not kept: plan name, coach name, user name, coupon name. Those are joins in the
legacy reads too, and the referenced documents already hold them.

---

## 7. Dates, confirmed by code rather than by column name

| Field | What it means | Set by |
|---|---|---|
| `enroll_date` | purchase date | `CreateBooking`, from the client payload |
| `start_date` | the day after the member pressed Start | `SpawnBooking` |
| `end_date` | `start_date + package.duration` weeks | `SpawnBooking` |
| `payment_date` | when the payment row was written | `CreateTransaction` |
| `last_update_date` | audit | both |

There is no renewal, cancellation or expiry date anywhere in the legacy schema.
An unparseable date is reported and the raw value preserved rather than guessed.

---

## 8. Known conflicts in the staging data

| Condition | Rows | Handling |
|---|---|---|
| `user_id` not in `m_user` (196, 197, 199) | 5 enrollments (58, 59, 60, 61, 62) | Skipped and reported. No user is invented. |
| coach 17 has no `Coach` document | 41 | Migrated with `coachId: null`, `legacy.coachId: 17`, reported |
| coach 13 not linkable without the opt-in flag | 42 | Same, unless `--link-coaches-by-email` |
| `original_amount` / `discount_percent` are 0 | 83 | Preserved as zero, never back-computed |
| `reference_id` / `description` null | 83 | Preserved as null |
| duplicate coupon code `GOGETFIT10` | 0 enrolled rows affected | Rule 3 above would report it |
