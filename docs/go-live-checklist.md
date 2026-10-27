# Go-live checklist: Monday 26 October 2026

Your go-live list for **Monday 26 October 2026** (web only), most important first. Tick each box here on GitHub as you finish it. Where it says *type* something, type it in the thread named, and that thread will check and confirm.

This change only adds this list as `docs/go-live-checklist.md`. It doesn't change the app, and it won't be merged unless you ask.

Full detail for each step: the [launch plan](https://claude.ai/artifact/EamQtVRfUM4WcDS72gW8Bc).

## Must do before Monday

- [x] **1. Set the admin email on Render** (5 min). Render → **complytrack** → **Environment** → add `ADMIN_EMAIL` = `info@alpsconsultancy.co.uk` → **Save, rebuild and deploy**. Without it, owners can't ask to delete their data, and you get no billing or new sign-up emails. Type "admin email set" in [Launch plan for 26 October][launch]. *Done 27 Oct.*
- [x] **2. Fix the VAT setting in Stripe** (5 min). Stripe → **Settings** → **Tax** → **Settings** → "Include tax in prices" = **No (Exclusive)**. At the moment £10 is charged as £8.33 + £1.67 VAT instead of £10 + £2 VAT. Type "tax set" in [Accounting and VAT][vat]. *Done 27 Oct: prices now follow the Exclusive default.*
- [x] **3. Answer the Terms questions** (5 min), in [Launch plan for 26 October][launch]:
  - Is it right that an extra site is charged £10 straight away? (That's what the app does. The new Terms say so.)
  - Should the Terms be governed by Scots law and Scottish courts? The company is registered in Scotland. There's a card in the thread to tap.
  - What is the registered office address? The website must show it with the company number.
- [x] **4. Do the £12 billing test** (20 min, refunded; after step 2). Follow the [billing test steps](https://claude.ai/code/artifact/f6391a14-0a2a-4333-baf4-25a99e93f314). Type "billing test done" in [Billing test for Steuart][billing]. *Done 27 Oct: your own trial ran out and a real live payment went through.*
- [x] **5. Approve the public pages: type "merge 161"** (15 min to look) in [SEO and positioning][seo]. This adds 28 pages Google can find: modules, pricing and free printable logs.
- [x] **6. Approve the Terms and sign-up email: type "merge 162"** (10 min; after step 3, so the company details can go in first) in [Launch plan for 26 October][launch].
- [x] **7. Review the "not compliant until the certificate arrives" change** (10 min, once its thread says it's ready, ideally by Friday) in [Contractor reminders across tracks][contractor]. If it isn't ready by Friday evening, leave it until after launch.
- [ ] **8. Run the 15-minute live site test** (15 min; after steps 5 and 6). The steps are under "Your 15-minute live site test" in the [launch plan](https://claude.ai/artifact/EamQtVRfUM4WcDS72gW8Bc#smoke): sign up from the ALPS website, check the welcome email, add a site, invite staff, record a check with a photo, reset a password, download the export, and open `/readyz`. Report anything odd in [Launch plan for 26 October][launch].
- [ ] **9. Point the ALPS website at sign-up** (30–45 min, your site editor). Every "Start free trial" button should link to `https://complytrack.alpsconsultancy.co.uk/signup`. The suggested ComplyTrack section text is in the [launch plan](https://claude.ai/artifact/EamQtVRfUM4WcDS72gW8Bc#website).
- [ ] **10. Stop planned changes from Friday evening** (a decision). Until Tuesday, merge only fixes for real problems. Every merge restarts the live site.

## Launch days

- [ ] **Sun 25 · Schedule the week 1 LinkedIn post for 08:30 Monday** (10 min), from your own profile. Use the [weekly posts](https://claude.ai/artifact/WXAGU1QWNkDUBytqir7eJS) with a real site-visit photo. The clocks go back that night.
- [ ] **Mon 26, 07:30 · Check the site is ready** (5 min). Open `https://complytrack.alpsconsultancy.co.uk/readyz`. It should say **ready**; if not, paste what it says into [Launch plan for 26 October][launch].
- [ ] **Mon 26, 08:30 · Launch post goes out** (15 min). Share it from the ALPS LinkedIn page, and add it as a news item on the ALPS website and as an update on your Google Business Profile.
- [ ] **Mon 26 onwards · Welcome every new sign-up personally** (10 min each). After #162 you get an email for each new business. Phone them or send a short personal email the same day.
- [ ] **Tue 27, 09:00 · Send the email to existing ALPS clients** (30 min). The draft is in the [launch plan](https://claude.ai/artifact/EamQtVRfUM4WcDS72gW8Bc#client-email).
- [ ] **Mon 26, end of day · Tell us how it went** (2 min): the number of sign-ups and anything odd, in [Launch plan for 26 October][launch].

## Good to do before Monday

- [ ] **Type "merge 165"** in [Fire alarm call point rotation][callpoints] (10 min). It adds call point locations, your test order and a "next to test" suggestion. Also answer its question: did you want a photo or floor plan for each call point too?
- [ ] **Set up your own site with QR labels** (30 min) using the [QR labels guide](https://claude.ai/code/artifact/f5a0187e-f137-449f-a341-54f6a748dd6e), so you can show it off on launch day.
- [ ] **Add your real examples for weeks 2 and 9 of the posts, and say which areas your consultants cover** (15 min) in [SEO and positioning][seo]. Week 2 goes out on 2 November.
- [ ] **Google Business Profile** (15 min, free). Check or create it at business.google.com. Google's check that you're the business can take several days, so start early.
- [ ] **Google Search Console** (20 min, free; after step 5). Add `complytrack.alpsconsultancy.co.uk`, prove it's yours with a TXT record at one.com, and submit `/sitemap.xml`.
- [ ] **Free "site down" alert** (10 min, uptimerobot.com). Watch `https://complytrack.alpsconsultancy.co.uk/healthz` every 5 minutes and alert info@.
- [ ] **Check backups and set a spending alert** (10 min). On Render, check the **Recovery** page of **complytrack-db** lists backups. In Google Cloud, add a £10 a month budget alert under **Billing → Budgets & alerts**.
- [ ] **Tidy Stripe for customers** (10 min). Under **Public details**, use a statement name customers will recognise, plus a support email. Under **Customer emails**, turn on receipts and failed-payment emails.
- [ ] **Add ComplyTrack to your email signature** (2 min): "Try ComplyTrack free for 14 days: complytrack.alpsconsultancy.co.uk".
- [ ] **Check ALPS pays the ICO data protection fee** (5 min). If it doesn't, it's about £52 a year.

## After launch (not needed for Monday)

- [ ] **Sentry error alerts** (15 min, free). Follow `release/sentry-setup.md` in the project files, and report in [Sentry error reports][sentry].
- [ ] **Anthropic key, and pick the first AI feature** (15 min) in [Live AI in ComplyTrack][ai]. The key also switches on "Suggest actions from the report".
- [ ] **Storage test bucket** (20 min), following the steps in [Test storage bucket][bucket].
- [ ] **Questions waiting for you in other threads:**
  - [ ] [Future developments roadmap][roadmap]: your comments on the order and the open questions (#163)
  - [ ] [Actions from uploaded audit reports][audit]: should the action plan email go to anyone besides Owners and Managers?
  - [ ] [Contractor reminders across tracks][contractor]: the contractor approval question
  - [ ] [KitchenTrack allergen charts][allergen]: type "merge 169" when you want the allergen charts
- [ ] **Phone apps (iPhone, then Google Play)** in [Store app or home-screen web app][phone].

**Already done and live:** release #160 (COSHHTrack, QR labels, NSTS tests, contractor visits, department bars), #164 GreenTrack hours and spraying book, #166 reminders to the person responsible plus the Owner's weekly update, #167 certificate follow-up, #168 report actions, #170 FixTrack contractors. #171 (certificate chasing) is being merged now.

[launch]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb2J8cKrUPm5qUmd56BLG447H
[vat]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb2XDNp74J4rzn1WEEHci4jS3
[billing]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb23rnNbUPq817D9B7U5XBn3j
[seo]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb2Q3FTFq7XCeTws6kszdJJba
[contractor]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb2P6nkYT85TuSmBeJ9XvshnJ
[callpoints]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb2HuoVPKPzcWmVeBDgjjSdSG
[sentry]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb25LqGHig5EcCBYAnTPFKv7Y
[ai]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb24ay9xVNzQuM96uHyfnPMoV
[bucket]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb2LdpP53pjd6f9XsDYB4siga
[roadmap]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb28ioXthKErZg1bJK7dbcsqM
[audit]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb2QaKWPb1Fm91fs5xidVgWpR
[allergen]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb2FMd5yvdioRJHhsbHMpfAMq
[phone]: https://claude.ai/code/project/chan_017gxrQu26ZN3F7m6EsPijb2?thread=cmsg_017gxrQu26ZN3F7m6EsPijb2L1yNJCuqyZHr8HteXmtNmn
