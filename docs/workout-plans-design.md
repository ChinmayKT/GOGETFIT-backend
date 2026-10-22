# Workout plans — design and legacy mapping

Status: **dry run passing on staging; create-only apply and run-scoped rollback implemented, not executed.**
**Nothing has been written.** The first development apply waits for explicit approval.

Source analysis: [`workout-plans-migration-audit.md`](./workout-plans-migration-audit.md) (staging-ggf, read-only). Figures quoted below are from that audit.

## 1. What is built

| Piece | File |
|---|---|
| Model, indexes, day lookup | `src/models/workout-plan.model.js` (collection `workoutplans`) |
| Prescription parsing | `src/utils/workout-prescription.js` |
| Legacy → document (pure; no database) | `migration/transformers/workout-plan.transformer.js` |
| Member read `GET /api/users/me/workout-plan?date=` | `src/services/workout-plan.service.js`, `src/controllers/workout-plan.controller.js`, `src/routes/user.routes.js` |
| Index sync at startup | `src/server.js` |
| Tests | `tests/unit/workout-plan-transform.test.js` (14), `tests/integration/workout-plans.test.js` (5) |

## 2. Document shape

One document per plan (one per legacy plan). Blocks and exercises are embedded; there is no document per block, exercise or day.

```
planId        "gogetfit:<legacy workout_plan_id>"  (app plans: their own id)
clientId      User (required, immutable) — a verified user only
coachId       Coach | null — only a proven coach
enrollmentId  EnrolledClient | null — legacy plans: null (decision D4)
name          verbatim
blocks[]      { blockId, legacyCategoryId, name, order, exercises[] }
  exercises[] { workoutId | null, legacyWorkoutId, name (snapshot),
                setsRaw, repsRaw,           ← exactly as written
                sets, measure, amount, amountMax,  ← read only when safe, else null
                note | null }
selectedDates[]  start of each business day (IST), ascending, distinct
fromDate/toDate  first/last selected date; null when there are none
assignedAt    precedence (legacy: the plan's create_date)
status        active | archived
legacy        { source, workoutPlanId, clientId, createdBy, createDate, lastUpdateDate }
migration     { runId, migratedAt, version }
createdBy/updatedBy, timestamps
```

**Model rules.**

- New plans hold at most **8 blocks**. Migrated plans are not capped by the model, so nothing is ever truncated; one over 8 is reported (see §5).
- Block `order` and `blockId` are unique within a plan.
- `selectedDates` are ascending with no repeats, and `fromDate`/`toDate` must match the first and last of them. A plan with no dates has neither.
- Every exercise needs a `workoutId`, or (migrated) a `legacyWorkoutId`.
- `amountMax` closes a range and needs an `amount` not above it. An `amount` needs its `measure`.

**Indexes.**

- `uniq_legacy_source_workoutplan`: unique partial on `(legacy.source, legacy.workoutPlanId)`. A re-run cannot create a second document for a legacy plan.
- `workoutplan_client_day_assigned`: `(clientId, selectedDates, assignedAt desc)` for the day lookup.
- `workoutplan_planid`, and `workoutplan_coach_assigned` (partial, where `coachId` is set).

## 3. Legacy behavior preserved

| Legacy behavior | How it is kept |
|---|---|
| Plans apply on individually selected days; no recurrence | `selectedDates` holds exactly those days; `findForDay` matches the exact day only |
| Newest-created plan wins a shared day (`ORDER BY create_date DESC LIMIT 1`) | `assignedAt` = legacy `create_date`; `findForDay` sorts `assignedAt desc`, then legacy id desc, then `_id` |
| Calendar days, no timezone handling (IST server) | Days enter as `YYYY-MM-DD` text (to be `DATE_FORMAT`ted at extraction) → `startOfBusinessDay`; tested across UTC midnight |
| Block order = category id ascending | `blocks[].order` from category id ascending |
| Exercise order: **not stored in legacy** | Fallback: `workout_id` ascending, the primary-key order the legacy read returned. **Inferred, not proven** (audit U7) |
| Sets/reps free text (≤5 chars) | `setsRaw`/`repsRaw` verbatim, trailing spaces included; parsed fields beside them |
| Archived exercises still show | They stay normal references; the member read shows them |
| Copy re-used block rows across plans | Each plan gets its own copy of its blocks (`blockId` = `gogetfit:cat:<id>` within the plan) |
| Source traceability | `planId`, `legacy.*`, `blocks[].legacyCategoryId`, `exercises[].legacyWorkoutId` |

