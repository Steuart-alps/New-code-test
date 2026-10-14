# ComplyTrack mobile: App Store and Google Play launch pack

This covers how to ship `artifacts/mobile` (Expo SDK 57) as EAS standalone builds.
Expo Go stays the development loop (`pnpm --filter @workspace/mobile run dev`).
Every native-only feature must stay optional when its module is missing, because
Expo Go doesn't include it.

What's already in the repository:

- **Store identifiers.** `uk.co.alpsconsultancy.complytrack` is both the iOS bundle ID and the Android package.
  - Version `1.0.0`, iOS build `1`, Android versionCode `1`.
  - `eas.json` uses `appVersionSource: local`, so you raise these numbers in `app.json` yourself before each upload.
- **Store config** (checked by `pnpm --filter @workspace/mobile run test:store-compliance`):
  - Icon: an opaque 1024×1024 `assets/images/app-icon.png`, plus an Android adaptive icon and a navy splash screen.
  - Encryption: `ITSAppUsesNonExemptEncryption=false`, because the app only uses HTTPS.
  - Permissions: photo and camera wording, no microphone, and location/overlay permissions blocked. `expo-location` is excluded from linking.
- **Build profiles** (`eas.json`):
  - `development`, `preview` and `production` all set `EXPO_PUBLIC_DOMAIN=complytrack-aavy.onrender.com`.
  - Production Android builds an app bundle (`.aab`).
  - `submit.production.android` uploads to the **internal** track as a **draft**, using `artifacts/mobile/google-play-service-account.json`. That file is gitignored, so never commit it.
- **In-app legal links and account deletion.** Privacy policy and terms links are on the sign-in and Profile screens. Profile also has **Delete my account** (see "Account deletion" below).

## 1. Steps for Steuart

Run these on your own computer from `artifacts/mobile`. You need Node 24 and the repository up to date on `main`.

1. **Deploy the API first.** Mobile builds from this branch send a `clientEntryId` with each fire, legionella, hot tub, PAT and incident record, so a resend after a lost response doesn't create a duplicate. An older API ignores the field, which would bring the duplicates back. Merge this branch and let Render deploy before you build.
2. **Apple Developer Program**, £79 a year: <https://developer.apple.com/programs/enroll/>.
   - Enrol as the legal entity, ALPS Consulting Ltd (it trades as ALPS Consultancy; "ALPS Consultancy Ltd" is a different company), so the store shows the company as the seller. That needs a D-U-N-S number, which Apple can look up or request for free.
   - Enrolling as an individual shows your personal name instead.
3. **Google Play Console**, US$25 one-off: <https://play.google.com/console/signup>.
   - Choose an **organisation** account (it also needs the D-U-N-S number).
   - Personal accounts created since November 2023 must run a closed test with at least 12 testers for 14 days before they can publish to production. Organisation accounts are exempt.
4. **Log in to Expo:** `npx eas-cli@latest login`. Create a free account at expo.dev first if you don't have one.
5. **Link the project:** `npx eas-cli@latest init`.
   - This writes `extra.eas.projectId` (and `owner`) into `app.json`. Commit that change.
   - Push notifications stay off until it's done: `lib/push.ts` needs the project ID.
   - If PR #77 is merged first, the project has an `app.config.js`. `eas init` may then print the ID for you to paste into `app.json` under `expo.extra.eas.projectId`, because `app.config.js` spreads `app.json`.
6. **Set `EXPO_PUBLIC_DOMAIN`.**
   - It's already set per profile in `eas.json`. Change it there if the API moves to a custom domain, for example `www.alpsconsultancy.co.uk`.
   - The legal links use `https://www.alpsconsultancy.co.uk`. Set `EXPO_PUBLIC_SITE_URL` in the profile's `env` if that domain isn't live yet.
   - `pnpm run export:ios` refuses to bundle without `EXPO_PUBLIC_DOMAIN`.
