# ComplyTrack — Health & Safety Compliance for UK Businesses

## Overview

Health & Safety compliance tracking platform for **individual UK businesses** managing
their own compliance — across one site or many. Businesses can optionally invite their
external H&S consultant in with scoped access when needed.

The underlying architecture is multi-tenant (each business is isolated from others on
the platform), but the product is positioned and sold direct to businesses, not to
consultants managing portfolios of clients.

- **External Compliance**: Contractor-managed visits, certificates, email reminders
- **Internal Compliance**: Internal staff compliance checks
- **FireTrack** (fire safety branch): Digital fire logbook — 5 check types (alarm & extinguisher visual weekly, emergency lights monthly, fire doors quarterly, fire drill 6-monthly) with due/overdue status
- **KitchenTrack** (kitchen branch): Daily food safety record — deliveries, fridge/freezer & hot food temps, corrective actions, manager sign-off; config-driven fridge counts and temperature limits

## Per-service billing (add-ons)
- Pricing per site/month: ComplyTrack core £10, FireTrack +£10, KitchenTrack +£10; "ComplyTrack Complete" bundle £50 unlocks everything (incl. future services). Cap: per-site items summing to ≥£50 also unlock all.
- Stripe products/prices carry `service_key` metadata (core/firetrack/kitchentrack/bundle) — seeded via `scripts/src/seed-plans.ts`; all prices are server-resolved, never client-supplied.
- Entitlements: `api-server/src/lib/services.ts` (cached per client; trial = all services free). Routes `/fire-safety` & `/food-safety` are guarded by `requireService(...)` → 403 `SERVICE_NOT_ENABLED`.
- `POST /api/billing/services` add/remove add-ons: add charges a full month immediately (no proration, idempotency-keyed per billing period; item rolled back if the charge can't be created); remove is immediate, no refund. Bundle is selectable at checkout/signup only.
- `/auth/me` + login return `services` ("all" | keys); frontend `hasService()` gates pages, sidebar lock icons, upgrade cards; Services card in Settings; signup + trial-ended pages offer service/bundle selection.
- Quantity sync and the added-site outbox charge cover ALL per-site service items (sum of unit amounts).

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (direct `zod` import), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (with zod added as direct dep of api-server)
- **Frontend**: React + Vite, TanStack Query, Tailwind CSS, shadcn/ui, Recharts, Framer Motion
- **Auth**: Session-based (express-session + connect-pg-simple), bcryptjs for password hashing
- **Email**: Nodemailer (SMTP configurable via Settings page)
- **File Storage**: Google Cloud Storage via Replit Object Storage

## User Roles & Access

| Role           | Scope                                          |
| -------------- | ---------------------------------------------- |
| `consultant`   | All clients; can create/manage clients & users |
| `client_admin` | Own client; can manage users & settings        |
| `client_staff` | Own client, scoped to a department             |
| `client_viewer`| Own client, read-only                          |

## Navigation Structure

- **Dashboard** — overview with external/internal split (consultant sees "select client" prompt if no client active)
- **EXTERNAL COMPLIANCE**
  - Contractors — manage external contractors
  - External Checks — compliance items assigned to contractors, with lead time email reminders
- **INTERNAL COMPLIANCE**
  - Internal Checks — staff-managed compliance tasks
- **FIRETRACK** (fire safety branch)
  - Fire Logbook (`/fire-safety`) — status cards + check history, record/edit/delete checks
- **KITCHENTRACK** (kitchen branch)
  - Kitchen Diary (`/kitchen`) — daily record with draft save and manager sign-off (locks record)
- **SYSTEM** (role-gated)
  - Categories — color-coded categories (canAdmin)
  - Users — user management (canAdmin)
  - Clients — client management (consultant only)
  - Settings — SMTP email config, company name, default lead time (canAdmin)

## Database Tables

### Multi-tenancy tables
- `clients` — client organisations (name, slug, logoUrl, primaryColor, active)
- `departments` — departments per client (name, clientId)
- `users` — platform users (email, passwordHash, name, role, clientId, departmentId, active)

### Compliance tables (all tenant-scoped via clientId)
- `categories` — compliance categories with name and color
- `contractors` — external contractors with name, company, email, phone, address, notes
- `certificates` — polymorphic: belongs to either a contractor OR a compliance item (XOR check constraint enforced)
- `compliance_items` — compliance tasks with type, status, priority, contractorId, departmentId, leadTimeDays
- `app_settings` — key/value settings (SMTP config, company name, lead time defaults) — unique per (clientId, key)
- `password_reset_tokens` — one-time tokens for password reset flow (expiresAt 1h, usedAt)
- `fire_safety_checks` — fire logbook entries (checkType, checkDate, result pass/fail, siteId nullable, location, performedBy)
- `food_safety_records` — one kitchen diary record per (clientId, recordDate); JSON row arrays + submittedAt lock

## Auth Endpoints

- `POST /api/auth/login` — { email, password } → sets session cookie
- `POST /api/auth/logout` — clears session
- `GET /api/auth/me` — returns current user + client info

## API Routes

All routes (except auth) require authentication and tenant-scope the data via session.
Consultants pass `clientId` as a query param (injected by the frontend via `custom-fetch.ts`).

- `GET/POST /api/clients` (consultant only)
- `GET/PUT /api/clients/:id` (consultant only)
- `GET/POST /api/departments`
- `GET/PUT/DELETE /api/departments/:id`
- `GET/POST /api/users` (canAdmin)
- `GET/PUT/DELETE /api/users/:id` (canAdmin)
- `GET/POST /api/categories`, `DELETE /api/categories/:id`
- `GET/POST /api/contractors`, `GET/PUT/DELETE /api/contractors/:id`
- `GET/POST /api/contractors/:id/certificates`, `PUT/DELETE /api/contractors/:id/certificates/:certId`
- `GET/POST /api/items/:itemId/certificates`, `PUT/DELETE /api/items/:itemId/certificates/:id`
- `/items/:id` (frontend) — full compliance check detail page incl. cert management
- `GET/POST /api/compliance-items?type=external|internal&status=...&priority=...`
- `GET/PUT/DELETE /api/compliance-items/:id`
- `PATCH /api/compliance-items/:id/status`
- `GET /api/dashboard/stats`
- `GET/PUT /api/settings`
- `POST /api/notifications/send-reminders`
- `POST /api/notifications/test-email`
- `POST /api/storage/uploads/request-url`
- `GET/POST /api/fire-safety`, `PUT/DELETE /api/fire-safety/:id`, `GET /api/fire-safety/status` (siteId ownership validated on write)
- `GET/PUT /api/food-safety/config`, `GET/POST /api/food-safety`, `GET /api/food-safety/by-date/:date` (404 when absent), `PUT /api/food-safety/:id`

## Frontend Auth Flow

- `AuthProvider` in `src/context/auth-context.tsx` manages session state
- On load: calls `GET /api/auth/me` to restore session
- Login: `POST /api/auth/login` → stores user + client in context
- Consultant selecting a client: `setActiveClientId(clientId)` stored in state + ref
- All API calls use `custom-fetch.ts` which injects `clientId` into GET requests automatically
- `ProtectedRoutes` in `App.tsx` gates routes by role

## Key Seed Credentials

- **Consultant**: `consultant@complytrack.com` / `ChangeMe123!` (change password after first login)

## Key Package Scripts

- `pnpm --filter @workspace/api-server run dev` — start API server
- `pnpm --filter @workspace/compliance-tracker run dev` — start frontend
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API client
- `pnpm --filter @workspace/db run push` — push DB schema changes
- `npx tsx scripts/seed-consultant.ts` — (re)seed consultant account