**Prescription parsing** (`parseSets` / `parseReps`). Values are only read when unambiguous:

| Raw | Result |
|---|---|
| `"3"` (sets) | 3 |
| `"12"` | reps 12 |
| `"12-15"` | reps 12–15 |
| `"15sec"` / `"15s"` | time 15 s |
| `"10reps"` | reps 10 |
| `"1min"` | time 60 s |

Anything else gives nulls with the raw text kept, e.g. `"15-12"`, `"30cc"`, `"I "`, `"10/3"`. Nothing is inferred from the exercise.

## 4. Field mapping

| Legacy | → | Target | Notes |
|---|---|---|---|
| `m_workout_plan.workout_plan_id` | | `planId`, `legacy.workoutPlanId` | Idempotency key |
| `.workout_plan_name` | | `name` | Verbatim. Never logged (often holds a client's name) |
| `.user_id` | | `clientId` via verified user bridge; `legacy.clientId` raw | Unresolved → plan **blocked** |
| `.created_by` | | `coachId` (see coach rule below); `legacy.createdBy` raw; `legacy.coachSource` | Never guessed |
| `.create_date` | | `assignedAt`, `legacy.createDate` | IST wall time → instant (`legacyInstant`) |
| `.last_update_date` | | `legacy.lastUpdateDate` | |
| `m_workout_category.workout_category_id` | | `blocks[].legacyCategoryId`, `blockId`, `order` | Deep-copied per plan |
| `.workout_category_name` | | `blocks[].name` | Verbatim |
| `r_workout_plan_category` | | membership of `blocks[]` | |
| `r_workout_plan.workout_id` | | `exercises[].workoutId` via `workouts.legacy.workoutId`; `legacyWorkoutId` raw | Missing → `workoutId: null`, kept, decision |
| `.sets_count` / `.reps_count` | | `setsRaw`/`repsRaw` (+ parsed) | |
| — | | `exercises[].note` | `null`; legacy had no notes |
| `r_workout_plan_dates.workout_date` | | `selectedDates`, `fromDate`, `toDate` | Distinct days; repeats collapse and are reported |
| row audit columns, dead tables | | — | Not carried |

**Coach rule** (`coachFor`), recorded in `legacy.coachSource`:

1. **`creator`** — the diet-plan rule. The plan's author is accepted when verified as a coach exactly as `migration/loaders/diet-plan.loader.js` verifies it: the user path and the legacy-coach email mapping must agree.
2. **`client_enrollment`** — otherwise, the client's own coach in the old app. This is the coach on their migrated enrollment covering the plan's creation day, or else its first assigned day.
3. **`client_only_coach`** — otherwise, the client's only coach across all their enrollments.
4. Otherwise `coachId: null`, reported. Two coaches covering the same day is reported as `coach_ambiguous` and never picked.

## 5. Data-quality issues and client readiness

`transformWorkoutPlan` never drops a row or fills a gap silently. Every irregularity is an issue on the result:

| Severity | Codes | Effect |
|---|---|---|
| **blocking** | `client_unresolved`, `invalid_date` | No document. Never accepted away |
| **decision** | `no_dates`, `no_blocks`, `no_exercises` (undated only — see below), `too_many_blocks`, `exercise_missing`, `exercise_outside_plan_blocks` | Document built; written only once the code is accepted under the exception policy |
| **info** | `no_exercises` on a **dated** plan, `coach_unresolved`, `coach_ambiguous`, `exercise_archived`, `empty_block`, `duplicate_dates`, `dates_before_creation`, `sets_unread`, `reps_unread` | Written as the legacy app showed it; listed in the report |

**Client readiness** (`clientReadiness`). A client is ready only when **every** one of its plans is ready, or its decision codes are all accepted, and none of its shared days is a tie (`competingDays`).

Migrating part of a client would let an older plan show on a day a newer one won. One held plan therefore holds the client.

Assignment rows pointing at no plan (e.g. `workout_plan_id = 0`) are reported by `orphanAssignments` and never attached.

**More than 8 blocks.** None exist in staging (the maximum is 7). If production has some, the transformer keeps every block and reports `too_many_blocks`. Proposed resolution: accept them as they are, since the model allows legacy plans over 8. The app must then render more than 8 read-only blocks. Splitting a plan is the alternative.

**No dates** (115 in staging). The plan is built undated and reported. It applies on no day until a decision is made. The diet-plan precedent is: report, don't migrate.

## 6. Unresolved decisions

- **D1 — ranges and odd values in the app.** `amountMax` and the raw text are stored. The Flutter `PlannedWorkout` has a single `amount`. Should it show `repsRaw`, or gain `amountMax`? (audit U1)
- **D2 — reps vs time for the library.** `workouts` has no measure field. Measure here comes only from the raw text. (U2)
- **D3 — undated / empty plans** (115 undated, 87 without exercises). Migrate as inert records, or report only? (U3)
- **D4 — enrollment link.** Legacy plans get `enrollmentId: null` for now. Split at enrollment boundaries like diet plans? (U4)
- **D5 — production.** Schema and counts are verified on staging only. Production must be inspected read-only before any run. (U5)
- **D6 — 45 plans with `user_id = 0`.** These are blocked as client-unresolved. Templates? (U6)
- **D7 — exercise order.** Confirm `workout_id` ascending matched what coaches saw. (U7)
- **D8 — unresolved coaches** (decided): the diet-plan author rule first, then the client's own coach from their enrollments (coach rule above). Only plans resolved by neither stay `coachId: null` and are reported.
- **D9 — exception policy.** Which decision codes may be accepted, and who approves them.

## 7. Dry run

```
npm run migration:workout-plans:dry-run -- --source=staging [--report=<dir>] [--accept=<decision code>,...]
```

| Piece | File |
|---|---|
| Read-only extraction + verbatim legacy runtime SQL (WorkoutDAL E10/E3) | `migration/extractors/workout-plan.extractor.js` |
| References, classification, validation, field check, replay | `migration/loaders/workout-plan.loader.js` |
| Command, JSON + Markdown report | `migration/scripts/migrate-workout-plans.js` |
| Tests (no database) | `tests/unit/workout-plan-migration.test.js` |

**Guards.** `--source` must be `staging`, and the configured legacy database must be `staging-ggf`. `--apply` is refused. The command also runs `assertMigrationEnv`, then `assertDevelopmentTarget` (NODE_ENV=development, MIGRATION_ALLOW_PRODUCTION off), then `assertDevelopmentConnection` (dev cluster, `gogetfit`). MariaDB is read through the read-only pool. Mongo connects with `autoCreate`/`autoIndex` off and only reads. Logs and reports never carry credentials, hosts or plan names (plans and clients by legacy id only). The exit code is 1 when a gate fails.

**Classification.**

- Blocked (`client_unresolved`, `invalid_date`): no document.
- Undated: reported only. It applies on no day, so it holds no one back.
- A client migrates only when every one of their dated plans is ready (or its decision codes are all `--accept`ed) and none of their shared days is a tie. Otherwise every plan of that client is held.
- `enrollmentId` stays null.

**Gates** (all must be 0):

- schema validation errors;
- header fields vs `m_workout_plan` and its distinct dates;
- replay of the verbatim legacy day query over every assigned day ±1 of every migrated client: selected plan, name, blocks, and each block's exercises (workout, sets, reps, as a set; legacy had no ORDER BY).

Also reported, but not gating: whether the legacy order as returned equals the stored order (D7 evidence), and exercise names that differ from the Workout master.

**Empty dated plans (decision, 2026-10-20).** A plan with assigned dates and blocks but no exercises migrates as it is: same plan id, name, blocks (empty), creation time and exact dates; nothing is invented. Reason: the legacy day query does not look at exercises, so such a plan still won its days (newest wins) and the member saw an empty plan. Holding it back would let an older plan show on those days. Verified on staging plan 60, client 187: the verbatim legacy query returns plan 60 on 3 of its 5 days and the newer plan 69 on the other 2. With the change, plans 60, 69, 288 and 290 migrate, and the replay over that client is clean. Undated plans stay report-only. A dated plan with **no blocks** stays a decision (none among the clients that would migrate).

### Staging result (2026-10-20, run `workout-plans-dry-run-2026-10-19T21-12-47-730Z-76d772`) — DRY RUN PASS

| | |
|---|---|
| legacy plans / exercise rows / date rows | 372 / 3,977 / 6,283 — all 372 accounted for |
| would create | **119 plans** (553 blocks, 1,921 exercises, 2,865 days) for 22 of 62 clients; 0 already present, 0 conflicts |
| blocked: client not in MongoDB | 234 plans — see client reconciliation below |
| undated, report only | 19 |
| held | 0 |
| coachId | creator 102, client_only_coach 14, null 3 (plans 252–254) |
| archived exercise references kept | 226 |
| validation / field / replay mismatches | **0 / 0 / 0**; 2,973 client-days, 115 plans' content, 1,864 exercises |
| exercise order (D7) | legacy order as returned = workout id ascending in **534 of 534** blocks |
| name differences | 90, all 6 workouts whose legacy name had surrounding spaces (trimmed in `workouts`) |
| orphan date rows / dangling block links / tied days | 7 / 0 / 0 |

Spot check for a manual comparison with the old app: `migration/reports/runs/workout-plans-spot-check.md` (legacy ids and dates only).

### Client reconciliation (read only)

`npm run migration:workout-plans:clients` (`migration/scripts/reconcile-workout-plan-clients.js`).

For every plan owner missing from MongoDB, it applies the user migration's own rules without writing:

- the row exists in `m_user`;
- the phone normalizes and the record passes `validateBatch`;
- no other legacy row shares the phone (the full run parks those as `DUPLICATE_LEGACY_PHONE`);
- `loadUsers` in dry-run mode (already migrated, or the phone is held by another MongoDB user).

It also lists recorded `MigrationConflict`s. Output is by legacy id only.

Staging (40 owners missing):

| verdict | clients | plans | what it needs |
|---|---|---|---|
| would_migrate | 28 | 141 | `migrate-single-user.js --id <ids>` dry run, then `--apply` — **separate approval**; then their enrollments (`migrate:enrolled-clients`) for the coach rule |
| duplicate_legacy_phone | 4 (#301 ↔ 360, 363, 426; #454 ↔ 453; #616 ↔ 457; #623 ↔ 598) | 14 | a recorded conflict resolution (`migrate:conflicts`) first; never merged automatically |
| absent_from_legacy | 7 (#133, 161, 166, 188, 196, 197, 199) | 34 | nothing can: the owner row is not in `m_user`. Stays blocked |
| no_owner (`user_id = 0`) | — | 45 | no legacy table records another owner (`r_workout_plan_dates` has no client column; `created_by` is the author). Stays blocked |

Dev MongoDB holds 26 migrated users. All 24 that exist in staging match staging on phone, email and name, so the bridge is sound.

### 28 staging clients migrated to dev (2026-10-20)

Preflight (read only, `migration/reports/runs/workout-plan-clients-preflight-{pre,post}-*.json|md`):

- all 28 exist in `staging-ggf`, have usable phones and pass batch validation;
- no legacy id or phone is already in MongoDB, no phone is shared in staging, and no recorded conflicts exist.

Migrated with the established tool, legacy `staging-ggf` (read-only) → dev cluster, `gogetfit`:

```
node migration/scripts/migrate-single-user.js --id 123,336,399,416,417,419,421,423,424,425,445,447,554,568,583,589,612,613,614,626,632,634,638,649,650,655,672,685          # dry run: would insert 28
node migration/scripts/migrate-single-user.js --id <same> --apply                                                                                                    # run single-2026-10-20T04-33-45-736Z-0d61e8
```

Result:

- inserted 28, skipped 0, failed 0;
- email filled on 28, fitness profile on 13;
- the post-check confirms each id maps to exactly one user (dev users 27 → 55).

**Enrollments: not migrated.** `migrate:enrolled-clients` is a whole-table upsert. Its dry run would create 48 (33 for these clients, 15 for users already in dev), update 0, and add the client role to 27 users. Payment data comes only from the joined `t_payment` row and is never fabricated; 0 enrollments lack a payment row. Without `--link-coaches-by-email`, coachId stays null. Running it needs separate approval.

**Workout-plan dry run after** (`workout-plans-dry-run-2026-10-20T04-34-17-085Z-d16790`): **DRY RUN PASS**.

- 233 plans for 50 clients would be created; 93 blocked (45 `user_id = 0`, 34 owners absent from `m_user`, 14 phone-conflict clients); 46 undated (report only). All 372 accounted for.
- 0 validation / field / replay mismatches (6,240 client-days, 229 plans' content).
- All 233 documents point at the user with the same legacy id.
- coachId is null on 111. 110 of them are authored by legacy user 332, a legacy coach with no Coach document in dev (their enrollments name legacy coaches 17 and 13, also unlinked). Linking that coach in dev, then a fresh dry run, would let the author rule assign it.

## 8. Apply and rollback (implemented, not run)

```
npm run migration:workout-plans:apply -- --source=staging --from-report=<dry-run .json>
npm run migration:workout-plans:rollback -- --run-id=<id> --manifest=<.manifest.json> [--confirm=<id>]
```

**Apply** (`migration/scripts/apply-workout-plans.js`). It runs these guards first:

- `assertMigrationEnv`;
- the source must be the staging snapshot;
- `assertDevelopmentTarget` (NODE_ENV=development, MIGRATION_ALLOW_PRODUCTION off) and `assertDevelopmentConnection` (dev cluster, `gogetfit`);
- no implicit collection or index creation;
- the unique `(legacy.source, legacy.workoutPlanId)` index must exist.

The `--from-report` must be:

- a passing workout-plan dry run;
- for the same source and target;
- at most `--max-age-hours` old (24 by default).

The apply then re-runs every dry-run step and requires identical fingerprints:

- the legacy rows (source);
- the planned documents (documents);
- the migrated plans already in the target (target).

Any difference refuses with the reason.

Writes:

- Insert only, one document at a time, each tagged `migration.runId` (+ `migratedAt`, `version`).
- A planned document already present and identical is skipped (idempotent rerun).
- One present but different is a conflict, and the run stops before any write.
- The same legacy id twice in a batch is refused.
- On the first failed insert it stops and reports inserted / failed / not attempted.
- The fix is a fresh dry run and a rerun, which skips what is there.

Manifest: `migration/reports/runs/<runId>.manifest.json`, rewritten after every insert. It holds document `_id`, legacy plan id and `planId` only, plus the source report and fingerprints.

**Rollback** (`migration/scripts/rollback-workout-plans.js`). Deletes only the documents of one run, and only when the manifest and the database agree exactly:

- every listed `_id` exists with that run id and that legacy plan id, unmodified since insert;
- no unlisted document carries the run id.

Without `--confirm=<same run id>` it only reports. Documents from before the run, from other runs, or made in the app are never selected.

**Tests.**

- `tests/unit/workout-plan-migration.test.js` covers classification, the empty dated plan, replay, the guards, CLI arguments and client verdicts.
- `tests/integration/workout-plan-apply.test.js` (gogetfit_test) covers:
  - zero-write dry run;
  - create-only apply with run tag and manifest;
  - idempotent rerun;
  - stale/foreign/changed reports refused;
  - conflicts;
  - duplicate legacy ids;
  - partial failure and recovery;
  - run-scoped rollback.

## 9. Original next-step list

1. Read-only extractor: the existing pool (`migration/config/mariadb.js`, read-only session), days via `DATE_FORMAT(workout_date, '%Y-%m-%d')`.
2. Reference bridges: users and coaches as in the diet-plan migration; workouts by `legacy.workoutId`.
3. Dry-run report:
   - plans by status;
   - issues by code;
   - client readiness;
   - competing days;
   - a day-by-day replay of the legacy query that must show **0 mismatches**.
4. Apply mode: separate flag, dev-target guard (`migration/config/dev-target.js`), create-only, run id on every document for rollback.
