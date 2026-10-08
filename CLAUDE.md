# ComplyTrack

Health & safety compliance SaaS for UK businesses. pnpm monorepo (Node 24,
TypeScript 5.9). `docs/architecture.md` is the detailed product/architecture
reference and `docs/notes/` holds notes on past decisions and pitfalls — read
`docs/notes/MEMORY.md` (an index) before working in an unfamiliar area.
`docs/reference/` holds source material (UK check sheets, record templates).

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
- Dev: `PORT=8080 pnpm --filter @workspace/api-server run dev` and
  `pnpm --filter @workspace/compliance-tracker run dev` (port 5173, proxies `/api`
  to `API_PORT`, default 8080)
- Production: build both, then `node artifacts/api-server/dist/index.mjs` — the API
  server also serves the web build (`compliance-tracker/dist/public`) with an
  `index.html` fallback, so one process serves the whole app
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

All settings are environment variables; `.env.example` lists them.

- Stripe: `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` (`api-server/src/lib/stripeClient.ts`,
  `scripts/src/stripeClient.ts`). `stripe-replit-sync` is just the npm library
  that mirrors Stripe data into Postgres; it runs anywhere.
- File storage: Google Cloud Storage via `GCS_SERVICE_ACCOUNT_JSON` or
  `GOOGLE_APPLICATION_CREDENTIALS`, plus `PRIVATE_OBJECT_DIR` /
  `PUBLIC_OBJECT_SEARCH_PATHS` (`api-server/src/lib/objectStorage.ts`).
- Public URL: `getPublicAppUrl()` in `api-server/src/lib/email.ts` (`PUBLIC_APP_URL`,
  else Render's `RENDER_EXTERNAL_URL`, else localhost) — used for email links, Stripe return URLs and the webhook.

## Deployment (Render)

`render.yaml` is a Render Blueprint: one always-on web service plus Postgres,
both in Frankfurt. Render runs the build, then `node lib/db/bootstrap.mjs`
(creates the base schema only when the database is empty), then starts the API,
which also serves the web build (`WEB_DIST_DIR` overrides its location). Rehearse
that sequence against an empty database before changing it. Without a custom
domain, URLs fall back to Render's `RENDER_EXTERNAL_URL`. Keep one instance —
scheduled jobs run in-process; `TZ=Europe/London` sets their times.

## Rules

- Tenant isolation: never trust a client-supplied `clientId`; use the existing
  `canAccessClient` / `enforceClientAccess` helpers. Mutation routes must mount
  `denyViewers` so `client_viewer` stays read-only.
- Billing: no proration; per-site charges go through the outbox. See
  `docs/notes/billing-*.md` before touching billing.
