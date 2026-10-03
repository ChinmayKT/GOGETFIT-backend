# Coupons — legacy behaviour (discovery)

Status: **discovery only**. No model, collection, migration or UI has been built.

Sources:
- **[CODE]** legacy source under `Old GGF/ggf` (admin: `gogetfit-admin`, `GGF.DAL`, `GGF.Model`; API: `ggfAPI`, `ggf.Data`, `ggf.Services`) and the legacy Flutter app `Old GGF/GGF flutter/gogetfit/lib`.
- **[DB]** read-only queries against `staging-ggf` (2026-09-29).
- **[REPORT]** analyst reports in `Old GGF/*.md` (prod figures come only from these).
- **[INFER]** reasoning from the above, marked as such.

---

## 1. Tables

### `m_coupon` — the admin-managed coupons **[DB]**

| column | type | null | default | meaning |
|---|---|---|---|---|
| coupon_id | int(11) PK AI | no | | identity |
| coupon_name | varchar(100) | yes | | display name |
| coupon_code | varchar(20) | yes | | code the member types; **no unique index** |
| description | text | yes | | read by the API; **the admin never writes it** |
| discount | varchar(3) | yes | | **percentage, as text** |
| valid_from | varchar(11) | yes | | `dd/MM/yyyy` **text**, inclusive |
| valid_to | varchar(100) | yes | | `dd/MM/yyyy` **text**, inclusive |
| everyone | char(1) | yes | '1' | '1' = listed to all members in the app. **Not checked at redemption** |
| delete_flg | char(1) | yes | '0' | soft delete |
| created_by, last_update_date, last_update_by | audit | | | always "123"; **no create date column** |

Indexes: `PRIMARY(coupon_id)` only.

### `r_user_coupon` — per-user coupons **[DB] [CODE]**
Columns `coupon_code (PK), user_id, coupon_type, coupon_name, description, discount, delete_flg, last_update_*`.
**0 rows** in staging and prod, and **no code reads or writes it**. Dead.

### Coupon-related columns elsewhere **[DB]**
| column | meaning |
|---|---|
| `t_payment.coupon_code varchar(20)` | code on the payment (see §11 — not written by the current app) |
| `t_payment.discount_percent int(3)` | percentage applied |
| `t_payment.original_amount int` | price before discount |
| `t_payment.amount int` | amount recorded |
| `m_user.brand_ambassador_code varchar(15)` | the user's own referral-style code, `GBC` + 7 digits |
| `m_user.renewal_code varchar(15)` | the user's own renewal code, `GRC` + 7 digits **[CODE/REPORT]** |
| `m_member.brand_ambassador_code` | table exists, **0 rows**, unused |

`t_enrollment` has **no coupon column at all**.

---

## 2. Coupon kinds

There are three kinds, found by a fallback chain in `BookingService.VerifyCoupon` (m_coupon → ambassador → renewal; first hit wins) **[CODE]**:

| kind | stored in | discount | date window | reuse check |
|---|---|---|---|---|
| Admin coupon | `m_coupon` | `m_coupon.discount` % | yes | once per user (see §7, ineffective) |
| Brand-ambassador code | `m_user.brand_ambassador_code` (owner) | **5%** applied (hard-coded) — but **10%** advertised by `GetUserCoupons` | none | none |
| Renewal code | `m_user.renewal_code` (owner) | **10%** (hard-coded) | none | none ("one time usable" is claimed, not enforced) |

Ambassador "5% cashback to the owner" is advertised in copy and **implemented nowhere** **[CODE]**.

---

## 3. Admin CRUD (`/Coupon/*`) **[CODE]**

**List** (`CouponList.cshtml`, Tabulator, local paging 10): Coupon Name, Coupon Code, Discount, Valid From, Valid To, Everyone (Yes/No); header filters; Edit and Delete icons; "Add Coupon".
SQL: `... from m_coupon a where a.delete_flg = '0' order by a.coupon_id desc`.

**Create / Edit** (`AddCoupon.cshtml`):
| label | field | rule |
|---|---|---|
| Coupon Name * | coupon_name | `[Required]` |
| Coupon Code * | coupon_code | `[Required]` (placeholder copy bug: "Enter Coupon Name") |
| Discount * | discount | `[Required]`, free text — no numeric/range check |
| Valid From * / Valid To * | valid_from / valid_to | free text, **not actually required**, no format check |
| Status * | everyone | select Yes(1)/No(0), default Yes — it is the *everyone* flag, mislabelled |

