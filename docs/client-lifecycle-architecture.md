# Client lifecycle & coaching data architecture — discovery report

Read-only discovery across the Flutter app, the Node/MongoDB backend, the Admin
Portal and the legacy ASP.NET/MariaDB system. **Nothing was implemented or
modified.** Legacy figures come from read-only queries against `staging-ggf`.

Every section separates **FACT** (found in code or data), **PROPOSED**
(architecture suggestion) and **OPEN QUESTION** (needs a decision).

---

## 1. Executive summary

**FACT.** The single most important finding: **no coaching-cycle entity exists in
the new backend at all.** There is no questionnaire, body-metrics, assigned diet
plan, assigned workout plan, food log or workout log model, collection, route,
controller or service. The new backend has nine models:

```
coach · coupon · enrolled-client · food · free-diet-plan
gogetfit-plan · migration-conflict · otp · user · workout
```

**FACT.** `EnrolledClient` already exists and already carries
`userId`, `planId`, `coachId`, `couponId` and an embedded `payment`. It is the
natural anchor for the lifecycle, and the coach → clients query it needs is
already supported by its filter builder.

**FACT.** The pieces that look finished in the app are demo-backed:
- the questionnaire has a complete 39-question, 5-step fill flow **with no API**;
- body metrics are served by `demo_client_body_metrics.dart`;
- checkout runs a **simulated** payment — there is no gateway and no payment SDK
  in `pubspec.yaml`.

**FACT.** Legacy never modelled an enrollment-scoped coaching cycle. **No legacy
lifecycle table carries an enrollment id.** Questionnaire, metrics, diet plans,
workout plans and food logs are keyed by `user_id` alone, and `m_user.coach_id`
holds one current coach that is overwritten.

**Consequence.** The enrollment-scoped architecture in the brief is **new work,
not a migration of an existing shape**. That is good news for the design and bad
news for history: legacy data cannot be attributed to a specific enrollment
without an inference rule (see §21).

---

## 2. Current user flow

**FACT — Flutter** (`lib/core/network/api_endpoints.dart`): the app knows only
these endpoints.

```
/auth/request-otp     /auth/verify-otp
/users/me             /users/me/profile      /users/me/profile-picture
/free-diet-plans/:id
/coaches              /coaches/:id           /coaches/:id/plans
```

**FACT — backend** (`src/routes/index.js`, `src/routes/user.routes.js`):

```
router.use('/auth', authRoutes)     router.use('/users', userRoutes)
router.use('/free-diet-plans', …)   router.use('/coaches', …)
router.use('/admin', adminRoutes)

GET    /users/me                     requireAuth
PATCH  /users/me/profile             requireAuth
PUT    /users/me/profile-picture     requireAuth
DELETE /users/me/profile-picture     requireAuth
```

So the implemented member surface is: phone → OTP → JWT → profile (name, DOB,
gender, city) → avatar → read coaches/plans → read one free diet plan.

**FACT.** Storage is `users.profile` plus `users.profile.fitnessProfile`
(`src/models/user.model.js:39-61`): `height`, `weight`, `bodyFatPercentage`,
`activityLevel`, `foodType`, `goal`, `bmr`, `tdee`. The model's own comments say
bmr/tdee are carried from legacy and never recalculated.

**Not implemented:** any member-facing purchase, enrollment, questionnaire,
metrics or logging endpoint.

---

## 3. Current purchase flow

**FACT — Flutter.** `cart_screen.dart:122-160`:

> "Runs the (simulated) payment … **No gateway is wired yet** — the delay stands
> in …"

`_pay()` waits, then `pushReplacement(AppRoutes.paymentSuccessPath)`.
`payment_success_screen.dart:133` then offers
`context.push(AppRoutes.questionnaireIntroPath)`.

**FACT.** `pubspec.yaml` contains **no Razorpay/Stripe/payment package**.

**FACT — backend.** There is no payment route, no payment service, no gateway
integration and no member-facing enrollment creation. The only way an
`EnrolledClient` is created is **`POST /api/admin/enrolled-clients`** — the
admin "Add Client" flow, gated by `requireAuth + requireRole('admin')`.