7. **Create the store records:**
   - In App Store Connect: My Apps > + > New App. Platform iOS, name "ComplyTrack", primary language English (UK), bundle ID `uk.co.alpsconsultancy.complytrack` (EAS registers it on the first build if it isn't listed yet), SKU `complytrack-ios`.
   - In Play Console: Create app. Name "ComplyTrack", default language English (United Kingdom), App, Free.
8. **Build:**
   - iOS: `npx eas-cli@latest build -p ios --profile production`. Sign in with your Apple ID when asked, and let EAS create the distribution certificate, provisioning profile and push key (answer **yes** to setting up Push Notifications).
   - Android: `npx eas-cli@latest build -p android --profile production`. Let EAS generate the upload keystore.
9. **Android push (optional for launch).** Expo push on Android needs Firebase Cloud Messaging:
   - Create a Firebase project and add an Android app with the package name above.
   - Add its `google-services.json` to `artifacts/mobile`, and set `"googleServicesFile": "./google-services.json"` under `expo.android` in `app.json`.
   - Upload an FCM V1 service-account key with `npx eas-cli@latest credentials` (Android > production > Google Service Account > FCM V1).
   - Without this, Android works fully but receives no push notifications. iOS push only needs step 8.
10. **Submit to Apple:** `npx eas-cli@latest submit -p ios --latest`. It asks for the App Store Connect app, then uploads the build to **TestFlight**.
    - Once processed (about 10 to 30 minutes), go to App Store Connect > TestFlight > Internal Testing.
    - Add yourself and staff as internal testers and install with the TestFlight app.
11. **Submit to Google.**
    - Google doesn't accept the first upload through the API. Download the `.aab` from the EAS build page, then in Play Console go to Testing > Internal testing > Create new release and upload it there.
    - After that, create a Google Cloud service account with "Release manager" access to the app (Play Console > Users and permissions). Save its JSON key as `artifacts/mobile/google-play-service-account.json`.
    - For later uploads use `npx eas-cli@latest submit -p android --latest`, which creates a draft on the internal track. Add testers' Google accounts to the internal testing list and share the opt-in link.
12. **Run the iPhone smoke test** on the TestFlight build (see section 9), plus the Android equivalent on the internal-testing build.
13. **Fill in the listings** (sections 2 to 7), then submit for review:
    - Apple: App Store > iOS App > 1.0 > Add for Review.
    - Google: promote the internal release to Production, or to a closed track first.
14. **For each later release,** raise `version` (for user-visible changes) and always raise `ios.buildNumber` and `android.versionCode` in `app.json`. Then build and submit again.

### What the open PRs add to the build

- **PR #77, native passkeys** (`claude/mobile-passkeys-ionei1`):
  - **`app.config.js`.** It replaces `app.json` as the entry point but spreads it.
    - The bundle ID and package come from `MOBILE_IOS_BUNDLE_ID` / `MOBILE_ANDROID_PACKAGE`. Leave them unset, or set them to `uk.co.alpsconsultancy.complytrack`, so they match the store records above.
    - It adds iOS `associatedDomains: ["webcredentials:<EXPO_PUBLIC_DOMAIN host>"]`. EAS turns on the Associated Domains capability for the App ID on the next build.
  - **Dependency:** `react-native-passkeys` 0.4.2. This is a native module, so passkeys only work in EAS builds, not in Expo Go.
  - **Server routes:** `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`. Both return 404 until four variables are set on Render:
    - `MOBILE_IOS_TEAM_ID`: from Apple Developer > Membership.
    - `MOBILE_IOS_BUNDLE_ID`.
    - `MOBILE_ANDROID_PACKAGE`.
    - `MOBILE_ANDROID_CERT_SHA256`: use the **app signing key** SHA-256 from Play Console > Test and release > App integrity, not the upload key.
    The PR adds these to `render.yaml` and `.env.example`. Passkeys only work when `EXPO_PUBLIC_DOMAIN` is the host that serves those files.
  - **Merge conflicts:** it edits `app/(tabs)/profile.tsx`, `app/(auth)/login.tsx` and `lib/auth.tsx`, which this launch branch also changed. Expect conflicts in those three files.
- **PR #68, PAT tag scanning** (`claude/pat-tag-scanning-z34sb3`):
  - Adds `expo-camera` ~57.0.6 with `recordAudioAndroid: false`.
  - The camera permission wording here already covers "scan appliance asset tags", and `RECORD_AUDIO` stays blocked. If the camera plugin sets its own camera wording, keep it the same as the `expo-image-picker` text.

## 2. App Store listing (draft)

| Field | Text |
| --- | --- |
| Name (30 max) | ComplyTrack |
| Subtitle (30 max) | Health & safety compliance |
| Category | Primary: Business. Secondary: Productivity |
| Support URL | https://www.alpsconsultancy.co.uk |
| Marketing URL | https://www.alpsconsultancy.co.uk |
| Privacy policy URL | https://www.alpsconsultancy.co.uk/privacy |
| Copyright | 2026 ALPS Consulting Ltd |
| Keywords (100 max) | `health and safety,compliance,fire safety,legionella,PAT testing,RIDDOR,HACCP,checklist,audit,risk` |

**Promotional text** (170 characters max; this can be changed without a new review):

> Your team's daily health and safety checks, in their pocket. Log fire, water, kitchen and PAT checks, report issues with photos, and see what is due today.

**Description:**

> ComplyTrack is the mobile companion to the ComplyTrack health and safety compliance service for UK businesses. Your team signs in with the account their manager set up and records the checks your risk assessments call for, wherever they are on site.
>
> TODAY AT A GLANCE
> • Compliance status for every module at the selected site
> • My tasks today, with one-tap "Mark done"
> • Open issues and quick links to the checks that are due
>
> RECORD CHECKS
> • FireTrack: fire alarm, emergency lighting, extinguisher and fire-walk checks
> • LegionellaTrack: water temperatures and flushing (L8 / HSG274)
> • HotTubTrack and AquaTrack: hot tub and pool water tests and swim sessions
> • KitchenTrack: food safety diary, temperature checks and cleaning schedules
> • DailyTrack: opening and closing checklists
> • PATtrack: portable appliance tests
> • GreenTrack: pre-use checks for grounds equipment
> • IncidentTrack: accidents and incidents, with RIDDOR deadlines
>
> REPORT AND FIX ISSUES
> • Report a fault with photos from the camera or library
> • Follow each issue from open to resolved
>
> DOCUMENTS
> • Risk assessments, certificates and training records for your sites
>
> WORKS ON PATCHY SIGNAL
> Checks you record without a connection are saved on the device and sent automatically when you are back online, without creating duplicates.
>
> SECURE BY DESIGN
> Each business only sees its own data. Two-factor sign-in protects accounts, and viewer accounts are read-only.
>
> ComplyTrack needs an account from your employer or health and safety consultant. Businesses can start at www.alpsconsultancy.co.uk.

## 3. Google Play listing (draft)

- **App name:** ComplyTrack
- **Short description** (80 max): `Log health & safety checks, report issues and track compliance on site.`
- **Full description:** use the App Store description above (Google allows 4,000 characters, so it fits as is).
- **Category:** Business. **Tags:** Business, Productivity.
- **Contact details:** website `https://www.alpsconsultancy.co.uk`, and the support email address you want to publish (required).
- **Store graphics:**
  - 512×512 icon: resize `assets/images/app-icon.png`.
  - 1024×500 feature graphic: the navy `#061537` background with the shield and "ComplyTrack".

## 4. Privacy answers (from what the code collects)

What the app sends to the ComplyTrack API (`EXPO_PUBLIC_DOMAIN`, HTTPS):

- **Account details:** sign-in email, password and the two-factor code. Users' names are shown on records ("performed by", "reported by", task completions).
- **Business records the user enters:** check results, notes, task completions, issues and cleaning sign-offs.
- **Incident reports:** the involved person's name and job title, injuries sustained, first aider, witnesses and RIDDOR details. Incident health details are redacted from users who aren't allowed to see them.
- **Photos** the user chooses to attach (camera or library). These go to Google Cloud Storage as evidence.
- **Push notifications:** the Expo push token and platform (`POST /api/mobile/push-token`), stored against the user. It's deleted on sign-out.
- **Not collected:**
  - No location (the module is excluded and the permissions are blocked).
  - No contacts, microphone, advertising ID, third-party analytics, crash reporting or tracking SDK.
  - The web app's first-party analytics aren't used by the mobile app.
- **Stored only on the device:** the session token (SecureStore) and the offline outbox of unsent records (AsyncStorage). The outbox is kept per user and set aside on sign-out; it only sends again when the same user signs back in.

### Apple App Privacy label

- **Data used to track you:** none. Tracking: **No**.
- **Data linked to you** (purpose for all: App Functionality; none used for analytics, advertising or personalisation):

| Apple category | Data type | Why |
| --- | --- | --- |
| Contact Info | Name, Email Address | Sign-in, attribution on records |
| Health & Fitness | Health | Injury details in incident reports |
| User Content | Photos or Videos | Evidence photos on issues and checks |
| User Content | Other User Content | Check records, notes, issues, incidents |
| Identifiers | User ID | Account ID; the push token is stored per user |

- **Data not linked to you:** none.
- **Diagnostics:** not collected.

### Google Play Data safety

- **Does the app collect or share user data?** Yes, it collects data; it shares none. Google Cloud Storage and Render are service providers, which Google doesn't count as sharing.
- **Is all data encrypted in transit?** Yes.
- **Can users request deletion?** Yes, in the app (Profile > Delete my account), on the web or by contacting ALPS.
- **Data collected** (all required for the app to work; purpose for all: App functionality and Account management; processed, not shared):
  - **Personal info:** Name; Email address; User IDs.
  - **Health and fitness:** Health info (injury details in incident reports).
  - **Photos and videos:** Photos.
  - **App activity:** Other user-generated content (check records, issues, incidents).
  - **Device or other IDs:** Device or other IDs (the push token).
- **Not collected:** location, financial info, messages, audio, contacts, calendar, web browsing, app info and performance (no crash logs or diagnostics).

> **Needs a decision:** the public privacy policy (`/privacy` on the web app) doesn't yet mention the mobile app, push-notification tokens, evidence photos or the incident health data listed above. Apple and Google both check that the policy matches these answers. Update it before submitting.

## 5. Account deletion (App Review 5.1.1(v), Google account-deletion policy)

The app can't create accounts; it only signs in to accounts set up on the web. Even so, Profile > **Delete my account** (`app/account/delete.tsx`) gives a path for each role:

- **Business owners** (`client_admin`, and consultant owners) use the existing `/api/data-deletion/request`. The screen shows whether the business can be erased.
  - Owners on a paid plan are told to cancel the subscription on the web first, with links to web Settings and to ALPS.
- **Staff and viewers** are told their manager removes their account, with an ALPS contact link.

> **Needs a decision:** there's no server endpoint for one user to delete only their own login. Reviewers usually accept this for business apps without in-app sign-up, but a reviewer could still ask for it.
>
> Google Play also asks for a **web link** where users can request deletion. Use the privacy policy URL if it describes the process, or add a short page.

## 6. App Review notes (Apple) / App access (Google)

Mandatory two-factor sign-in is enforced by `isTwoFactorRequired` in `artifacts/api-server/src/lib/twoFactorPolicy.ts`.

- **How the code decides:** a user can skip TOTP only when **every** business they belong to has the setting `requireTwoFactor` set to `"false"`. Consultants also count their linked clients. Without that, the app asks for a 6-digit authenticator code. If the user hasn't enrolled yet, the app shows "Set up two-factor authentication" and links to the web.
- **Turning it off:** an owner can switch it off for one business in web **Settings > Require two-factor authentication** (`PUT /api/settings`, `client_admin` or consultant).

Reviewers can't easily use an authenticator app, so the approach that exists in the code is a **dedicated demo business with two-factor turned off**:

1. On the web, as consultant, create a client business "ComplyTrack Demo". Make sure it's on an active plan or consultant-managed, so the trial lock doesn't block it.
2. Add one or two sites and some sample records: a few checks, an open issue, an incident, PAT appliances, and a document or two.
3. Create staff tasks assigned to the reviewer account, due daily, so "My tasks today" has items.
4. In that business's Settings, switch off **Require two-factor authentication**.
5. Create a **client_admin** user, for example `appreview@…`, belonging **only** to that business, with a strong password.
   - It must not be a consultant linked to other businesses, or 2FA comes back.
   - Choose client_admin so the reviewer sees the full app and the owner's deletion screen. Staff accounts can't see the business erasure flow.
6. Give the reviewer the email and password in App Store Connect (App Review Information > Sign-in required) and in Play Console (App content > App access).

Suggested note:

> ComplyTrack is a business health and safety compliance tool. Accounts are created by the employer or their consultant on the web; the app has no sign-up. Use the demo account below, which belongs to a demo business with two-factor authentication turned off for review (real customer accounts must use an authenticator app). Profile > Delete my account shows the account deletion route: owners request erasure of the business's data; staff accounts are removed by their manager. Photos are only used as evidence attached to issue reports and check records. The app uses HTTPS only (no non-exempt encryption).

The demo business stores sample data only; don't put real customer data in it. Turn two-factor back on, or delete the account, if the app is ever removed.

## 7. Age rating

- **Apple** (age rating questionnaire): answer **None/No** to every content question. That covers violence, sexual content, profanity, horror, drugs, alcohol and tobacco, gambling (simulated or real), contests, medical or treatment information, and mature themes.
  - Unrestricted web access: **No**. The app only opens its own privacy, terms, settings and contact pages.
  - User-generated content shared publicly: **No**. Records are visible only inside the user's business.
  - Messaging or chat: **No**. Advertising: **No**. Parental controls / age assurance: **No**.
  - Expected rating: **4+**.
- **Google** (IARC questionnaire, category "Utility, Productivity, Communication, or Other"):
  - Violence, sex, language, controlled substances, gambling: **No**.
  - Users can interact or exchange content: **Yes**, limited to members of the same business (shared records). No sharing with strangers.
  - Shares the user's location: **No**. Purchases of digital goods: **No**.
  - Expected rating: **PEGI 3 / Everyone** (possibly with the "Users Interact" note).
  - **Target audience:** 18 and over. **Contains ads:** No.

## 8. Screenshots

Use the demo business, with real-looking but fictional names, in light mode. Capture these screens, in this order:

1. Sign-in
2. Today, with compliance status and "My tasks today"
3. Checks list
4. FireTrack check form
5. New issue with a photo attached
6. IncidentTrack form
7. PATtrack appliance list
8. Docs

| Device | Size (portrait) | How |
| --- | --- | --- |
| iPhone 6.9" (required) | 1320 × 2868 | iPhone 16/17 Pro Max simulator, or a real Pro Max |
| iPhone 6.5" | 1284 × 2778 (1242 × 2688 also accepted) | iPhone 11 Pro Max / XS Max simulator |
| Android phone | 1080 × 1920 or larger, 9:16 to 9:20 | Pixel 8 emulator; Play needs 2 to 8 screenshots |

App Store Connect needs 3 to 10 screenshots per size. iPad screenshots aren't needed: `supportsTablet` is off, so the app ships as iPhone-only.

## 9. Pre-submission checklist

- [ ] API with the replay support (this branch) is deployed to Render, and `/readyz` is healthy.
- [ ] `pnpm run typecheck` passes, and all `pnpm --filter @workspace/mobile run test:*` scripts pass.
- [ ] `EXPO_PUBLIC_DOMAIN=complytrack-aavy.onrender.com pnpm --filter @workspace/mobile run export:ios` and `export:android` both succeed.
- [ ] `npx expo-doctor` is clean. Offline, it can only fail the two checks that need exp.host / reactnative.directory.
- [ ] `eas init` is done and `extra.eas.projectId` is committed. Push permission prompts appear on a real device.
- [ ] The privacy policy page is updated (section 4) and `https://www.alpsconsultancy.co.uk/privacy` and `/terms` load.
- [ ] Demo review business and account are set up, with 2FA off for that business only (section 6).
- [ ] `ios.buildNumber` / `android.versionCode` are higher than any previous upload.
- [ ] **iPhone smoke test:** work through `/mnt/project-files/mobile/iphone-smoke-test.md` on the **TestFlight** build. That checklist was written for Expo Go; for the TestFlight build, skip its "Start the app" section. Do the same checks on Android internal testing:
  - opens and signs in
  - every tab loads
  - back navigation
  - keyboard
  - camera photo on a new issue
  - sign out
- [ ] Also check on a device:
  - mark a task done
  - record a check in flight mode, then reconnect and confirm it sends once
  - Profile > Privacy links and Delete my account
  - large text (Settings > Accessibility > Larger Text) doesn't clip buttons or fields
  - VoiceOver reads the back and add buttons
- [ ] **Open passkey/scanning PRs:** decide whether **#77** (native passkeys) and **#68** (PAT tag scanning) go into 1.0. Both are still waiting for device testing. If included, merge them before the production build and resolve the conflicts listed in section 1. Then set the four `MOBILE_*` variables on Render and confirm `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` return 200. Otherwise, ship 1.0 without them and add them in 1.1.
- [ ] App Store: export compliance is answered automatically by `ITSAppUsesNonExemptEncryption`. Content rights: no third-party content. Sign in with Apple isn't required, because there's no third-party login.
- [ ] Play: App content is complete (privacy policy, app access, ads, content rating, target audience, data safety, government app: no, financial features: none, health apps declaration: not a health app).
