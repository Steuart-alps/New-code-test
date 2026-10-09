---
name: Photo storage round trip
description: How the real browser photo upload round trip is isolated from application storage and how its fake mode is labelled.
---

`pnpm --filter @workspace/api-server run test:photo-storage-roundtrip` drives the real incidents page through sign-in (production CSRF + mandatory 2FA), presign, direct browser PUT, attach/finalize, reload, tenant-boundary checks and delete. Storage comes only from `PHOTO_ROUNDTRIP_*` variables; the config gate refuses a bucket named by any application bucket/path variable and skips (exit 0, `SKIP:`) when unconfigured unless `PHOTO_ROUNDTRIP_REQUIRED=1`.

**Why:** The run creates and deletes real objects; reusing the application bucket or its credentials could touch customer data. The API under test is started with `env -i`, so application storage variables never reach it, and every run uses a fresh database, fresh tenants and a unique `private/photo-roundtrip-<hex>` prefix emptied in the exit trap.

**How to apply:** The API serves the built web app from the same origin, so the browser test intercepts nothing. Real mode needs a service-account key (V4 signing) and bucket CORS allowing `http://127.0.0.1:<PHOTO_ROUNDTRIP_WEB_PORT>` (default 5317). `--in-process-fake` swaps only `objectStorageClient.bucket()` and maps storage.googleapis.com to a local HTTPS fake inside the test browser; it proves the test logic, never the real GCS round trip. The 1x1 PNG in the mocked browser suites has a bad CRC and is rejected by real validation — generate checksummed PNGs for real-API tests.
