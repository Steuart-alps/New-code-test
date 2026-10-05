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

## Replit dependencies still in the code

- Stripe keys come from Replit's connector service (`api-server/src/lib/stripeClient.ts`,
  `scripts/src/stripeClient.ts`) — fails outside Replit.
- File uploads use Replit Object Storage via the sidecar at `127.0.0.1:1106`
  (`api-server/src/lib/objectStorage.ts`).
- Public URLs derive from `REPLIT_DOMAINS` / `REPLIT_DEV_DOMAIN`; Vite configs load
  `@replit/vite-plugin-*` (dev only, gated on `REPL_ID`).

## Rules

- Tenant isolation: never trust a client-supplied `clientId`; use the existing
  `canAccessClient` / `enforceClientAccess` helpers. Mutation routes must mount
  `denyViewers` so `client_viewer` stays read-only.
- Billing: no proration; per-site charges go through the outbox. See
  `.agents/memory/billing-*.md` before touching billing.