**Answers to the questions asked:**

| Question | Answer |
| --- | --- |
| Exact event that creates an Enrollment | An **admin** posting to `/api/admin/enrolled-clients`. No app-driven path exists. |
| Atomic with payment? | **No payment exists.** The admin endpoint records a manual payment inside the same document write, so that part is atomic by virtue of being one document. |
| Payment succeeds, enrollment fails | **Cannot occur today** — undefined behaviour to be designed. |
| Questionnaire not completed | Nothing depends on it; no backend state exists. |
| User closes app after payment | Nothing was persisted — the "payment" was a timer. |

**FACT — fields already on `EnrolledClient`** (`src/models/enrolled-client.model.js`):
`userId`, `planId`, `coachId`, `couponId`, `enrollDate`, `startDate`, `endDate`,
`hasStarted`, `isDeleted`, `payment{transactionId, amount, currency,
originalAmount, discountPercent, status, paidAt, referenceId, method, notes,
customerName, contact, email}`, `legacy{…}`, `createdBy`, `updatedBy`.

---

## 4. Current enrollment architecture (multi-enrollment)

**FACT.** Multiple enrollments per user are **allowed and expected**. The model's
own comment: *"A member has as many of these documents as they have purchases."*
There is no unique index on `userId`; the only unique index is
`(legacy.source, legacy.enrollmentId)`, partial.

**FACT — legacy data confirms the pattern:**

| Enrollments per user | Users |
| --- | --- |
| 1 | 46 |
| 2 | 11 |
| 3 | 5 |

**FACT.** Same plan twice, same coach twice, and overlapping windows are all
permitted — nothing validates against them.

**FACT.** "Active" is **computed, never stored** (`enrollmentStatus()`):

```js
if (isDeleted) return 'deleted';
if (!hasStarted || !endDate) return 'not_started';
return endDate < now ? 'inactive' : 'active';
```

**FACT.** How each surface finds the current enrollment:
- **Flutter** — it does not. There is no enrollment endpoint; the app has no
  concept of the user's purchased plan.
- **Admin Portal** — `/users/clients` lists enrollments from
  `GET /api/admin/enrolled-clients`, one row per purchase.
- **Coach Portal** — **does not exist** (see §9).

---

## 5. Legacy questionnaire + body metrics

**FACT.** They are **one table**, exactly as the brief suspected:
`m_user_questionnaire`, **136 rows, 66 distinct users**.

- **Primary key: `(user_id, create_date)`** → multiple submissions per user are
  possible and happen.
- **Answers are columns, not JSON** — ~40 question columns.
- **Body metrics live in the same row**: `height`, `weight`, `waist`, `neck`,
  `hips`, `fat`, `bmr`, `tdee`.
- Also carries `front_image`, `back_image`, `side_image`, and `coach_name` as
  **free text** — not a coach id.
- **There is no enrollment id, no package id and no coach id.**

| Submissions per user | Users |
| --- | --- |
| 1 | 28 |
| 2 | 21 |
| 3 | 12 |
| 4 | 3 |
| 6 | 1 |
| 12 | 1 |

**FACT.** The multiples are **not** coaching cycles. User 162 has 12 submissions
between 2023-01-04 and 2023-01-07; user 336 has 6 within two hours. These are
re-submissions/corrections, not per-enrollment questionnaires.

**FACT — where it is written and read:**
- write: `api/ggf.Data/RegisterDAL.cs:340` (INSERT), `:481` (UPDATE) → so **the
  user could edit after submitting**;
- read: `api/ggf.Data/UserDAL.cs:264, 310, 349, 540, 567` and
  `api/ggf.Data/CoachDAL.cs:247` → **the coach does see it**.

**FACT — separate progress table.** `m_user_updates`, PK `(user_id, update_date)`,
**1302 rows**: `weight`, `waist`, `neck`, `hips`, three photos,
`calorie_intake`/`fat`/`carbs`/`protein`, `calorie_out`, `bmr`, `tef`, `eat`,
`neat`, energy scores, `remarks`. This is the historical metrics series.