- No duplicate-code check anywhere; no unique index.
- `description` is never written. `created_by`/`last_update_by` hard-coded to 123.
- Messages: "Coupon Added Successfully" / "Coupon Add Failed" / "Coupon Updated Successfully" / "Coupon Update Failed" / "Coupon Deleted Successfully" / "Coupon Delete Failed".
- Edit loads `where coupon_id = X and delete_flg = '0'` and updates every field.
- **Delete = soft delete**: `update m_coupon set delete_flg = '1' where coupon_id = X` — a GET link, **no confirmation**, **no restore**.
- View action points at a view that does not exist.

---

## 4. Validation rules at redemption (`POST api/VerifyCoupon`) **[CODE]**

Body `{ Amount, CouponCode, LoginToken }`. For an `m_coupon` code, **enforced**:
1. code exists (exact match via SQL; case sensitivity depends on the MySQL collation — **not verified**),
2. `delete_flg = '0'`,
3. `CURDATE()` between `STR_TO_DATE(valid_from,'%d/%m/%Y')` and `STR_TO_DATE(valid_to,'%d/%m/%Y')`, inclusive, DB-server timezone,
4. not already on a `t_payment` row for this user with `status = 'Success'`.

**Not enforced** (no field exists): `everyone`/user restriction, global usage limit, per-plan restriction, minimum amount, maximum discount.

Responses: success `{ couponVerified: true, originalAmount, discount: "N%", finalAmount, data, responseContext{ message: "Coupon is verified" } }`; failure `{ isCouponVerified: false, responseContext{ message: "Coupon invalid" } }` (different key). Exceptions return HTTP 200 with the exception text.

---

## 5. Discount rules **[CODE]**

- **Percentage only.** No flat-amount type.
- Server-side: `finalAmount = Amount - Amount * discount / 100` with **integer** arithmetic → the discount is truncated (₹4,999 at 10% → ₹4,500).
- No cap; 100 → ₹0. A non-numeric discount (a `'99%'`-style value is reported in prod) throws.
- The app always verifies against the plan's `base_price`.

## 6. Expiry rules
Inclusive `valid_from`..`valid_to` on the DB server's date. A malformed date string makes `STR_TO_DATE` return NULL and the coupon **silently never validates**. Ambassador and renewal codes never expire.

## 7. Usage rules
No counter, no max uses, no per-user table in use. The only rule is "not already on a successful payment by this user", which is **ineffective** because the current app never writes `t_payment.coupon_code` (§11). In practice, admin coupons are reusable without limit.

## 8. Plan restrictions
**None.** Any coupon applies to any package.

## 9. User restrictions
**None at redemption.** `everyone='0'` only hides a coupon from the in-app list; anyone who knows the code can redeem it. Anyone can use any user's ambassador or renewal code, including their own.

## 10. Status behaviour
`delete_flg` is the only state (0 active / 1 deleted). There is no active/inactive toggle; the "Status" field on the form is the *everyone* flag. Validity is only the date window.

---

## 11. Relationship with payment and enrollment — the critical finding **[CODE] [DB]**

Flow:
```
Admin creates m_coupon
  → app lists public coupons (GET api/GetUserCoupons; everyone='1', in window, not used)
  → member types a code at checkout → POST api/VerifyCoupon → finalAmount
  → Razorpay is charged finalAmount (client-side; no server order/verification)
  → app calls POST api/CreateBooking with Amount = the UNDISCOUNTED base price,
    and WITHOUT CouponCode / Discount / OriginalAmount
  → t_payment: coupon_code '', discount_percent 0, original_amount 0, amount = base price
  → t_enrollment: amount = base price, no coupon column
```

**Consequence: coupon usage is not recorded for bookings made by the current app.** The database cannot tell whether a discount was given.

Staging evidence **[DB]**:
- `t_payment`: 120 rows (all `Success`); 31 carry `coupon_code = 'GGFLAUNCH10'`, but 29 of those record 0/NULL discount and the **full** price; only 2 record 10% — one ₹4,500, one ₹4,999 (inconsistent). These look like an older app build / test data.
- Every `t_payment.coupon_code` value exists in `m_coupon`.
- No payment without a coupon code is below the package price.
- `original_amount` is populated on 85 rows but is `0` on almost all of them.

Prod **[REPORT]**: `discount_percent` is 0 except 2 rows; `t_payment.coupon_code` has 2 distinct values across 1,205 payments.

The only way to recover real discounts is **outside the database**: compare Razorpay's captured amount for each `pay_…` `transaction_id` with the recorded amount. Even then, a percentage cannot identify *which* code (several share 10%). **[INFER]**

