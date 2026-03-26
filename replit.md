# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Compliance Tracker application — a full-stack app for tracking compliance items, categories, and statuses.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite, TanStack Query, Tailwind CSS, shadcn/ui, Recharts

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server
│   └── compliance-tracker/ # React + Vite frontend
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Compliance Tracker Features

- **Dashboard**: stat cards (total, completion rate, overdue, critical, due soon), status distribution chart, critical action items list
- **Compliance Items**: filterable list by status/priority/category, create/edit/delete items, quick status updates
- **Categories**: manage categories with color-coded labels (GDPR, SOC 2, ISO 27001, HIPAA, PCI DSS, etc.)

## Database Schema

- `categories` — compliance categories with name and color
- `compliance_items` — compliance tasks with title, description, status, priority, categoryId, assignedTo, dueDate, notes

## API Routes

- `GET/POST /api/categories`
- `DELETE /api/categories/:id`
- `GET/POST /api/compliance-items`
- `GET/PUT/DELETE /api/compliance-items/:id`
- `PATCH /api/compliance-items/:id/status`
- `GET /api/dashboard/stats`

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json`. Run `pnpm run typecheck` from root for the full check.

## Root Scripts

- `pnpm run build` — typecheck + build all packages
- `pnpm run typecheck` — full typecheck via project references

## Key Package Scripts

- `pnpm --filter @workspace/api-server run dev` — start API server
- `pnpm --filter @workspace/compliance-tracker run dev` — start frontend
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API client
- `pnpm --filter @workspace/db run push` — push DB schema changes
