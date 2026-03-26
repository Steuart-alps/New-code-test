# Compliance Tracker

## Overview

Full-stack compliance tracking application with two distinct sections:
- **External Compliance**: Contractor-managed visits, certificates, email reminders
- **Internal Compliance**: Internal staff compliance checks

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild
- **Frontend**: React + Vite, TanStack Query, Tailwind CSS, shadcn/ui, Recharts
- **Email**: Nodemailer (SMTP configurable via Settings page)
- **File Storage**: Google Cloud Storage via Replit Object Storage

## Navigation Structure

- **Dashboard** — unified overview with external/internal split
- **EXTERNAL COMPLIANCE**
  - Contractors — manage external contractors (contact details, notes)
  - External Checks — compliance items assigned to contractors, with lead time email reminders
- **INTERNAL COMPLIANCE**
  - Internal Checks — staff-managed compliance tasks
- **Categories** — color-coded categories
- **Settings** — SMTP email config, company name, default lead time

## Database Tables

- `categories` — compliance categories with name and color
- `contractors` — external contractors with name, company, email, phone, address, notes
- `certificates` — certificates per contractor with name, fileUrl, issueDate, expiryDate
- `compliance_items` — compliance tasks with type (internal/external), status, priority, contractorId, leadTimeDays, notificationSentAt
- `app_settings` — key/value settings (SMTP config, company name, lead time defaults)

## API Routes

- `GET/POST /api/categories`, `DELETE /api/categories/:id`
- `GET/POST /api/contractors`, `GET/PUT/DELETE /api/contractors/:id`
- `GET/POST /api/contractors/:id/certificates`, `PUT/DELETE /api/contractors/:id/certificates/:certId`
- `GET/POST /api/compliance-items?type=external|internal&status=...&priority=...`
- `GET/PUT/DELETE /api/compliance-items/:id`
- `PATCH /api/compliance-items/:id/status`
- `GET /api/dashboard/stats`
- `GET/PUT /api/settings`
- `POST /api/notifications/send-reminders` — emails contractors with items in lead time window
- `POST /api/notifications/test-email` — sends test email to verify SMTP config
- `POST /api/storage/uploads/request-url` — presigned URL for certificate file uploads

## Email Reminders

Configured via Settings → Email Configuration:
- SMTP Host, Port, Username, Password, From Email, From Name
- Default Lead Time Days (per-item override available)
- "Send Reminders" button on External Checks page triggers immediate send
- System checks: item is external, has due date, contractor has email, within lead time window, not already notified
- Per-item `leadTimeDays` overrides the global default

## Key Package Scripts

- `pnpm --filter @workspace/api-server run dev` — start API server
- `pnpm --filter @workspace/compliance-tracker run dev` — start frontend
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API client
- `pnpm --filter @workspace/db run push` — push DB schema changes