**Not defined by legacy:** partial/draft save, any link between a submission and
a purchase, and any rule about which submission a coach should read.

---

## 6. Current Flutter questionnaire

**FACT.** Substantial and well structured — and entirely local.

```
lib/features/questionnaire/
  domain/      questionnaire_question.dart · questionnaire_step.dart
               questionnaire_submission.dart · questionnaire_progress.dart
  data/        questionnaire_submission_repository.dart
  presentation/ questionnaire_intro_page · questionnaire_flow_page
                questionnaire_view_page · questionnaire_history_page
```

- **39 `QuestionDef` entries** across **5 steps**: `basics`, `nutrition`,
  `fitness`, `health`, `goals`.
- Keys: `gender, age, height, weight, goal, city, profession, highestWeight,
  contactTime, foodPref, triedDiet, dietDetails, foodRoutine, foodsLike,
  foodsDislike, specialFood, allergies, workoutPref, workoutDuration,
  trainingLevel, cardioLevel, injuries, dailyRoutine, medications, sickFreq,
  coldFreq, digestiveFreq, digestiveHealth, alcohol, smoke, bodyShaming,
  periodCramps, moodSwings, cognitive, cravings, whyTransform, longTermGoal,
  expectFromCoach`.
- Answer types: `singleChoice`, `wheel`, `slider` (0-10, stored `int`),
  `shortText`, `longText`. Conditional visibility exists (`femaleOnly`,
  `parentKey`).
- **Drafts work**: answers are persisted locally and the flow resumes, then
  clears on submit (`questionnaire_flow_page.dart:32`).
- **The repository is `DemoQuestionnaireSubmissionRepository`** — three
  hardcoded submissions. The interface comment says swapping in an API
  implementation "touches one provider and no UI".

**FACT.** Payment success → questionnaire intro navigation exists, and it is a
tap, not a gate — **the questionnaire is skippable** and reachable later from
history.

**Not implemented:** any submission API, any server persistence, any
enrollment association.

---

## 7. Current Flutter body metrics

**FACT.** `lib/features/body_metrics/` with `body_metrics_record.dart`,
`body_metric.dart`, `body_composition.dart`, plus guided-camera progress photos.
Providers import `demo_client_body_metrics.dart` and
`demo_client_weekly_updates.dart`; the source comments say *"Demo-backed; swap
for an API later."*

**FACT — BMR/TDEE today.** They live on **`users.profile.fitnessProfile`** as a
single current value, not as a history. The naming is already `tdee`; **`rdee`
was renamed out of the system** in an earlier migration.

**OPEN QUESTION.** Whether BMR/TDEE should remain a profile-level current value,
become a per-measurement snapshot, or both. Legacy did **both** —
`m_user_questionnaire.bmr/tdee`, `m_user_updates.bmr`, `m_user.bmr/tdee` and
`m_diet_plan.bmr/tdee` all exist. Recommendation in §14.

---

## 8. Current backend questionnaire / metrics

**FACT. Not implemented.** No model, route, controller, service, validator or
test for questionnaire, body metrics, measurement, assessment or transformation.
No such Mongo collection exists. The only overlap is the eight-field
`fitnessProfile` sub-document on `User`.

---

## 9. Coach → client flow

**FACT.** The backend can already answer the query the brief describes.
`enrolled-client.service.js:214` `buildMatch({ userId, coachId, planId, couponId,
status, hasStarted })` — so `coachId → enrollments → users` works today via
`GET /api/admin/enrolled-clients?coachId=…`, with the User joined by `$lookup`.

**FACT.** But it is **admin-only**. `admin.routes.js` applies
`requireAuth, requireRole(ROLE_ADMIN)` with `router.use`, so a coach cannot call
it. There is **no coach persona, no coach login, no coach dashboard** in the
Admin Portal — `src/features/coaches/` is *coach management* (list, detail, form,
certificates, images), not a workspace for a coach.

