---
name: Replit removed; Render only
description: On 2026-10-09 every Replit fallback, file and package was removed; Render is the only deployment and configuration is plain environment variables.
---

On 2026-10-09 Replit support was removed entirely; `render.yaml` (web service + Postgres, Frankfurt) is the only deployment.

What replaced each fallback:
- Stripe: `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` only. The Replit connector (`REPLIT_CONNECTORS_HOSTNAME`, `REPL_IDENTITY`, `WEB_REPL_RENEWAL`, `STRIPE_CONNECTOR_TIMEOUT_MS`) is gone; with no key, start-up reports billing unconfigured (see `stripe-startup-readiness.md`) and never crashes.
- Storage: standard GCS credentials only (`GCS_SERVICE_ACCOUNT_JSON`, `GOOGLE_APPLICATION_CREDENTIALS`, ADC). The `127.0.0.1:1106` sidecar client and signer are gone; without credentials uploads report `OBJECT_STORAGE_UNAVAILABLE`.
- Public URL: `getPublicAppUrl()` = `PUBLIC_APP_URL` → `RENDER_EXTERNAL_URL` → localhost. `REPLIT_DOMAINS`, `REPLIT_DEV_DOMAIN` and `REPLIT_EXPO_DEV_DOMAIN` no longer feed URLs or CORS (use `ALLOWED_ORIGINS` for extra origins). The Stripe managed webhook now always uses `getPublicAppUrl()`.
- Production detection: `NODE_ENV=production` only (`REPLIT_DEPLOYMENT` dropped).
- Web/mockup builds: `@replit/vite-plugin-*` removed. Mobile `dev` is plain `expo start` (`create-launch` removed); builds need `EXPO_PUBLIC_DOMAIN`.
- Files: `.replit`, `.replitignore`, `artifacts/*/.replit-artifact/`, `scripts/post-merge.sh`, `.agents/agent_assets_metadata.toml` deleted; `replit.md` is now `docs/ARCHITECTURE.md`; `scripts/validate.mjs --check-config` removed.
- Storage pricing env renamed to `STORAGE_PROVIDER_USD_PER_GIB_MONTH` (default unchanged).

Kept on purpose: the `stripe-replit-sync` npm package. It is a host-independent Stripe-to-Postgres sync library (migrations, managed webhook, backfill, `stripe.*` mirror tables) that billing depends on; replacing it would be a billing change.

**How to apply:** do not reintroduce host-specific fallbacks; add new settings as environment variables in `.env.example` and `render.yaml`. Memory notes marked "Historical (Replit-only)" describe behaviour that no longer exists.
