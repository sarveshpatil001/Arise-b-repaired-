# ARISE — repaired source

The verified application source lives in [`Arise-b-main/`](./Arise-b-main). It is the
source of record for the repairs; the tracked `Arise-b-main-repaired.zip` is the
pre-repair snapshot and is not used by CI.

- Application / configuration: [`Arise-b-main/README.md`](./Arise-b-main/README.md)
- Environment variables: [`Arise-b-main/ENVIRONMENT.md`](./Arise-b-main/ENVIRONMENT.md)
- Authorization model: [`Arise-b-main/ARISE_AUTHORIZATION_MATRIX.md`](./Arise-b-main/ARISE_AUTHORIZATION_MATRIX.md)
- Migration notes: [`MIGRATION.md`](./MIGRATION.md)
- CI: [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) verifies the committed
  source tree (install from `bun.lock`, typecheck, lint, tests, build, audit).

LIVE_TRADING_ENABLED remains **false**. Nothing in this repository enables real-money
orders, and no secrets are committed.