After every booking, `UpdateCouponCode` sets the booker's ambassador code if empty and **always rotates their renewal code**. **[CODE]**

---

## 12. Row counts

| table | staging **[DB]** | prod **[REPORT]** |
|---|---|---|
| m_coupon | 15 (5 deleted, 10 live) | 87 |
| r_user_coupon | 0 | 0 |
| t_payment with coupon_code | 31 of 120 | 2 distinct codes |
| m_user with ambassador code | 60 of 482 (all unique, `GBC…`) | 929 users have both ambassador and renewal codes |

## 13. Data-quality issues
1. **Duplicate coupon codes**: `GOGETFIT10` is ids 4 (deleted) and 10 (live) **[DB]**. No uniqueness rule exists.
2. `discount` is text; a `'99%'`-style value is reported in prod **[REPORT]**.
3. Dates are free text (`dd/MM/yyyy`); staging values all parse, prod unverified.
4. `description` is almost always NULL; one row holds `"d"` **[DB]**.
5. Truncated names (`"Anand (Shop"`, `"Gaalappa (Siddharth"`) **[DB]**.
6. Payment-side coupon data is unreliable (§11).
7. Ambassador discount: 5% applied vs 10% advertised.
8. SQL injection in every coupon query; no admin auth; client-supplied `Status='Success'`.

---

## 14. Migration requirements and dependencies

### Recommended MongoDB architecture (proposal — not implemented)
- **`coupons`** collection for admin coupons:
  `code` (normalised uppercase, trimmed), `name`, `description`, `discount: { type: 'percent', value }`, `validity: { from, to }` as real dates, `visibility: 'public' | 'private'` (the `everyone` flag, named for what it does), `status: 'active' | 'archived'` (from `delete_flg`), `legacy: { source, couponId, createdBy, updatedAt, updatedBy }`, `migration`, audit fields.
  - **Uniqueness**: unique index on `code` among **active** coupons (partial index), because legacy contains an archived + live duplicate. Decide explicitly.
  - Fields for rules legacy never had (usage limit, per-user limit, plan restriction, min amount, max discount) should be **new, optional, and default to "no limit"**, so migrated coupons behave exactly as before.
- **Ambassador / renewal codes** stay **per user** (not rows in `coupons`): e.g. `User.codes.brandAmbassador`, `User.codes.renewal`, with their fixed percentages as configuration — and the 5% vs 10% discrepancy resolved by the business first.
- **Redemption record** (new, the thing legacy lacked): whatever EnrolledClient/payment becomes must store `coupon: { kind: 'coupon'|'ambassador'|'renewal', code, couponId?, ownerUserId?, percent, originalAmount, discountAmount, finalAmount }` as a **snapshot**, computed and verified on the **server**.

### What migration must do
1. Migrate `m_coupon` → `coupons` idempotently by `legacy.couponId`: parse text dates, parse `discount` to an integer (report non-numeric values rather than guess), map `delete_flg` → status, `everyone` → visibility; preserve verbatim name/code; report duplicate codes.
2. Migrate ambassador/renewal codes as part of the **user** records (a user backfill), checking uniqueness.
3. Do **not** migrate `r_user_coupon` or `m_member` (0 rows).
4. For historic payments: carry `t_payment.coupon_code`, `discount_percent`, `original_amount` **as recorded**, flagged as unreliable. Do not infer discounts from amounts (they cannot be inferred from the DB).

### Exact dependencies before EnrolledClient migration
1. **Coupons collection** migrated, with a stable `legacy.couponId` → new id map, so an enrollment/payment can reference a coupon.
2. **User ambassador and renewal codes** migrated, so a historic redemption of those codes can be attributed to an owner.
3. **Decisions from the business**:
   - whether historic enrollments should record *any* coupon (the DB mostly cannot say),
   - whether to reconcile against Razorpay for real paid amounts,
   - the true ambassador percentage (5 vs 10) and whether the promised cashback exists,
   - duplicate-code policy.
4. **Payments (`t_payment`)** understood as the carrier of coupon data: EnrolledClient links to `t_payment` by `transaction_id`, so the payment migration (or at least its coupon fields) must come first or together.
5. Already done: users, GoGetFit Plans (`legacy.packageId`) and coaches exist in MongoDB. Note: legacy coaches (`m_coach`) were **not** migrated (new coaches are created fresh), so `t_enrollment.coach_id` will need a mapping decision too.
