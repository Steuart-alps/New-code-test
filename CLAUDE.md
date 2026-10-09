# ComplyTrack

Health & safety compliance SaaS for UK businesses. pnpm monorepo (Node 24,
TypeScript 5.9), deployed only on Render. `docs/ARCHITECTURE.md` is the
detailed product/architecture reference and `.agents/memory/` holds notes on
past decisions and pitfalls (many written while the project was on Replit;
notes marked "Historical" describe Replit-only behaviour that no longer
applies) — read `.agents/memory/MEMORY.md` (an index) before working in an
unfamiliar area.

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

All settings are environment variables; `.env.example` lists them, and
`render.yaml` declares the ones Render needs. There are no host-specific
fallbacks:

- Stripe: `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` only
  (`api-server/src/lib/stripeClient.ts`, `scripts/src/stripeClient.ts`). Without
  the key, start-up reports billing as unconfigured (`/readyz` 503 `degraded` in
  production) and checkout/add-ons stay disabled; the process keeps running.
- File storage: Google Cloud Storage via `GCS_SERVICE_ACCOUNT_JSON`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `GCS_PROJECT_ID`, or ambient ADC. With no
  credentials, storage operations fail and uploads report
  `OBJECT_STORAGE_UNAVAILABLE`. Configure paths with `PRIVATE_OBJECT_DIR` /
  `PUBLIC_OBJECT_SEARCH_PATHS` or the `GCS_*_BUCKET` / prefix variables.
- Public URL: `getPublicAppUrl()` in `api-server/src/lib/email.ts` —
  `PUBLIC_APP_URL`, else `RENDER_EXTERNAL_URL`, else localhost. Use it rather
  than reading those variables directly. The web build's canonical SEO URL is
  `PUBLIC_SITE_URL`, else `RENDER_EXTERNAL_URL`, else the production domain
  (`compliance-tracker/scripts/site-url.mjs`).
- Mobile: `pnpm --filter @workspace/mobile run dev` starts Expo; production
  builds need `EXPO_PUBLIC_DOMAIN` (the API host).

## Deployment (Render)

`render.yaml` is a Render Blueprint and the only deployment: one always-on web
service plus Postgres, both in Frankfurt. Render runs the build, then
`node lib/db/bootstrap.mjs` (creates the base schema only when the database is
empty), then starts the API, which also serves the web build (`WEB_DIST_DIR`
overrides its location). Rehearse that sequence against an empty database before
changing it. Without a custom domain, URLs fall back to Render's
`RENDER_EXTERNAL_URL`.

## Rules

- Tenant isolation: never trust a client-supplied `clientId`; use the existing
  `canAccessClient` / `enforceClientAccess` helpers. Mutation routes must mount
  `denyViewers` so `client_viewer` stays read-only.
- Billing: no proration; per-site charges go through the outbox. See
  `.agents/memory/billing-*.md` before touching billing.
