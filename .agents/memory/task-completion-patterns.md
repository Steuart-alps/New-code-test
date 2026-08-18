---
name: Task completion patterns
description: Patterns learned from the large batch task completion session (Aug 2026)
---

# Task Completion Patterns

## What's already built vs what the task queue says

The task queue significantly lags the codebase. Before implementing any task:
1. `grep` the relevant page/route for the feature first
2. Check if the API endpoint exists — it often does
3. Check if the scheduler is already registered in `index.ts`

Tasks found already implemented (examples): monthly compliance summary, bike overdue scheduler, training expiry reminders, fire/legionella result-aware status badges, doc ack register PDF, PAT register PDF, pest log PDF, bike hire register PDF, hot tub PDF, training matrix, staff roster UI, invite email, welcome email, denyViewers on all data mutation routes, dept delete 409 warning, PATtrack pest control presets, all billing service entries in trial-ended.tsx (except safetrack and doctrack which were added this session).

**Why:** Task descriptions can be queued before or after implementation happens in parallel branches.

## Subagent delegation results

Dispatched 12 parallel subagents for the batch. Key lessons:
- Subagents reliably follow "read files first, then edit" instructions
- Subagent file conflicts were avoided by assigning non-overlapping file domains
- `runtimeMigrations.ts` is a shared file — SA4 added contractor columns, the existing file wasn't touched by other agents because they were given non-schema tasks
- Subagents reliably run typecheck at the end if instructed

## Trial-ended.tsx module list

After this session, ALL services are now in trial-ended.tsx ADDONS array:
firetrack, kitchentrack, legionellatrack, fixtrack, premisestrack, safetrack (added), doctrack (added), traintrack, hottubtrack, treetrack, incidenttrack, biketrack, aquatrack, greentrack (check), pattrack, pesttrack, dailytrack_am, dailytrack_pm.

## API scheduler inventory (as of Aug 2026)

All schedulers registered in index.ts:
- Contractor reminder (daily 08:00)
- Contractor compliance reminder (daily 08:55)
- Training expiry reminder (daily 09:00)
- Billing reconciliation (daily 08:30)
- Trial reminder (daily 08:15)
- Check reminder (daily 08:45)
- Doc acknowledgement reminder (daily 08:50)
- FixTrack overdue alert (daily 08:40)
- Bike overdue notification (hourly :05)
- Cancellation detection (daily 07:00)
- Data deletion (daily 03:00)
- Monthly compliance summary (1st of month 08:05)
- Contractor insurance expiry reminder (weekly Mon 09:00)
- SafeTrack ack reminder (weekly Mon 09:30)

## ADMIN_EMAIL not configured

Used for: billing drift alerts, unhandled exception emails, data deletion confirmations. Requested from user but not yet set. Gracefully skips when absent.