**FACT.** The Flutter app has `lib/features/coach_workspace/` with
`coach_clients_data.dart` and `assigned_plan_repository_impl.dart` — demo data,
and the questionnaire demo submissions use its client ids (`c2` = Rohit Sharma).

**So:** "How should Coach Prajwal find users who purchased Prajwal's plan?" — the
data path exists and is correct; the authorization path and the UI do not.

---

## 10. Diet plan architecture

**FACT — new backend.** `FreeDietPlan` is a **reusable template**, not an
assigned plan: keyed by diet type + calorie band, with no `userId`. The member
link is a single pointer `users.profile.freeDietPlanId`, and the model comment
says *"There is deliberately no history here."*

**There is no assigned/coach-authored diet plan model.** No `userId`,
`enrollmentId` or `coachId` anywhere in diet-plan code.

**FACT — legacy.** `m_diet_plan` (178 rows): `diet_plan_id`, `diet_plan_name`,
**`user_id`**, `total_calories`, `fat`, `carbs`, `protein`, `bmr`, `tdee`,
`goal`. Children: `r_diet_plan_dates` (7404) and `r_diet_plan_meal` (1173,
referencing `meal_id` + `food_id`). **No enrollment id, no coach id.** One user
has 34 diet plans — plans are per-period, not per-cycle.

**Must change later:** a new `DietPlan` (assigned) collection is required; there
is nothing to retrofit.

---

## 11. Workout plan architecture

**FACT — new backend.** `Workout` exists (188 migrated, §: `workouts-legacy.md`)
as the **exercise library**. There is **no workout plan model**.

**FACT — Flutter.** `lib/features/coaches/domain/workout_plan.dart` states in its
own header: *"No backend/API for coach-authored workout content exists yet —
nothing here is persisted."*

**FACT — legacy.** `m_workout_plan` (372): `workout_plan_id`,
`workout_plan_name`, **`user_id`** — no enrollment, no coach. Children:
`r_workout_plan` (3977: plan + category + workout + `sets_count` + `reps_count`),
`r_workout_plan_category` (1257), `r_workout_plan_dates` (6283).

**Must change later:** new `WorkoutPlan` (assigned) collection required.

---

## 12. Food logs and workout logs

**FACT — legacy food log.** `t_food_log`, **29,748 rows**, PK
`(user_id, meal_id, food_id, log_date)`, with per-entry `calorie/fat/carbs/
protein`, `quantity`, `delete_flg`. Keyed by **user and date — no enrollment**.
Related: `m_user_calorie` (558 rows: daily targets), `t_user_hydration` (182).

**FACT — legacy workout log. Does not exist.** The only `%log%` tables are
`m_login` and `t_food_log`. Workout completion was never recorded.

**FACT — new backend.** Neither exists.

---

## 13. Multi-enrollment behaviour (scenarios)

Assessed against what exists today:

| Scenario | Today | Under the proposal |
| --- | --- | --- |
| **A** registers, never buys | User exists, no enrollment. Correct already. | unchanged |
| **B** buys Plan A | Enrollment only if an **admin** creates it | enrollment created by the purchase |
| **C** skips questionnaire | nothing to skip (no persistence) | enrollment valid; questionnaire completable later |
| **D** completes both | coach cannot see them (demo data) | coach reads via enrollment |
| **E** buys Plan B after A | second enrollment already supported | new questionnaire + metrics under E2 |
| **F** same coach again | allowed, no uniqueness rule | new enrollment, A untouched |
| **G** changes coach | allowed; **legacy overwrote `m_user.coach_id`** | coach lives on the enrollment, so history survives |

Scenario G is the clearest argument for the enrollment-scoped design: legacy
could not answer "who coached this member in 2023?" because the user row held one
mutable coach.

---

## 14. PROPOSED target data model

Validated against the code above. Four new collections, no changes to `User`.

```
users ──┬── enrolledclients (exists)
        │        ├── questionnaires        (new)  userId + enrollmentId
        │        ├── bodymetrics           (new)  userId + enrollmentId + recordedAt
        │        ├── dietplans             (new)  userId + enrollmentId + coachId
        │        ├── workoutplans          (new)  userId + enrollmentId + coachId
        │        ├── foodlogs              (new)  userId + enrollmentId + date
        │        └── workoutlogs           (new)  userId + enrollmentId + date
        └── profile.fitnessProfile (exists, current values only)
```

