# ComplyTrack

Health & safety compliance SaaS for UK businesses. pnpm monorepo (Node 24,
TypeScript 5.9). Development moved here from Replit; `replit.md` is the
detailed product/architecture reference and `.agents/memory/` holds the
Replit Agent's notes on past decisions and pitfalls — read `.agents/memory/MEMORY.md`
(an index) before working in an unfamiliar area.

## Layout

- `artifacts/api-server` — Express 5 API, Drizzle ORM on PostgreSQL, esbuild bundle
- `artifacts/compliance-tracker` — React + Vite web app (TanStack Query, Tailwind, shadcn/ui)
- `artifacts/mobile` — Expo app
- `artifacts/mockup-sandbox` — UI mockups
- `lib/db` — Drizzle schema (`src/schema/`)
- `lib/api-spec` — OpenAPI spec; Orval generates `lib/api-client-react` and `lib/api-zod`
- `scripts/` — seed and maintenance scripts

## Commands

- `pnpm install --frozen-lockfile`
- `pnpm run typecheck` — the main correctness gate (libs via `tsc --build`, then each package)
- `pnpm --filter @workspace/api-server run build`
- `pnpm --filter @workspace/api-server run dev` / `pnpm --filter @workspace/compliance-tracker run dev`
- `pnpm --filter @workspace/api-spec run codegen` — after changing the OpenAPI spec
- API tests: `pnpm --filter @workspace/api-server run test:<name>` (see its `package.json`;
  `*:ci` variants boot their own server). They need `DATABASE_URL` and `SESSION_SECRET`.

## Database

- Schema changes go in `lib/db/src/schema/` **and** in
  `artifacts/api-server/src/lib/runtimeMigrations.ts` — production schema comes
  from the runtime migrations run at API startup, not from drizzle-kit.
- `drizzle-kit push` is interactive; only use it to create the base schema in an
  empty database (`pnpm --filter @workspace/db run push`), never against a live one.
- Fresh local DB: create it, run `push`, then start the API (runtime migrations
  apply the rest).

## Cloud sessions

`.claude/hooks/session-start.sh` installs dependencies, starts a local
PostgreSQL with a `complytrack` database, and exports a dev `DATABASE_URL` and
`SESSION_SECRET`.

## Configuration

All settings are environment variables; `.env.example` lists them. The code
is host-agnostic, with Replit kept only as a fallback when the standard
variable is unset:

- Stripe: `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY`, else Replit's connector
  (`api-server/src/lib/stripeClient.ts`, `scripts/src/stripeClient.ts`).
- File storage: Google Cloud Storage via `GCS_SERVICE_ACCOUNT_JSON`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `GCS_PROJECT_ID`, or local ADC; in Replit,
  it falls back to the sidecar at `127.0.0.1:1106` when no GCS credentials are
  configured. Configure paths with `PRIVATE_OBJECT_DIR` /
  `PUBLIC_OBJECT_SEARCH_PATHS` or the `GCS_*_BUCKET` / prefix variables.
- Public URL: `getPublicAppUrl()` in `api-server/src/lib/email.ts` —
  `PUBLIC_APP_URL`, else `REPLIT_DOMAINS`, then `RENDER_EXTERNAL_URL`, then
  localhost. Use it rather than reading `REPLIT_DOMAINS` directly.
- `.replit`, the `@replit/vite-plugin-*` plugins (gated on `REPL_ID`) and the
  mobile `dev` script remain for the Replit deployment; use `dev:local` elsewhere.

## Deployment (Render)

`render.yaml` is a Render Blueprint: one always-on web service plus Postgres,
both in Frankfurt. Render runs the build, then `node lib/db/bootstrap.mjs`
(creates the base schema only when the database is empty), then starts the API,
which also serves the web build (`WEB_DIST_DIR` overrides its location). Rehearse
that sequence against an empty database before changing it. Without a custom
domain, URLs fall back to Render's `RENDER_EXTERNAL_URL`.

## Rules

- Tenant isolation: never trust a client-supplied `clientId`; use the existing
  `canAccessClient` / `enforceClientAccess` helpers. Mutation routes must mount
  `denyViewers` so `client_viewer` stays read-only.
- Billing: no proration; per-site charges go through the outbox. See
  `.agents/memory/billing-*.md` before touching billing.

## Analytics

First-party, cookie-free: the web app's `trackEvent` (compliance-tracker
`src/lib/analytics.ts`) posts to `POST /api/analytics/events`, which stores
only allowlisted event names and enum dimensions in `analytics_events` (no
user, client, session, IP or user agent; purged after 13 months). New events
must be registered in api-server `src/lib/analytics.ts`. Days are UTC.

- HTTP (production): set `ANALYTICS_READ_TOKEN` (32+ chars; unset = 404), then
  `curl -fsS -H "Authorization: Bearer $ANALYTICS_READ_TOKEN" "$APP_URL/api/internal/analytics/summary?from=2026-10-01&to=2026-10-31&event=module_first_work_completed&groupBy=module"`
  (`event` and `groupBy` optional; the response lists registered events).
- CLI (any DB you can reach, e.g. local or a Render shell; the Render database
  has no public access): `pnpm --filter @workspace/scripts run analytics:report -- --from 2026-10-01 --to 2026-10-31 [--event NAME] [--group-by DIMENSION] [--json]`
- Tests: `pnpm --filter @workspace/api-server run test:analytics`. See
  `.agents/memory/first-party-analytics.md`.
