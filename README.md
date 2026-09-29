# GOGETFIT Backend

Backend API for the GOGETFIT application: phone + OTP authentication, profile
onboarding, and a read-only migration subsystem that moves the legacy MariaDB
user base into MongoDB.

MongoDB is the runtime source of truth. MariaDB is only ever read, and only by
the migration scripts — no user-facing request touches it.

## Requirements

- Node.js 20 or newer
- npm
- MongoDB Atlas cluster
- MariaDB credentials (migration only)

## Installation

```bash
npm install
```

## Environment configuration

Create a `.env` file in the project root. It is git-ignored and must never be
committed.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `development` or `production`. Production refuses `OTP_DEBUG`. |
| `PORT` | HTTP port. Defaults to 3000. |
| `LOG_LEVEL` | `error`, `warn`, `info` or `debug`. |
| `MONGODB_URI` | MongoDB Atlas connection string. |
| `JWT_SECRET` | Signing secret for user tokens. Required. |
| `JWT_EXPIRES_IN` | Token lifetime, e.g. `30d`. |
| `OTP_HASH_SECRET` | Secret used to key the OTP hash. Required. |
| `OTP_TTL_SECONDS` | OTP lifetime. Defaults to 300 (5 minutes). |
| `OTP_MAX_ATTEMPTS` | Wrong-code attempts before a challenge is burned. |
| `OTP_DEBUG` | Returns the OTP in the API response. Development only. |
| `ALLOW_NEW_REGISTRATIONS` | `true` allows new signups; `false` is migration-only. |
| `DEFAULT_COUNTRY_CODE` | Country code applied to bare national numbers. |
| `NATIONAL_NUMBER_LENGTH` | National number length. Defaults to 10. |
| `MIGRATION_SOURCE` | Value stored as `legacy.source`. Stays `gogetfit`. |
| `MIGRATION_VERSION` | Value stored as `migration.version`. |
| `MIGRATION_MYSQL_HOST` / `_PORT` / `_DATABASE` / `_USER` / `_PASSWORD` | Legacy MariaDB connection. Read-only. |
| `MIGRATION_USER_TABLE` | Legacy user table. Defaults to `m_user`. |
| `MIGRATION_NAME_STRATEGY` | `first_name`, `concat` or `ignore`. |
| `MIGRATION_BATCH_SIZE` | Extraction batch size. |

`MIGRATION_SOURCE` is deliberately separate from `MIGRATION_MYSQL_DATABASE`, so
rehearsing against a staging database still records production-correct legacy
metadata. Point the migration at production by changing
`MIGRATION_MYSQL_DATABASE` only — no code change is required.

## Running

```bash
npm run dev     # development, auto-restart
npm start       # production
```

The HTTP server starts only after MongoDB connects and the unique indexes are
verified.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | — | Liveness plus MongoDB connection state. |
| `POST` | `/api/auth/request-otp` | — | Issue a 4-digit OTP for a phone number. |
| `POST` | `/api/auth/verify-otp` | — | Verify the OTP, return a JWT and the user. |
| `GET` | `/api/users/me` | Bearer | Current user, with age refreshed from DOB. |
| `PATCH` | `/api/users/me/profile` | Bearer | Onboarding: name, dateOfBirth, gender, city. |

Age is always derived from `dateOfBirth` by the backend. A client-supplied
`age` is rejected, as is a client-supplied `profileCompleted`.

## Tests

```bash
npm test                 # unit + integration
npm run test:unit        # no database required
npm run test:integration # uses the gogetfit_test database
```

Integration tests run against a dedicated `gogetfit_test` database on the
configured cluster and refuse to run anywhere else.

## Migration

Always read-only against MariaDB. Dry run is the default.

```bash
npm run migrate:inspect                  # verify connectivity and columns
npm run migrate:users                    # dry run: report only, no writes
npm run migrate:users -- --limit 100     # bounded rehearsal
npm run migrate:users:apply              # write migrated users to MongoDB

npm run migrate:conflicts -- list
npm run migrate:conflicts -- show <conflictId>
npm run migrate:conflicts -- keep-one <conflictId> <legacyUserId> --by <who>
npm run migrate:conflicts -- reassign <conflictId> 1001=919999999999 1002=918888888888 --by <who>
npm run migrate:conflicts -- exclude-all <conflictId> --by <who>

npm run migrate:children -- --table t_payment
```

Pipeline: extract → transform → group by normalized phone → detect conflicts →
apply recorded resolutions → validate → load → report. Reports are written to
`migration/reports/runs/<runId>.json`.

Duplicate legacy phone numbers are never merged, never silently resolved to one
winner, and never discarded. They become pending conflict records that a person
must decide on before those accounts can migrate.

Legacy child tables are linked by `legacy.userId → users._id`. Phone number is
the login identity and is never used as a relationship key.
