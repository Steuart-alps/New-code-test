---
name: Trial lock enforcement
description: How expired free trials are enforced (402 lock) and how access is restored
---
Rule: when clients.trial_ends_at is past and there is no live Stripe subscription (active/trialing/past_due via findLiveSubscription), all /api data routes return 402 { code: "trial_expired" }; /auth, /billing and /healthz stay open.
**Why:** closes the revenue gap of clients using the app forever after trial; billing must stay reachable so consultants AND client_admins can pay (billing checkout/portal/invoices allow both roles).
**How to apply:** lock decision is cached per client (locked 15s, unlocked 5min) and fails open on Stripe errors. POST /api/billing/refresh-access invalidates the cache — any new "instant unlock" path should call invalidateTrialLock rather than shortening TTLs. Frontend reacts to 402 via setPaymentRequiredHandler (lib/api-client-react) and renders the trial-ended lock screen.
