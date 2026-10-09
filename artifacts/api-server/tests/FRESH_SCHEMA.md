# Fresh database regression check

Run `pnpm --filter @workspace/api-server run test:schema:fresh`.

Requires PostgreSQL's `initdb`, `pg_ctl`, `psql`, plus Node and curl. Run as
an unprivileged user (PostgreSQL refuses to initialize as root).

The runner always creates a private temporary local PostgreSQL cluster and
an empty database. It ignores inherited DATABASE_URL/API_BASE, strips service
credentials from the server process, and cleans up on success, error or signal.
It does not run Drizzle push, copy development schema, or access production.

The real Express app and middleware boot after runtime migrations run twice.
Stripe initialization and schedulers are deliberately excluded. The DocTrack
fixture replaces only the external object store with a strict test file; route
validation, ACL checks and SQL remain real. This is not an upload-delivery test.

Coverage includes staff roster, DocTrack, TrainTrack, KitchenTrack weekly/probe,
and the existing FireTrack, Legionella and kitchen module-route suite. Exact
create/list assertions and server-log checks fail on missing tables or columns.
Add representative create/list assertions when introducing another module.

The core runtime baseline is fixed SQL, not derived from the current ORM schema.
Generating it automatically during tests would hide missing migration coverage.