**Questionnaire (§13 of the brief).** **PROPOSED: do not build a template
system.** The 39 questions are fixed in Flutter source, legacy stored them as
fixed columns, and no admin screen edits them. Over-engineering templates now
buys nothing.

```
questionnaires
  userId, enrollmentId          required, unique together
  answers: Map                  39 keys, mixed String/int — mirrors the Flutter keys
  schemaVersion: Number         so a future question change is detectable
  status: 'draft' | 'submitted'
  submittedAt
```
`schemaVersion` is the cheap insurance; `templateId` is not needed until an
admin can author questions.

**BodyMetrics (§14 of the brief).** **PROPOSED: one collection, many rows per
enrollment**, distinguished by a kind:

```
bodymetrics
  userId, enrollmentId          required
  kind: 'initial' | 'progress'  exactly one 'initial' per enrollment
  recordedAt
  height, weight, waist, neck, hips, bodyFatPercentage
  bmr, tdee                     the snapshot as computed that day
  photos: { front, back, side } { url, storageKey } refs
  recordedBy                    user or coach
```
This satisfies "new initial metrics per purchase" *and* future progress tracking
without a second collection, and it mirrors legacy's split
(`m_user_questionnaire` initial vs `m_user_updates` series) without copying its
inability to attribute a row to a cycle.

**BMR/TDEE duplication — deliberate, and documented.** `fitnessProfile.bmr/tdee`
stays as the member's **current** value (the Free Diet Plan matcher already reads
it). `bodymetrics.bmr/tdee` is the **historical snapshot**. These answer different
questions; keeping only one would break either plan matching or history.

---

## 15. Index recommendations

Each justified by an access pattern above — nothing speculative.

| Collection | Index | Why |
| --- | --- | --- |
| questionnaires | `{userId:1, enrollmentId:1}` **unique** | the "one questionnaire per cycle" rule, enforced by the database |
| bodymetrics | `{userId:1, enrollmentId:1, recordedAt:-1}` | the progress series for one cycle, newest first |
| bodymetrics | `{enrollmentId:1, kind:1}` partial on `kind:'initial'`, unique | one initial snapshot per enrollment |
| dietplans | `{userId:1, enrollmentId:1}` | the plans of one cycle |
| workoutplans | `{userId:1, enrollmentId:1}` | same |
| foodlogs | `{userId:1, date:-1}` | the member's diary — the dominant read |
| foodlogs | `{enrollmentId:1, date:-1}` | the coach's view of one cycle |
| workoutlogs | same two | same reasons |
| enrolledclients | `{userId:1, enrollDate:-1}` · `{coachId:1, enrollDate:-1}` | **already exist** |

Deliberately **not** indexed: `coachId` on plans/logs — it is reachable through
the enrollment, and a redundant index costs every write.

---

## 16. Ownership and authorization rules

| Record | Create | Update | Read |
| --- | --- | --- | --- |
| Questionnaire | User | User (until submitted) | User, their Coach, Admin |
| BodyMetrics `initial` | User | User | User, Coach, Admin |
| BodyMetrics `progress` | User or Coach | author | User, Coach, Admin |
| DietPlan | Coach | Coach | User, Coach, Admin |
| WorkoutPlan | Coach | Coach | User, Coach, Admin |
| FoodLog / WorkoutLog | User | User | User, Coach, Admin |
| Enrollment | Admin (today), purchase (later) | Admin | all three |

**PROPOSED rule, non-negotiable in implementation:** never trust `userId` or
`enrollmentId` from the client.
- `userId` comes from the JWT.
- `enrollmentId` is accepted but **verified**: `enrollment.userId === req.user._id`.
- For coach actions: `enrollment.coachId === authenticatedCoach._id`.

**OPEN QUESTION.** May a coach edit a member's questionnaire or metrics, or only
read them? Legacy let the *user* edit (`RegisterDAL.cs:481`) and let the coach
read (`CoachDAL.cs:247`) — **legacy does not define coach-edit**.

