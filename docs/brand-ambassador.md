# Brand Ambassador programme

A member joins, gets a code like `CHI0001`, and friends who buy a plan with it
get a discount. Each verified purchase counts as a referral and earns the
ambassador commission. The ambassador sees **only the count**. Admins see the
full transactions.

Code: `src/models/brand-ambassador.model.js`,
`src/services/brand-ambassador.service.js`,
`src/controllers/brand-ambassador.controller.js`,
`src/routes/ambassador.routes.js`, and the `/ambassadors*` routes in
`src/routes/admin.routes.js`. Tests: `tests/integration/brand-ambassador.test.js`.

## Collections

The existing `users`, `enrolledclients` and `gogetfit_plans` records stay the
source of truth. Nothing personal is copied.

| Collection | One document is | Key constraints |
|---|---|---|
| `brand_ambassador_coupons` | an ambassador and their code, with discount and commission terms fixed at registration | unique `couponCode`, unique `userId` |
| `brand_ambassador_referrals` | one purchase made with a code, with the figures and commission as applied (this is the **commission ledger**) | unique `orderId` |
| `brand_ambassador_sequences` | the last suffix used for a 3-letter prefix (`{ _id: 'CHI', seq: 1 }`) | `_id` |
| `brand_ambassador_payouts` | a payout an admin recorded for one ambassador and month (amount, date, reference, Paid or Processing) | unique ambassador + month |
| `brand_ambassador_activities` | one append-only audit event (actor, before, after) | none |

Each enrollment bought with a code also stores `ambassadorCouponId`. The
backend sets it from its own coupon record.

**Migrations:** none needed. The collections start empty, and indexes are
created by Mongoose `autoIndex` (or `Model.syncIndexes()`).

**Rollback:** drop the five `brand_ambassador_*` collections and `$unset`
`ambassadorCouponId` on `enrolledclients`. No existing field is changed.

## Coupon generation

The prefix is the first three letters of the name, upper-cased with accents
folded:
- "Chinmay K T" gives `CHI`.
- A name with fewer than three letters is padded with X ("Al" gives `ALX`).
- A name with no letters gives `GGF`.

The suffix comes from an atomic `$inc` on the prefix's sequence and is padded
to 4 digits.

A code already used by another ambassador or by an admin coupon is skipped.
Admin coupon create and update also refuse a code an ambassador holds.

Registration is idempotent:
- An existing ambassador gets their existing code back.
- Concurrent requests resolve to one record through the unique `userId` index.
- A code is never regenerated, not even after a name change.

## APIs

Member APIs. The owner always comes from the token; neither takes a user id.

| Route | Returns |
|---|---|
| `GET /api/ambassadors/me` | `{ ambassador \| null, program }`. The profile is code, status, date, discount, own commission rate and `successfulReferrals`. No customers, orders, plans or payments. |
| `POST /api/ambassadors/register` | Same shape. 201 when created, 200 when already registered. Any body field is refused. |

Admin APIs. Admin role only (`router.use(requireAuth, requireRole('admin'))`).

| Route | Purpose |
|---|---|
| `GET /api/admin/ambassadors` | List with search (name, email, mobile, user id, code), `status`, `joinedWithinDays`, `sortKey`/`sortDir`, paging, and `summary` |
| `GET /api/admin/ambassadors/:id` | Detail: referrals, sales, discounts given, commission earned, paid and payable |
| `PATCH /api/admin/ambassadors/:id/status` | `{ status: Active\|Inactive, reason? }`. Validated and audited; the record is never deleted. |
| `GET /api/admin/ambassadors/:id/referrals` | Full transactions: customer, coupon, plan, order, payment, referral. Filters: search, plan, payment status, referral status, date range. Also returns the plan filter options. |
| `GET /api/admin/ambassador-referrals/:id` | One transaction |
| `PATCH /api/admin/ambassadors/:id/commission` | `{ commissionPercent, reason? }`. Must be within the published range. Applies to future referrals only; existing ledger lines keep their rate. Audited. |
| `GET /api/admin/ambassadors/:id/payouts` | Monthly periods from the ledger, with any recorded payout and whether one can be recorded |
| `POST /api/admin/ambassadors/:id/payouts` | `{ period: yyyy-mm, amount, paidAt: yyyy-mm-dd, reference, status: Paid\|Processing }`. Only for a month that has ended, and the amount must equal that month's net payable. Paid settles the month's commission lines. Audited. |
| `GET /api/admin/ambassadors/:id/activity` | Audit trail |

## Checkout and attribution

A code typed at checkout goes to the existing quote and purchase endpoints as
`couponCode`. `resolveMemberCoupon` checks admin coupons first, then ambassador
codes. An ambassador code:
- must be active, and its owner's account must be active;
- cannot be used by its own ambassador (`AMBASSADOR_SELF_REFERRAL`);
- is priced by the server at the discount stored on the record (5%), using the
  existing `priceAfterCoupon`;
- is one coupon per purchase, the same rule as today, so codes never stack.

Inside the purchase transaction, the enrollment gets `ambassadorCouponId` and
`recordReferralForEnrollment` creates the referral. The order and its
attribution are written together or not at all.

`recordReferralForEnrollment(enrollmentId)` is the single attribution hook:
- **successful** when the order's `payment.status` is `Success`, **pending**
  when it is `Pending`, and nothing at all for any other status (e.g. `Failed`);
- stamped `paymentVerification: 'simulated'`, which the admin drawer shows as
  "Simulated (no gateway)";
- idempotent: the unique `orderId` index means retries and duplicate events
  change nothing, except promoting pending to successful once the payment
  succeeds.

The count is always `countDocuments({ referralStatus: 'successful' })`. No
cached counter exists, so there is nothing to reconcile.

> **Payment verification gap.** There is no payment gateway yet. The app makes
> up the payment reference itself, and the purchase records `Success` without
> proof (see `purchaseCartItem` and docs/coach-monthly-slots.md). A referral is
> therefore only as verified as the purchase is. When a gateway arrives:
> 1. Create the order with `payment.status: 'Pending'`; the referral starts
>    pending.
> 2. Have the verified webhook set `Success` and call
>    `recordReferralForEnrollment`.
>
> Nothing else changes.

## Commission and payouts

When a referral is created, it stores:
- the ambassador's own `commissionPercent`;
- `grossCommission = round(paid × rate)`;
- `tdsAmount = round(gross × TDS%)`;
- `netCommission = gross − TDS`;
- `payoutPeriod`, the purchase month in the business timezone.

These values are never recomputed.

Policy is set with environment variables (`AMBASSADOR_*` in `src/config/env.js`):

| Setting | Default |
|---|---|
| Discount | 5% |
| Starting commission | 5% |
| Published range | 5–10% |
| TDS | 10% |
| Payout day | 7th |

New ambassadors get the current values; existing records keep theirs.

Payouts are reported per period. An admin records a payout made outside the
system (bank transfer) for a finished month, with the date, amount, reference
and status:
- **Processing** notes the transfer.
- **Paid** settles the month's commission lines (`commissionStatus: 'paid'`).

Nothing in GOGETFIT sends money.

## Open decisions

- The starting commission rate (5% default) needs confirming. Admins can now
  change one ambassador's rate.
- Every active plan is eligible for the discount. There is no exclusion list.
- Commission and TDS are rounded to whole rupees.

## No reversal

GOGETFIT has no refunds or cancellations, so a successful referral is final.
There is no reverse action or reversed status. If refunds are ever introduced,
add a reversal that also takes the commission line out of the payable.
