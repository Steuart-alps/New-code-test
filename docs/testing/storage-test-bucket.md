# Storage test bucket

The storage happy-path checks (`pnpm --filter @workspace/api-server run test:storage-happy-path`)
upload, sign, read and delete real objects in Google Cloud Storage. They run only against a
dedicated non-production bucket with its own service account, never the live bucket or the live
key. The runner refuses to start when the test bucket is also named by any application storage
variable, hands the test key to the test API alone, works inside a unique
`private/integration-<hex>` prefix, and empties that prefix when it exits.

## Variables

| Variable | Value |
| --- | --- |
| `GCS_STORAGE_TEST_BUCKET` | the test bucket's name |
| `GCS_STORAGE_TEST_SERVICE_ACCOUNT_JSON` | the test service account's JSON key (or `GCS_STORAGE_TEST_CREDENTIALS_FILE` with a path to it) |
| `GCS_STORAGE_TEST_PROJECT_ID` | optional; defaults to the key's project |

In GitHub these are repository secrets, read only by the `Storage happy-path checks` workflow
(`.github/workflows/storage-happy-path.yml`). Until they are set, that workflow reports a skip and
passes. They never go in Render or in the repository.

## What it checks

One after another, each against a freshly started test API:

- DocTrack and generic document uploads get the right tenant ACL, and another tenant cannot read them.
- PAT certificate attachments are bundled into the data export.
- The data export bundles DocTrack documents, SafeTrack risk assessments, contractor-portal
  certificates, compliance-item certificates and photos with identical bytes, and each CSV points
  at the archived file. Another tenant's file and a missing file are left out with a reason in
  `attachment-manifest.csv`. With a small `EXPORT_ATTACHMENT_MAX_BYTES`, the files are split into
  numbered parts (`?part=N`); part 1 holds what fits and the manifest and README name the later parts.
- FixTrack issue media: an iPhone-style JPEG (with a rotation tag) and an AVIF become upright JPEGs
  and show after a reload. A real HEIC photo, a cut-off JPEG, a GIF and text posing as MP4 are
  refused with a message and never attached. MP4, MOV and WebM clips are stored unchanged, served
  in byte ranges, readable by staff but not by a Viewer (Viewers see only their own training) or another business, and play and seek in Chromium
  after a reload. Viewers cannot upload or attach.
- DocTrack sign-off status and registers.

## One-time setup (Google Cloud console)

1. **Check the live bucket's location.** Cloud Storage > Buckets, note the Location of the bucket
   in Render's `PRIVATE_OBJECT_DIR` (the first part of `/bucket/private`).
2. **Create the test bucket.** Cloud Storage > Buckets > Create.
   - Name: for example `complytrack-storage-tests` (names are global, so add a suffix if taken).
   - Location: Region, the same region as the live bucket. Storage class: Standard.
   - Access control: Uniform, with "Enforce public access prevention" on.
   - Data protection: turn soft delete off and leave object versioning off, so deleted test files
     are not kept and billed.
3. **Add a clean-up rule.** Open the bucket > Lifecycle > Add a rule: action "Delete object",
   condition "Age" 1 day. This removes anything a crashed run leaves behind.
4. **Create the service account.** IAM & Admin > Service accounts > Create service account,
   named for example `complytrack-storage-tests`. Grant it no project roles; click Done.
5. **Give it this bucket only.** Back in the test bucket > Permissions > Grant access. Principal:
   the service account's email. Role: Storage Object Admin.
6. **Create its key.** Service accounts > the new account > Keys > Add key > Create new key > JSON.
   A `.json` file downloads.
7. **Store it in GitHub.** Repository > Settings > Secrets and variables > Actions > New repository
   secret, twice: `GCS_STORAGE_TEST_BUCKET` with the bucket name, and
   `GCS_STORAGE_TEST_SERVICE_ACCOUNT_JSON` with the whole contents of the `.json` file. Then delete
   the downloaded file.
8. **Run it.** Actions > Storage happy-path checks > Run workflow. The log should show
   "signed PUT and GET both work" and finish with "the run prefix is empty".

## Cost

An empty bucket with a 1-day clean-up rule stores almost nothing, and each run makes a few hundred
small requests, so the Google Cloud charge should be pennies a month at most. Each workflow run
uses a few minutes of GitHub Actions time; it runs only when storage code changes or on demand.

## Release validation

`node scripts/validate.mjs --all` (or `node scripts/validate.mjs storage-happy-path`) includes
these checks in its integration stage. With no `GCS_STORAGE_TEST_*` variable set, the step prints
`SKIP: storage happy-path checks did not run` and the summary lists it as
`SKIP (not configured)`, never as a pass. Set `STORAGE_HAPPY_PATH_REQUIRED=1` to make a missing
bucket fail instead. A partly set configuration, or a test bucket that matches an application
bucket, always fails. When it runs, the suites run one after another only after the bucket
pre-check passes, and the run's folder is emptied afterwards whether they pass or fail.

## Running it elsewhere

Any machine with `DATABASE_URL` (a test database), `SESSION_SECRET` and the variables above can
run `pnpm --filter @workspace/api-server run test:storage-happy-path`. Keep the key in a file
outside the repository and point `GCS_STORAGE_TEST_CREDENTIALS_FILE` at it. The FixTrack media suite also
needs Playwright's Chromium (`pnpm exec playwright install chromium`, or `CHROMIUM_PATH` pointing
at a Chromium binary).