---

## 17. API requirements (not implemented)

Following existing conventions (`/users/me/...` for members, `/admin/...` for the
portal, `{success, data}` envelope, `requireAuth` + `requireRole`).

**Member**

| Endpoint | Purpose | enrollmentId source |
| --- | --- | --- |
| `GET /users/me/enrollments` | the member's cycles, current first | — |
| `GET/PUT /users/me/enrollments/:id/questionnaire` | fill / resume / submit | route, verified against JWT user |
| `GET/POST /users/me/enrollments/:id/body-metrics` | initial + progress | same |
| `GET /users/me/enrollments/:id/diet-plan` | read assigned plan | same |
| `GET /users/me/enrollments/:id/workout-plan` | read assigned plan | same |
| `GET/POST /users/me/food-logs?date=` | diary | derived from the active enrollment |
| `GET/POST /users/me/workout-logs?date=` | diary | same |

**Coach** — needs a new `/coach` surface with `requireRole('coach')`:
`GET /coach/clients`, `GET /coach/clients/:enrollmentId`,
`.../questionnaire`, `.../body-metrics`, and
`POST/PUT .../diet-plan`, `.../workout-plan`.

**Purchase** — `POST /users/me/checkout` then a **gateway webhook** that creates
the enrollment. The webhook, not the app, must be the source of truth.

---

## 18. Gaps

**Already implemented:** User + OTP auth + profile; Coach CRUD; GoGetFit Plans;
Coupons; EnrolledClient (incl. coach/user/plan/coupon filters); Food (960);
Workout (188); Free Diet Plan templates + matching.

**Partially implemented:** enrollment (admin-created only, no purchase path);
coach→client query (data path yes, authorization and UI no).

**Mock only:** Flutter questionnaire submissions, body metrics, coach workspace,
workout plan; portal coach certificates.

**Legacy only:** questionnaire + metrics data (136 + 1302 rows), diet plans
(178), workout plans (372), food logs (29,748).

**Not implemented anywhere:** workout logs — **legacy never had them either**.

**Needs architectural change:** every lifecycle entity must gain
`enrollmentId`; coach must become an authenticated persona.

**Potentially dangerous / ambiguous:**
1. Legacy rows cannot be attributed to an enrollment — any migration must infer
   by date window and **report** the inference, never silently guess.
2. `m_user.coach_id` is a single mutable field: legacy coach history is already
   lost for members who changed coach.
3. The simulated payment means "paid" currently has no evidence anywhere.
4. 12 questionnaires in 3 days for one user shows legacy had no submission rule.

---

## 19. Open questions

1. Does completing the questionnaire **gate** anything, or stay advisory?
2. Can a coach edit a member's questionnaire/metrics, or only read?
3. When a member has two active enrollments, which is "current" for the diary?
4. Should legacy questionnaires/metrics be migrated at all, or does the new
   system start clean from the first new enrollment?
5. Which payment gateway, and is the webhook or the client the trigger?
6. Can a member re-submit a questionnaire within one enrollment (legacy allowed
   it), or is it one-and-done?

---

## 20. Recommended implementation order

1. **Enrollment read API for members** (`GET /users/me/enrollments`) — everything
   else needs an enrollment id, and this needs no new collection.
2. **Questionnaire** — model, member API, wire the existing Flutter flow to it.
   Highest product value, lowest risk, and the UI already exists.
3. **Body metrics** — model + initial snapshot at enrollment start, then the
   progress series.
4. **Coach persona** — `requireRole('coach')`, `/coach/clients` from the
   enrollment filter that already works, then the read screens.
5. **Diet plan (assigned)** — coach authoring, referencing `foods`.
6. **Workout plan (assigned)** — referencing `workouts`.
7. **Food log**, then **workout log**.
8. **Payment/checkout last** — it is the only item that needs an external vendor
   decision, and every other step is useful without it (admins can create
   enrollments today).

Steps 1-3 are independent of the payment decision, which is why they come first.
