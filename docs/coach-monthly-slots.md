# Monthly coach slots

The rules live in `src/services/coach-capacity.service.js`. The Admin Portal and the app only display what it returns.

## Payment warning: read before taking real money

**Payment is not verified.** `POST /api/users/me/cart/:id/purchase` trusts a `paymentReference` that the app generates itself (`cart_screen.dart`). That reference is not proof of payment, and no gateway is involved.

- Any signed-in member can call the endpoint with a made-up reference and receive an enrollment without paying.
- Each such call also uses one of the coach's monthly slots.
- `payment.status` is written as `Success` on these rows without any check.

Before accepting real online payments, a real gateway with server-side verification is required: the server must confirm the payment with the gateway (signature or webhook) before creating the enrollment. The capacity check also runs at confirmation today, so a slot must be held before charging, or a customer can pay and then be refused because the coach is full.

Admin manual enrollments are a separate case: an admin records money collected outside the app.

## Rules

| Rule | Behaviour |
| --- | --- |
| Allocation | `Coach.profile.monthlySlots`. Required on a new coach. Null on older coaches, which stay unlimited until an admin sets it |
| Confirmed booking | An enrollment. Customer purchases and admin manual enrollments both use one slot |
| Accounting month | `capacityAccountingMonth` is the business month the enrollment was created in (Asia/Kolkata by default), whatever its `enrollDate` |
| Older enrollments | Have no `capacityAccountingMonth`, are never rewritten, and count in the month of their `enrollDate` |
| Daily release | 9 first, then 3 each time a batch sells out, never more than the month has left. Starts again at 9 each business day |
| Today's batch | Goes by `enrollDate`, so a backdated enrollment uses a monthly slot but not today's batch |
| Full coach | `409 COACH_FULLY_BOOKED`. Existing bookings are never touched when capacity is lowered |
| New month | Automatic, because the month comes from the clock. There is no job to run |

## Concurrency

Every booking transaction writes the coach's `coachmonthlycapacities` record for the month. Two bookings therefore conflict, MongoDB aborts one, and `withTransaction` retries it on a snapshot that includes the other's enrollment.

## Known limits

- A month with no bookings and no capacity edit has no `coachmonthlycapacities` record, so it does not appear in the portal's history.
- The app's Contact Support action is a "coming soon" message until a real support channel exists.
- A manual enrollment recorded on the last day of a month with a future date in the next month uses the earlier month's capacity and is not counted in that later day's batch.
