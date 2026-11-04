# ComplyTrack roadmap: future developments

Written 21 October 2026 for Steuart. This is a plan only; nothing in it has
been built yet unless it says so.

The web launch is **Monday 26 October 2026** (website only; the phone apps
follow). Every item is marked:

- **Before launch**: needed or useful by 26 October.
- **After launch**: starts once the website is live and settled.

A change freeze is suggested from Friday 23 October evening to Tuesday
27 October (fixes only), so new features below start no earlier than
Wednesday 28 October.

## At a glance

| # | Item | When | Extra running cost | Waiting on |
|---|---|---|---|---|
| 1 | Greens vehicle maintenance (GreenTrack) | After launch | None | Your go-ahead (hour meters and spraying book are now live, #164) |
| 2 | Scanning certificates for key dates and contractor details | After launch | About 0.1p per certificate read | Anthropic key on Render; your go-ahead |
| 3 | Reminders to the right person, weekly Owner update | After launch | None | Your go-ahead |
| 4 | Phone apps: iPhone first, then Android | After launch | Apple £79 a year, Google $25 once | Trying draft #101 on a phone |
| 5 | Live AI: COSHH drafts from safety data sheets | After launch | About 23p per draft | Your pick of first AI feature; Anthropic key |
| 6 | Live AI: help chat for users | After launch | About £35 a month at 500 chats | A help guide written first |
| 7 | Track summary recipient preview (#125) | After launch | None | Re-doing for the new Manager roles |
| 8 | International: Ireland first, then AU/NZ/Canada, US last | After launch | None for hosting; higher card fees abroad | Your answers to 6 questions |
| 9 | Error reports (Sentry) | Before launch if you have 10 minutes | None (free plan) | Your set-up steps |
| 10 | Offline working | After launch | None for the recommended route | Phone app first |
| 11 | Actions from uploaded audit and inspection reports | After launch | Pennies per report (being worked out) | Plan in its own thread |
| 12 | CareTrack (care homes and care services) | Later | Not yet known | Scope from you |
| 13 | Kitchens: stock, costings, GP, recipe spec sheets, supplier details, recipe ideas for leftovers, voice | After launch | None, except a few pence per AI spec sheet read or recipe suggestion | Nothing; allergen charts are live (#169) |
| 14 | Label scanning (chemicals, food, GreenTrack products, equipment plates) | After launch | About 1-2p per label read; more when it also finds a data sheet and drafts COSHH | Anthropic key on Render |
| 15 | FireTrack: sound level meter for fire alarm tests | After launch (with the iPhone app) | None | Phone app; your check of the dB limits |
| 16 | Temperature probes and sensors: Bluetooth probes, Wi-Fi fridge, freezer and water tank monitoring | After launch (probes with the phone app) | Hardware bought by each business; possibly a bigger database later | Phone app; choice of sensor make |
| 17 | Maintenance inventory: stock, cheapest supplier, low-stock reminder | After launch | None | Kitchen supplier price import for the cheapest supplier part |
| 18 | Reorder the side menu to each user's preference | After launch | None | Nothing |
| 19 | Bars: opening and closing checks (including beer tap tips) and bar stock | After launch | None | Your list of bar checks; how much stock detail you want |
| 20 | Send site safety information to contractors before their visit | After launch | None | Contractor sign-in work (in its own thread) |
| 21 | White-labelling for resellers (for example insurance brokers) | After launch | Possibly small extra email and web address costs per partner | Your answers on billing and what partners see |
| 22 | Let Owners choose the AI model and effort for each AI feature | After launch | Depends on the choices made; capped | AI features live first |
| 23 | Contractor sign-in on site and logging their own test results | After launch (you chose this on 28 October) | None | Your "go" in its own thread |
| 24 | Let Owners choose how often urgent alerts are sent | After launch | None | Nothing; urgent alerts stay same-day for now |
| 25 | Link TrainTrack to outside training providers | After launch | None for hosting; some providers may charge for a link | Which providers your clients use |
| 26 | Combine SafeTrack into DocTrack | After launch | None; affects pricing | Your call on pricing |
| 27 | One Owner login for several separate businesses | After launch | None | Your go-ahead |
| 28 | Staff roster "Open kiosk": show the shift starts it records | After launch | None | Nothing; you decided to keep the button |
| 29 | Management walk-round inspections for each track, plus one overall review | After launch | None | How often, who does them, and your existing checklists |
| 30 | KitchenTrack HACCP plan builder from your ALPS template | After launch | None for stage 1; a few pence per AI draft in stage 2 | Your wording of the CCP questions |
| 31 | Complete risk assessments inside ComplyTrack | After launch | None; a few pence per AI draft if added later | The RiskAssessor Pro layout you want to follow, and which assessments to start with |

My suggested order after launch is the order of the table, with 2, 5, 11 and
14 built together because they share the same set-up (one AI key and one
"read a document, a person confirms" screen). Tell me if you want a
different order.

---

## 1. Greens vehicle maintenance (GreenTrack)

**When:** after launch.

**What already exists.** GreenTrack is live. Each machine (mower, tractor,
utility vehicle) has its own record with make, model, serial and registration
number. Staff do daily pre-use checks, report defects and log fuel. Managers
record services (date, hours, work done, who did it, cost), PUWER and LOLER
thorough examinations, and NSTS sprayer tests (#158). Every machine can have a
QR label (#159) that opens its record when scanned.

**Done since this roadmap was started (#164).** The "Reviving GreenTrack"
thread has built two things you asked for this morning:

- hour meter readings and services due by hours (for example "next service at
  500 hours");
- a greens spraying book (what was sprayed, who sprayed it, when) with stock
  control for pesticides, fertiliser and top dressing, where each spray takes
  the product off stock.

Everything below builds on that work and does not repeat it.

**What comes next**, in the order I'd suggest:

1. **Service schedules from the maker's intervals.** Set a schedule per machine
   or machine type (for example a 50-hour check, 250-hour service and 500-hour
   major service), each with its own task list: oil and filters, belts, grease
   points, blade sharpening or backlapping for cylinder mowers, tyre pressures.
   The mechanic ticks the tasks off, so the service record shows exactly what
   was done, not just "serviced".
2. **Repair jobs (a workshop job card).** A failed pre-use check or a reported
   defect turns into a repair job with a status: waiting for parts, in the
   workshop, with the dealer, back in service. The machine stays marked "out
   of service" until someone signs it back in. This reuses the existing defect
   records rather than starting a second list.
3. **Parts used.** Record the parts on every service and repair: part number,
   description, supplier, quantity and price. Common parts (oil, filters,
   blades, bedknives) can be picked from a short list each business builds up.
4. **Running cost per machine.** Add up services, repairs, parts and fuel for
   each machine, per year and per hour of use. This helps with "repair or
   replace?" decisions and next year's budget. It reuses the costs already
   recorded on service records and the fuel log.
5. **Dealers and warranty.** Link each machine to its dealer from the existing
   Contractors list, so dealer services join the contractor reminders that went
   live in #155. Record the warranty end date, with a reminder before it runs
   out.
6. **Later options**, only if you want them:
   - A parts store: stock levels and a "running low" list for the shed's
     common parts, reusing the stock control being built for the spraying
     book, with parts taken off stock when a service or repair uses them.
   - Road-going utility vehicles: MOT, road tax and insurance dates for
     machines with a registration number.
   - Who may drive what: link each machine to the operators trained on it in
     TrainTrack, and warn when someone untrained does a pre-use check.

**Phone.** The mechanic should be able to scan a machine's QR label and log a
service or repair on the spot. The phone screens for GreenTrack service records
are already in draft #101, so this joins the phone app work (item 4).

**Notifications.** Follows your rule: service and repair reminders go only to
the person responsible for the machine, and the Owner sees them in the weekly
update (item 3), not as extra daily emails.

**Cost:** no extra hosting. Photos of receipts and parts count towards each
business's file storage allowance.

**Questions for you:** does a parts store matter to your clients, or is
"parts used per job" enough? Do any of them run utility vehicles on public
roads?

---

## 2. Scanning certificates for key dates and contractor details

**When:** after launch.

**The idea.** A manager uploads a certificate (PDF) or takes a photo of it:
gas safety, EICR, LOLER, fire alarm service, emergency lighting, extinguisher
service, legionella risk assessment or water sample, NSTS sprayer test, PAT,
a contractor's insurance or Gas Safe registration. ComplyTrack reads it and
fills in the details for them:

- type of certificate and what it covers (site, equipment or machine)
- date of the visit or test, and the next due or expiry date
- the result (pass or fail, satisfactory or unsatisfactory, any defect codes
  such as C1/C2 on an EICR)
- the contractor's company name, engineer, registration number (for example
  Gas Safe or NICEIC), phone, email and address

**The person stays in charge.** Nothing is saved until they see the details
side by side with the certificate and press "Confirm". The record shows that it
was read automatically and who confirmed it. This is the same rule as the Live
AI plan: the AI never approves anything on its own.

**What happens when they confirm:**

- The certificate file is stored against the right check, piece of equipment
  or machine.
- The next due date moves, so the existing contractor reminder (#155) fires at
  the right time and asks that contractor to book the next visit.
- The contractor is matched to the Contractors list, or added if they are new,
  with their phone and email filled in. Insurance and registration expiry
  dates feed the existing contractor document reminders.
- A failed or unsatisfactory result raises an action, or a FixTrack issue, for
  the person responsible.

**Where it would appear:** Compliance Hub checks, the Contractors page
(documents), the Equipment list (#159), GreenTrack examinations and NSTS tests,
FireTrack services and LegionellaTrack. One shared "Scan certificate" button,
not a different one per track.

**Links to other work.**

- It is feature 2 in the Live AI plan ("read certificates and contractor
  documents"). It uses the cheapest model, so it costs far less than the COSHH
  drafts.
- It shares its set-up with the COSHH drafts (item 5): one Anthropic key on
  Render, one privacy page line naming Anthropic as a supplier, and the same
  "hidden until the key is set" switch already used for Stripe. Building the
  two together saves doing that work twice.
- Taking a photo with the phone app comes with the phone app work (item 4).

**Cost:** about 0.1p for a typical certificate, according to the Live AI plan.
Long reports (a 20-page EICR) cost more, but still only pennies. Even at
100 businesses scanning 50 certificates a year each, that is a few pounds a
year. No extra hosting: files already go to Google Cloud Storage. I'd still set
a monthly spending limit with the AI provider and a fair-use limit per
business.

**You'd need to:** create an Anthropic Console account and key (the Live AI
thread has the steps) and add it on Render.

**Question for you:** should scanning be free for every business (it is cheap
and makes the reminders work better) or only for paying track customers, like
the other AI features?

---

## 3. Reminders to the right person, and a weekly Owner update

**When:** after launch. **Status:** plan written, waiting for your go-ahead.

Every task, action, FixTrack issue and compliance check gets an "Assigned to"
person chosen from the business's users, not typed text. That person gets at
most one "due tomorrow" email a day, only on days something of theirs is due.
The Owner gets one weekly update instead of about 25 emails a week.

Plan: `plans/reminders-to-the-right-person.md` in the project files.

**Cost:** none (fewer emails, if anything).

---

## 4. Phone apps: iPhone first, then Android

**When:** after launch.

- **iPhone first, then Google Play.** Finish the full phone build (groups 1
  and 2 of `mobile/app-gap-list.md` in the project files) before the App Store
  steps.
- **Draft #101** has every missing phone screen built (PestTrack,
  PremisesTrack, RoomTrack, TreeTrack, BikeTrack, kitchen and pool extras,
  GreenTrack extras, plus manager screens). It has not been tried on a phone
  yet.
- **Draft #77** (sign in with a passkey) needs your phone to test.
- Follow-ups already noted: the phone's scanner should open the new QR labels
  (#159), and "Speak a list" for COSHH.
- The smoke test to run is `mobile/iphone-smoke-test.md` in the project files.

**Voice shortcuts without opening the app first** (asked for on 29 and 30
October). Saying something like "Hey Siri, open the ComplyTrack checklist for
fairway mower 2" to Siri or Google
Assistant would open that item's check straight away. The website can't do
this; the phone apps can, using Siri Shortcuts on iPhone and Google Assistant
shortcuts on Android. Each shortcut opens the same check page the item's QR
label opens. Until then, the no-app route is to point the phone camera at the
item's QR label.

**Cost:** Apple Developer £79 a year; Google Play $25 once. No extra hosting.

---

## 5. Live AI: COSHH drafts from safety data sheets

**When:** after launch. **Status:** plan written, waiting for you to pick the
first feature and create the Anthropic key.

Upload a safety data sheet and get a draft COSHH assessment in the COSHHTrack
form (#150) for a competent person to check and approve. Your idea of starting
from a spoken or typed substance list and finding each data sheet is in the
plan as an option (about 40p a substance in total).

Plan: the Live AI page shared in the "Live AI in ComplyTrack" thread.

**Cost:** about 23p per draft; roughly £105 a month at 100 businesses once
settled, plus about £700 one-off while businesses load their existing
chemicals. Caps keep it in check.

---

## 6. Live AI: help chat for users

**When:** after launch, after item 5.

A help chat that answers "how do I…" questions about settings, billing and
sign-in from a written help guide, with a "Talk to a person" button that emails
ALPS. It never changes records, never sees record contents and never gives
binding legal advice. The help guide has to be written first; there isn't one
in the app yet.

**Cost:** about 7p a chat, so about £35 a month at 500 chats. Needs
`ADMIN_EMAIL` (or a support address) set on Render.

---

## 7. Track summary recipient preview (#125)

**When:** after launch.

Settings shows exactly who receives each track's daily summary email before
you rely on it. It was left out of release #160 because it was written before
the new Manager roles (Head of Department, Maintenance) and needs re-doing for
them. Worth doing together with item 3, since both decide who gets which email.

**Cost:** none.

---

## 8. International: English-speaking countries first

**When:** after launch. The decisions (Phase 0) can be made any time.

Full plan: `plans/worldwide-english-speaking-plan.md` in the project files.
Translation into other languages is left out.

- **Phase 0, decide and prepare.** Your answers to the 6 questions below, and
  a VAT and data-protection check for Ireland with your accountant.
- **Phase 1, Ireland and a "general" mode.** A country on every business,
  reminders at 08:00 local time for every business, euro prices and the right
  VAT wording, a "general" mode for any English-speaking country (UK law
  references hidden), and an Irish rule pack (Health and Safety Authority,
  FSAI food rules, accident reporting instead of RIDDOR). About 5 to 7
  changes.
- **Phase 2, Australia, New Zealand, Canada.** Mostly content: each country's
  rules, local prices, "test and tag" instead of PAT for AU/NZ.
- **Phase 3, United States.** The biggest: °F, US date order, Letter-size PDFs,
  OSHA instead of RIDDOR, state-by-state rules.

**Six questions waiting for you:**

1. First country after the UK? (Recommended: Ireland.)
2. Prices in local money or in pounds? (Recommended: local money.)
3. Country rule packs, a general mode, or both? (Recommended: both.)
4. Who checks each country's guidance? Do you have a contact in Ireland?
5. Legal and tax check for Ireland: shall I draft the questions for your
   accountant?
6. US now or later? (Recommended: later.)

**Cost:** no extra hosting; the Frankfurt server serves Ireland well. Card fees
are higher abroad (about 2.5% for EU cards against 1.5% for UK cards). A
second server in Asia for Australian customers would roughly double hosting
for them, so only if enough of them find it slow. A possible EU representative
fee if the Irish check says one is needed.

---

## 9. Error reports (Sentry)

**When:** before launch if you have 10 minutes; otherwise straight after.

Already built (#122). When switched on, ComplyTrack tells us about errors on the
live site, with personal details removed, so we can fix problems before
customers report them. It needs only your set-up steps:
`release/sentry-setup.md` in the project files (free plan, EU region, one
setting on Render).

**Cost:** none on the free plan.

---

## 10. Offline working

**When:** after launch.

A separate "local" edition installed on customer computers is **not
recommended**: it is a second product to install, back up and support, and
syncing it back is hard. Plan and reasons: `plans/offline-local-edition-336.md`
in the project files.

The cheaper route:

1. **Phone app offline sending** (comes with item 4): staff record checks with
   no signal and they send when back in range. Many checks already work this
   way.
2. **Website offline for recording checks** (later): tablets and laptops on
   site keep working without signal. About a third of the size of a local
   edition, with nothing to install.

**Cost:** none for the recommended route. A local edition would add a code
signing certificate (a few hundred pounds a year) and support time.

---

## 11. Actions from uploaded audit and inspection reports

**When:** after launch. **Status:** being planned now in the thread "Actions
from uploaded audit reports"; this is a summary only.

A manager or ALPS uploads an audit, an inspection report (for example from the
Care Inspectorate) or a similar report. ComplyTrack reads the required actions
out of it and turns each one into an action in the Compliance Hub, with a due
date, assigned to the right manager or the maintenance manager. As with
certificates, a person checks the list before anything is created.

It uses the same AI set-up and the same "check and confirm" screen as
certificate scanning (item 2) and the COSHH drafts (item 5), so all three
should be built together. The actions follow your notification rule: they go
to the person they are assigned to, and the Owner sees them in the weekly
update (item 3).

**Cost:** pennies per report; the exact figure is being worked out in that
thread. No extra hosting.

---

## 12. CareTrack

**When:** later, after the items above.

A new module for care homes and care services, to be built later. Item 11 is
the first step towards it: Care Inspectorate reports can already turn into
actions before CareTrack exists, and CareTrack can then build on those
actions.

**Questions for you, when you're ready:** which care services first (care
homes, care at home, nurseries)? Scotland only to start (Care Inspectorate),
or England (CQC), Wales (CIW) and Northern Ireland (RQIA) too? Which records
should it keep day to day?

**Cost:** not yet known; likely none for hosting, like the other tracks.

---

## 13. Kitchens: stock, costings, GP, recipe spec sheets, supplier details and voice

**When:** after launch.

All the parts below share one list of ingredients and recipes, so they belong
together.

### Allergen charts (live, #169)

KitchenTrack allergen charts, with the ingredients list and recipes everything
below builds on, were built in the thread "KitchenTrack allergen charts". You
parked them on 21 October, then had #169 merged on 22 October, so they are now
live. Everything below builds on them.

### Stock control

Kitchens keep track of what they have in: deliveries in, stock counts, waste
and write-offs, and a "running low" list when an item reaches its re-order
level.

**Reuses what already exists.** GreenTrack's stock control went live in #164
(products, deliveries, stock counts, write-offs and re-order levels, with stock
worked out from the history so corrections put it right). Kitchen stock should
use the same approach rather than a second, different system.

**Links to the allergen charts (#169).** Kitchen stock items should be the
same ingredients as the allergen charts' ingredients list, so each one carries its allergens once.
Later, recording that a recipe was made could take its ingredients off stock,
in the same way a spray takes product off stock in GreenTrack.

**Useful extras to consider:** use-by dates on deliveries (oldest first, and a
warning before stock goes out of date), and the supplier on each delivery,
which supports food traceability.

### Meal costings

The cost of each dish, worked out from its recipe: each ingredient's quantity
times its price. Prices come from deliveries (the latest price, or an average),
so when a supplier puts a price up, every dish using that ingredient shows its
new cost straight away. Cost per portion as well as per batch.

### GP (gross profit) calculation

Enter each dish's selling price and ComplyTrack shows the gross profit in
pounds and as a percentage, with VAT taken off the selling price first. Set a
target GP (for example 70%), and dishes that fall below it are flagged, along
with the selling price needed to hit the target. A menu view lists every dish
with its cost, price and GP.

### Recipe spec sheet upload

Upload a recipe spec sheet (PDF, photo or document) and ComplyTrack reads it
into a recipe: dish name, ingredients and quantities, portions, method and
allergens. Ingredients are matched to the kitchen's ingredients list, or added
if new. As with certificates, a person checks everything before it is saved,
and above all the allergens, which must never be taken on trust from an
automatic read. This uses the same AI set-up as items 2, 5 and 11.

### Allergens and prices from suppliers

Fill in an ingredient's allergens and price from the supplier (for example
Brakes, Bidfood or Booker) instead of typing them. A person checks the details
before they are saved, and allergens are never taken on trust. (Asked for
again on 30 October and 2 November as "link to suppliers", next to the
allergen records.)

**Already built (change #271, 30 October):** a kitchen can import a
supplier's allergen information from a spreadsheet, or from a photo or PDF of
a spec sheet read by AI, and a person confirms it before it is saved.

**Still to do after launch, the "link to suppliers":** connect a kitchen's
account with a supplier so allergens and prices come in and stay up to date
without uploading a file each time. When a supplier changes a product's
allergens, ComplyTrack would flag every dish that uses it for a manager to
check, rather than changing the allergen chart on its own.

How we get the details matters. Some supplier websites forbid automatic
copying ("scraping") in their terms, and their pages change without warning,
which breaks it. So the order of preference is:

1. **The supplier's own product or price file**, or a download from the
   kitchen's account with that supplier (many wholesalers offer spreadsheets of
   products, prices and allergen data to account customers).
2. **The kitchen's invoices or delivery notes**, read in the same way as
   certificates (item 2), which also keeps prices up to date for costings.
3. **Reading a supplier's public product page** only where its terms allow it,
   and always with a person confirming the result.

### Compare suppliers for the kitchen order

Put together the kitchen's order list and ComplyTrack shows which supplier is
cheapest for the whole order, or for each item, using the prices from the
supplier price import above. This is the KitchenTrack version of the consumer
shopping comparison app (see "Future apps").

### Recipe ideas for leftover stock

Your idea on 3 November: "suggest recipes for leftover kitchen stock". Using
the kitchen's stock list, ComplyTrack picks out what needs using up (close to
its use-by date, opened, or over-ordered) and suggests dishes or specials that
use it. This would be part of the AI add-on, paid for from the business's AI
allowance like the other AI features.

Each suggestion would show:

- which leftover items it uses and roughly how much;
- the allergens it contains, worked out from the kitchen's own ingredient
  allergen records, never guessed by the AI;
- the cost per portion and GP at the kitchen's usual price, from the costings
  above.

The chef chooses whether to use a suggestion. If they do, it can be saved as a
recipe with its spec sheet, so the allergen chart and costings stay right. A
chef must always check a suggested recipe, especially its allergens, before it
is served. It would also favour the kitchen's existing recipes first ("you
could run the chicken curry special") before suggesting new dishes.

This needs the kitchen stock list first (dates and amounts), so it comes after
kitchen stock control.

### Gaps found when testing a game terrine (4 November)

Writing up a real dish (a game terrine) showed three things kitchen records
can't do yet. They also feed the HACCP plan builder (item 30):

- **Recipes inside recipes ("sub-recipes"):** a prep made in the kitchen and
  then used in a dish, such as a stock, a forcemeat or a jelly. Its allergens
  should carry through to every dish that uses it, so the allergen chart stays
  right without typing them twice.
- **More than one time and temperature for a dish:** for example a cook
  stage, then a chill, then a reheat, each with its own target, rather than
  one setting per dish.
- **A cure, batch and freeze/thaw log:** weighing what goes into a cure or a
  batch, and recording when food goes into the freezer and when it comes out
  to thaw, with the date it must be used by.

### Voice

Speak things in rather than typing: a list of ingredients, a recipe, or a
stock count ("12 tins of chopped tomatoes, 3 bags of flour"). This reuses the
free dictation microphone that is already on every notes box and the COSHH
"Speak a list" button (#151), so it costs nothing extra.

**Cost:** none for stock, costings, GP and voice. Reading spec sheets, and
each set of recipe ideas for leftover stock, would cost a few pence with the
live AI, taken from the business's AI allowance (the exact figure to be worked out with the
Live AI plan). No extra hosting.

**Questions for you:**

1. Should a kitchen count stock by whole items (cases, bottles) or by weight
   and volume?
2. Is taking stock off automatically when a recipe is made wanted, or are
   regular stock counts enough?
3. Should costings use the latest delivery price or an average price?
4. What GP target do your clients usually work to?
5. Which suppliers do your kitchen clients mostly use? That decides which
   product files to look at first.

---

## 14. Label scanning

**When:** after launch. Plan page:
https://claude.ai/artifact/Y3EchSXLiwpxAg1QQHRg3G

Staff photograph a label with their phone (in the phone's web browser, so it
doesn't wait for the store apps) and ComplyTrack reads it. A person always
checks the result before it is saved.

**Chemicals first.** Photograph a chemical's label and ComplyTrack:

1. reads the product name and maker (about 1-2p);
2. finds the safety data sheet (about 15p), and a person confirms it is the
   right one; anything not found goes on a "not found" list, with an email to
   the supplier asking for the sheet;
3. adds the product to the COSHH Register and drafts the COSHHTrack assessment
   (about 23p, the same as item 5).

A manager must tick "checked against the safety data sheet" before the
assessment is saved. Once it is current it appears in TrainTrack's COSHH tab
for staff to read and sign. Hot tub, pool and pest control chemicals are
covered by the same scan.

**Then the other tracks, in this order:**

- **GreenTrack product labels:** pesticides and fertiliser for the spraying
  book (#164), picking up the MAPP number and active ingredient as well as the
  COSHH details.
- **Certificates:** this is item 2, using the same photo screen.
- **Food labels (KitchenTrack):** ingredients, allergens and "may contain"
  warnings (about 1-2p), checked by a manager, landing in the ingredients list
  from the allergen charts (#169, now live). It pairs with
  supplier allergens and prices in item 13.
- **Equipment data plates:** make, model and serial number for PUWER, LOLER
  and PAT records, linked to the equipment's QR label (#159). Also FireTrack
  extinguisher service labels.

**Links to other items.** It uses the same AI set-up and "check and confirm"
screen as items 2, 5, 11 and the kitchen spec sheets in item 13, so they should
be built as one family.

**Cost:** no extra hosting. The AI costs above are mostly already counted in
the Live AI plan. Needs the Anthropic key on Render.

---

## 15. FireTrack: sound level meter for fire alarm tests

**When:** after launch, as part of the ComplyTrack phone app (iPhone first).
Nothing has been built yet.

**The idea.** During each weekly call point test, the phone measures how loud
the alarm is and saves the reading (in dB) on that test. It shows a red flag
if the alarm is too quiet:

- below 65 dB in general areas;
- below 75 dB at the bedhead in rooms where people sleep.

The limit is set on each call point's location. These are the BS 5839-1
figures as quoted second-hand, so please check them against your copy of the
current standard. The call point locations and test order this hangs off went
live in #165, and draft #174 adds the walk round.

**Why it has to be our own app.** Decibel X and the other phone apps have no
link we can use, only a CSV file or a picture to share. Professional meters
with a network link (B&K 2245, Larson Davis 831C and LxT, NoiseMeters
NoiseAPI) are expensive, and a website can't reach them. Cirrus, Casella/TSI
and Pulsar meters only talk over Bluetooth to their own apps, and a web page
can't use Bluetooth on an iPhone. A browser can hear the microphone, but its
readings can be 5 to 10 dB out, so it belongs in the phone app.

**Limits to be honest about.**

- Phone microphones aren't calibrated, so each phone needs a one-off
  adjustment set against a proper meter.
- Even then the readings are a good indication, not evidence-grade
  measurements.
- A phone can max out when it's right next to a sounder.

**Steps along the way.**

1. **Quick win (could come sooner):** a typed "Sound level (dB)" box on each
   call point test, with the same red flag, for anyone reading a meter.
2. **Meter upload:** upload the CSV from a Cirrus or Casella meter for clients
   who own one.
3. **The phone app meter** described above.

**Cost:** no extra hosting.

---

## 16. Temperature probes and sensors

**When:** after launch. Bluetooth probes come with the phone app (item 4);
Wi-Fi sensors can come at any time after launch. Nothing has been built yet.

### Bluetooth probes

Staff use a Bluetooth food probe (for example cooking, cooling, reheating or
delivery checks) and the reading goes straight into the KitchenTrack record
instead of being typed. The same works for LegionellaTrack outlet temperatures
with a Bluetooth water thermometer. This removes typing mistakes and shows the
record came from a probe.

This needs the ComplyTrack phone app: a web page can't use Bluetooth on an
iPhone (the same limit as the sound level meter, item 15). Each probe make
talks in its own way, so we'd support one or two common makes first and
check that their makers allow it.

### Remote monitoring by Wi-Fi sensors

A small sensor in each fridge, freezer or cold water tank sends its
temperature every few minutes over the building's Wi-Fi. ComplyTrack:

- fills in the twice-daily fridge and freezer readings automatically, so staff
  don't have to;
- shows a live temperature and a chart for each unit;
- raises an alert when a unit stays out of range (for example a fridge above
  8°C for more than 30 minutes, so opening the door doesn't set it off), and
  records what was done about it;
- for water tanks, records cold water below 20°C and hot water at the right
  temperature for the legionella records.

Each sensor is linked to the fridge, freezer or tank it sits in, using the
fixed identities from the QR labels work (#159), so readings land on the right
record.

**Two ways to build it:**

1. **Link to an existing sensor maker's service** that already sells Wi-Fi
   sensors with its own app and a way for other software to read the data.
   Quicker and more reliable, but each business pays that maker a monthly
   subscription on top of the sensors.
2. **Our own "send a reading" link** that standard, cheaper sensors send to
   directly. No subscription for the business, but we'd have to test the
   sensors ourselves and support the set-up.

My suggestion is to start with option 1 for one maker, then add option 2 if
clients want cheaper hardware.

**Notifications.** Alerts follow your rule: they go to the person responsible
for that kitchen or tank (with a text or phone alert for out-of-hours
failures if wanted), not to everyone, and the Owner sees a summary in the
weekly update (item 3).

**Cost:**

- **Hardware:** paid by each business. Bluetooth probes and Wi-Fi sensors
  vary a lot in price, from tens of pounds to over a hundred each, and
  option 1 adds the maker's monthly fee. These prices are rough and need
  checking when a make is chosen.
- **Hosting:** readings every few minutes add up (100 businesses with 10
  sensors each is about 100,000 readings a day). To keep the database small
  we'd keep every reading for a short time and then keep only hourly
  highs and lows plus any alerts. Even so, a larger database plan on Render
  may be needed once many businesses use sensors; I'll say so before it
  happens.
- Text message alerts, if wanted, cost a few pence each.

**Questions for you:** do any of your clients already have sensors or
Bluetooth probes, and which make? Should sensors replace the staff fridge
checks completely, or sit alongside them?

---

## 17. Maintenance inventory

**When:** after launch.

A stock list for the maintenance team's parts and consumables: light bulbs and
emergency light batteries, filters, fuses, fixings, paint, cleaning and
water-treatment chemicals, PPE and so on.

- **Stock control:** deliveries in, items used, stock counts and re-order
  levels, using the same stock control as GreenTrack (#164) and the planned
  kitchen stock (item 13), not a third system. Parts used on a FixTrack job or
  a GreenTrack repair (item 1) can come off stock automatically.
- **Cheapest supplier:** each item can have more than one supplier and price,
  and the list shows the cheapest for each item or for the whole re-order. It
  shares the supplier price import and comparison planned for kitchens
  (item 13).
- **Low-stock reminder:** when an item reaches its re-order level, the
  maintenance manager (the person responsible) is told, not everyone. It goes
  in their one daily "due" email and the Owner's weekly update (item 3),
  rather than as a separate email for each item.

**Cost:** none. No extra hosting.

**Question for you:** should the inventory be per site, or one store shared
across all of a business's sites?

---

## 18. Reorder the side menu

**When:** after launch. Asked for on 27 October.

Each user can arrange the left-hand menu in the order they prefer, by
dragging items (and whole groups) up or down. The order is saved for that
person only, so everyone else keeps their own layout, and a "Reset to
default" button puts it back.

**Builds on what exists.** Users can already pin favourite modules to the top
of the menu. Those pins are kept in the browser, so they don't follow a person
to another computer or phone. The new order (and the pins with it) would be
saved with the user's account, so the same menu appears wherever they sign in.

Items a user isn't allowed to see stay hidden whatever order they choose, and
new modules appear in their default place until the user moves them.

**Cost:** none. No extra hosting.

---

## 19. Bars: opening and closing checks (beer tap tips) and bar stock

**When:** after launch. Asked for on 27 October.

Ready-made bar checks in the DailyTrack opening (AM) and closing (PM)
checklists, for any business with a bar department:

- **Closing:** beer tap tips (nozzles) removed, washed and left soaking
  overnight; drip trays emptied and cleaned; glass washer drained and cleaned.
- **Opening:** tips refitted, clean and undamaged; the first pull of each tap
  run off before serving.

Further bar items could join later, such as a beer line cleaning record (with
a reminder when the next clean is due) and a cellar temperature check.

**In the meantime:** a manager can already add these items to their own
opening and closing checklists with the checklist editor. This item makes them
part of a ready-made bar list so every new bar gets them without typing.

### Bar stock

Your idea on 3 November: "bar stock". The bar keeps track of what it has in,
using the same stock control as kitchens (item 13) and GreenTrack (#164),
not a separate system:

- **Deliveries in:** kegs, cases and bottles, typed in, spoken (voice) or read
  from the delivery note.
- **Stock counts:** a regular count (weekly or monthly) on a phone or tablet,
  with part bottles recorded in tenths and kegs as full, part or empty.
- **Waste:** line cleaning losses, spillage, out-of-date and breakages, so
  they don't look like missing stock.
- **Running low list:** a reminder to the bar manager when an item reaches its
  re-order level, in their usual daily email rather than a separate alert.
- **Cost and GP per drink:** the cost of a pint, a single measure or a glass of
  wine from the latest delivery price, and the GP at the bar's selling price.

Later it could compare what was used against what the till says was sold, to
show unexplained losses (sometimes called "variance" or "yield"). That needs
sales figures from the till, so it would start with a simple sales upload
before any link to a till system.

**Cost:** none. No extra hosting.

**Questions for you:**

1. What else should be on the bar checklist? If you have a bar checklist you
   already use with clients, send it over and it can be the starting point.
2. For bar stock, is a count with deliveries, waste and GP per drink enough to
   start, or do clients want the till comparison from day one?
3. Which till systems do your bar clients use?

---

## 20. Site safety information sent to contractors before their visit

**When:** after launch. Asked for on 27 October.

When a contractor's visit is booked (the contractor reminder from #155 already
lets them pick a date and sends a calendar invite), ComplyTrack also sends
them the site information they need before they arrive:

- the site's risk assessment (or the parts that apply to their work);
- the fire evacuation procedure and assembly point;
- the asbestos register for that site, so they know where not to drill or cut
  before they start.

**How it works:**

- The details go as a secure link in the booking email and calendar invite,
  not as attachments, so they always show the latest version and only work
  for that visit.
- The contractor ticks "I have read these" before the visit. The visit record
  shows who read what and when, which is useful evidence if anything goes
  wrong.
- The manager chooses which documents go to which kind of contractor (for
  example the asbestos register always goes to builders and electricians).

**Links to other work.** This joins up with contractor sign-in and test
logging (item 23): the contractor reads the site information, signs in on
arrival, logs their test, and signs out.

**Cost:** none. No extra hosting.

---

## 21. White-labelling for resellers

**When:** after launch. Asked for on 27 October.

Partners such as insurance brokers resell ComplyTrack to their own clients
under the partner's name and look.

**What already exists.** Consultants can already set a practice name and logo
that the businesses they manage see, and have a portfolio page covering all
their linked businesses. White-labelling builds on that.

**What it would add:**

- **A partner account** (a new "Partner" role, separate from the ALPS-only
  Consultant role) that sees only the businesses linked to it.
- **The partner's branding everywhere a client looks:** logo, colours and name
  in the app, on emails, and on PDFs and inspection packs, with an optional
  small "Powered by ComplyTrack" line.
- **Their own web address** (for example compliance.brokername.co.uk) and,
  optionally, emails sent from the partner's own address.
- **Sign-up through the partner:** a partner link or code, so new businesses
  are linked to that partner and get its branding and price from day one.

**Choices to make:**

1. **Billing.** Either the partner pays ALPS one bill for all its clients and
   charges them itself, or each client pays by card as now and the partner
   earns a commission or discount. The no-proration rule and per-site charges
   stay as they are either way.
2. **What the partner sees.** Just a list of its clients and whether they are
   active, or also each client's compliance status. An insurance broker may
   want the status (it can help with premiums), but a client must agree to
   share it, and the privacy terms need to say so.
3. **Fully branded or co-branded.** Partner name only, or partner and ALPS
   side by side.

**Legal.** A reseller agreement and updated data-protection terms are needed
before the first partner signs up. Worth taking to the solicitor review that
is already planned.

**Cost:** little or none for hosting. Each partner's own web address and
email sending address may add a small cost (the email service and the host
limit how many addresses are included), to be checked before the first
partner. I'll flag it before it's added.

---

## 22. Choose the AI model and effort per feature

**When:** after launch. Asked for on 27 October.

For now each AI feature (certificate scanning, COSHH drafts, label scanning,
audit report actions, the help chat and so on) uses a fixed AI model and
effort level, chosen for the best balance of quality and cost. Those fixed
choices are being set in the thread "Set AI model and effort per feature".

Later, an Owner could change them per feature in Settings, for example:

- **Better quality:** a stronger model or more effort for COSHH drafts, where
  accuracy matters most.
- **Lower cost or faster:** a lighter model for simple reads such as
  certificates and labels.

**Guard rails.** Plain wording ("Standard", "Thorough", "Fast") rather than
model names; the cost difference shown next to each choice; ALPS's monthly
spending limit and each business's fair-use limit still apply; and a "Reset to
recommended" button. Whatever the choice, a person still checks and confirms
every AI result before it is saved.

**Cost:** depends on what businesses choose. Stronger models and more effort
cost more per use, so this may be best offered as a paid option or limited to
the higher plans. The spending caps keep it in check.

**Question for you:** should a business pay extra to choose the stronger
setting, or should it be included?

---

## 23. Contractor sign-in and logging their own test results

**When:** after launch. You chose this in the thread "Temporary contractor
access to log tests", which will build it when you say go.

1. **Sign in on arrival.** The contractor signs in on their phone, confirms
   they have read the site's fire evacuation procedure and asbestos register
   (sent before the visit, item 20), and ticks a sign-off box. They sign out
   when they leave, so they appear on the fire roll call while on site.
2. **Log their own results.** A time-limited link lets the contractor record
   PATrack pass and fail results directly, sign them off, and upload their own
   certificate. They see only that one job, nothing else in the business, and
   the link stops working when the visit ends.
3. **Later:** the same for hot tubs, bikes and then every track.

**Cost:** no extra hosting.

---

## 24. Choose how often urgent alerts are sent

**When:** after launch. You decided on 29 October (in the thread "Let Owners
choose email frequency") to keep urgent alerts going out the same day for now,
and to keep this as a future option.

Owners can already choose how often the routine emails come (#212). This would
add the same kind of choice for urgent alerts, sitting next to it in
Settings, for example:

- **Straight away** (today's behaviour, and the default);
- **Gathered up** into one urgent email at set times of day;
- **Included in the daily email** only.

**Guard rail.** Some alerts should never wait, such as a serious incident or a
fridge or freezer that has failed. Those would always go straight away
whatever the setting, and the setting page would say so plainly.

**Cost:** none. No extra hosting.

---

## 25. Link TrainTrack to outside training providers

**When:** after launch. Asked for on 29 October.

When a staff member finishes a course with an outside training provider (an
online course, a food hygiene or first aid course, a manual handling session),
the completion and certificate land in their TrainTrack record automatically,
with the expiry date and a reminder before it runs out. No more typing the
course in or uploading the certificate by hand.

**Three ways in, best first:**

1. **A direct link** to providers that let other software read completed
   courses. Fully automatic, but each provider has to be connected one by one,
   and some charge for this.
2. **Forwarding the certificate email.** Each business gets its own
   TrainTrack email address; forward the "you passed" email or certificate to
   it and it is matched to the person and course. This works with any provider.
3. **Reading the certificate** using certificate scanning (item 2): upload or
   photograph it and the course, person, date and expiry are filled in for a
   manager to confirm.

Whichever way, a manager confirms a new record before it counts, and it then
shows on the training matrix and in reminders as usual.

**Cost:** none for hosting. Reading certificates costs pennies each (item 2).
Some providers may charge for a direct link.

**Question for you:** which training providers do your clients mostly use?
That decides which direct links are worth building first.

---

## 26. Combine SafeTrack into DocTrack

**When:** after launch. From your 30 October list ("Safe track leads to
doctrack, combine?").

On the website, SafeTrack already opens the DocTrack pages: documents, who
must read them and who has signed. Combining them properly would mean one
module name, one menu item and one price, so customers aren't confused about
what they are buying.

**Your call:** SafeTrack and DocTrack may be sold separately today, so
combining them changes what customers pay for. Options are to fold SafeTrack
into DocTrack at no extra charge, or keep two names on one shared page.

**Cost:** none for hosting.

---

## 27. One Owner login for several separate businesses

**When:** after launch. From your 30 October list ("Owner can be designated
owner of multiple sites using same email login").

Today one email address belongs to one business. An Owner who runs two or
more separate businesses (not just several sites of one business) would sign
in once and switch between them, the way a consultant can. Each business keeps
its own billing, records and staff, and nothing is shared between them.

Several sites of one business already work under one login; this is only for
separate businesses with separate bills.

**Cost:** none. No extra hosting.

---

## 28. Staff roster "Open kiosk"

**When:** after launch. From your 30 October list ("What is 'open kiosk' on
staff roster?").

The staff roster has an "Open kiosk" button that lets staff record the start
of their shift on a shared screen, but nothing in the app shows those
records yet. On 2 November you decided to keep the button (not hide it).

The work after launch is to show the shift start times the kiosk records, so
managers can see who started when. Later it could also become a full tablet
sign-in sheet (sign in and out, who is on site, feeding the fire roll call
alongside contractor sign-in, item 23).

**Cost:** none. No extra hosting.

---

## 29. Management walk-round inspections for each track

**When:** after launch. Your idea on 2 November: "management overview
checklists for each track, maybe weekly or monthly, high level review of all
tracks", and you confirmed "that's physical reviews".

Staff already do the day-to-day checks. This adds a manager's own physical
inspection: they walk round and look at each track's area in person, weekly or
monthly, to check that standards are being kept and the records match what is
really there. Auditors and inspectors like to see this, because it shows
someone in charge is checking the checks.

**1. A walk-round checklist for each track.** A short list of things to look
at in person, ready-made for each track and editable by the business. For
example:

- **KitchenTrack:** cleanliness, food covered, labelled and in date, fridge
  and freezer readings on the display match the records, probe and wipes
  available, allergen information up to date at the pass.
- **FireTrack:** escape routes and fire exits clear, fire doors closing
  properly, extinguishers in place and in date, fire action notices up.
- **GreenTrack:** machinery shed tidy and safe, chemical store locked and
  labelled, spill kit and protective equipment ready.
- **LegionellaTrack, COSHHTrack, PATrack and the rest:** the same idea, with
  a few things to look at that suit that track.

The manager can open it from the dashboard or by scanning the track's QR
label, answers each line Pass, Fail or N/A, takes photos, and signs. Any fail
needs a corrective action, the same as every other check (change #270), and
it goes to the person responsible with a due date. To help them, the
checklist can show a few facts beside it, such as checks missed since the last
walk round.

**2. One overall review of all tracks.** Once a month (or each quarter), a
wider site walk round covering every track at a high level, done by the Owner
or the ALPS consultant on their visit. It shows the result of each track's
latest walk round, they record what they find, and they sign it. It can be
printed or saved as a PDF for the board, the insurer or an inspector.

This builds on things already in the app: the FireTrack walk round, the QR
labels on each track, photos on records, corrective actions on every fail, and
the drawn signatures planned in draft #251. A missed walk round would be
treated like any other missed check, so it shows on the dashboard and goes
into the responsible person's reminders, not to everyone.

**Questions for you:**

1. Weekly or monthly for each track's walk round, or let each business choose?
2. Who does a track's walk round: the manager for that department, or always
   an Owner?
3. Should the overall review be done by the Owner, the ALPS consultant on
   their visit, or both?
4. Do you have walk-round checklists you already use with clients that we
   should start from?

**Cost:** none. No extra hosting.

---

## 30. KitchenTrack HACCP plan builder

**When:** after launch. You chose "Add it to the roadmap" on 4 November.
The design is here: https://claude.ai/artifact/TMny7MkviszZaSt67nN7ZC

A kitchen builds its HACCP plan inside ComplyTrack, laid out like your ALPS
HACCP template, instead of keeping it as a separate document. Today a HACCP
plan can already be uploaded and read and signed by staff through DocTrack
(change #226). This item builds the plan itself.

**Stage 1: build the plan by hand.**

- **Process steps:** the steps food goes through (for example delivery,
  storage, preparation, cooking, cooling, reheating, serving), each with four
  hazard rows: biological, chemical, physical and allergen.
- **Scoring:** each hazard scored likelihood x severity. A score above 3
  counts as significant, and only significant hazards go on to the CCP
  questions.
- **The CCP questions:** your questions 1, 2, 2a, 3, 4 and 5, which decide
  whether a step is a critical control point (CCP).
- **CCP summary:** filled in from KitchenTrack's own records and temperature
  rules (for example cooking to 75°C, cooling, fridge and hot holding limits),
  so the plan and the daily checks say the same thing. Each CCP shows its
  limit, how it is checked, what to do if it fails, and which KitchenTrack
  record proves it.
- **Sign-off with versions:** each change makes a new version that is signed
  off. Older versions are kept for inspectors.
- **Read and sign:** staff read and sign the current version through DocTrack,
  as they do now for uploaded plans.
- **Print:** a landscape print and PDF in the template's layout.

**Stage 2: AI draft from a recipe.** For businesses with the AI add-on,
ComplyTrack drafts the steps, hazards and scores from a recipe for the
manager to check, change and sign. Nothing is used until a person has checked
it, and allergens come from the kitchen's own ingredient records. Each draft
is taken from the business's AI allowance.

This works best once kitchens have sub-recipes and more than one time and
temperature per dish (see "Gaps found when testing a game terrine" in item
13).

**Question for you:** please send the exact wording you want for your CCP
questions 1, 2, 2a, 3, 4 and 5, so the plan asks them the way your template
does.

**Cost:** none for stage 1. Stage 2 costs a few pence per AI draft, from the
business's AI allowance. No extra hosting.

---

## 31. Complete risk assessments inside ComplyTrack

**When:** after launch. Your idea on 4 November: "allow users to complete risk
assessments via complytrack", using RiskAssessor Pro as the template.

Today risk assessments live in SafeTrack and DocTrack as uploaded documents.
ComplyTrack keeps the title, status, who assessed it and the review date, and
staff can read and sign them, but the assessment itself is written somewhere
else. This item lets a business write the risk assessment inside ComplyTrack.

**How it would work:**

- **Start from a template:** a list of ready-made assessments (for example
  manual handling, working at height, slips and trips, lone working, display
  screen equipment, a new or expectant mother, young workers), laid out the
  way you want from RiskAssessor Pro. A business can also start a blank one.
- **Hazards and who could be harmed:** each hazard lists who is at risk
  (staff, contractors, visitors, the public) and how.
- **Scoring:** likelihood x severity before and after controls, shown red,
  amber or green, using the same scoring style as the HACCP plan builder
  (item 30) so the two feel the same.
- **Controls and actions:** controls already in place, plus further actions,
  each with a person responsible and a due date. Those actions go into the
  normal actions list and that person's reminders.
- **Links to the tracks:** an assessment can point at the checks that prove
  its controls are working, for example the fire risk assessment pointing to
  FireTrack's weekly alarm tests.
- **Sign-off and review:** signed off with a version number, older versions
  kept, a review date that reminds the right person, and an early review
  prompted after an incident or a change on site.
- **Staff read and sign:** as now, through DocTrack, plus a print and PDF.

Later, for businesses with the AI add-on, ComplyTrack could draft an
assessment from a short description of the task for the manager to check,
change and sign. A competent person must always check it before it is used.

**A note on RiskAssessor Pro:** we can follow its layout and the way it works
as a guide, but we shouldn't copy its wording or hazard library word for word
unless it is your own material or you have permission to use it. If the
template is your own ALPS document, please send it over and it can be the
starting point.

**Questions for you:**

1. Is RiskAssessor Pro a product you use, or your own template? Could you send
   a blank copy or a screenshot of the layout?
2. Which risk assessments should come ready-made first?
3. Should ALPS consultants be able to write or approve assessments for their
   clients?

**Cost:** none. No extra hosting. An AI draft, if added later, would cost a
few pence each from the business's AI allowance.

---

## Future apps (separate from ComplyTrack)

Ideas for separate apps, outside ComplyTrack itself. Logged only; nothing
researched or built.

### Shopping comparison app (consumer)

A consumer app: enter a shopping list and it says which shop is the best
(cheapest overall) to go to for it. The same idea is also planned inside
KitchenTrack for comparing suppliers (item 13), and both can share the
supplier price import, since both need up-to-date product prices.

---

## Before launch (already in hand, listed for completeness)

These are handled in the "Launch plan for 26 October" thread and are not new
work:

- Your launch musts: `ADMIN_EMAIL` on Render, Stripe "Include tax in prices"
  set to No, the £12 billing test, the two Terms questions (extra site charged
  straight away; company number and registered office), and the 15-minute live
  test.
- Waiting for "merge": #161 (public SEO pages), then #162 (sign-up alert email
  and the Terms and Privacy fixes).

## Running cost summary

| Item | Extra running cost |
|---|---|
| Greens vehicle maintenance | None |
| Scanning certificates | About 0.1p each; a few pounds a year at 100 businesses |
| Reminders to the right person | None |
| Phone apps | Apple £79 a year, Google $25 once |
| COSHH drafts | About £105 a month at 100 businesses, plus about £700 one-off |
| Help chat | About £35 a month at 500 chats |
| Track summary preview | None |
| International | None for hosting; higher card fees abroad; optional regional server later |
| Error reports | None (free plan) |
| Offline working (recommended route) | None |
| Actions from audit reports | Pennies per report (being worked out) |
| CareTrack | Not yet known; likely none for hosting |
| Kitchen stock, costings and GP | None |
| Recipe spec sheet reading | A few pence per sheet |
| Supplier allergens and prices | Pennies per invoice or product read; nothing for a supplier file |
| Recipe ideas for leftover kitchen stock | A few pence per set of ideas, from the AI allowance |
| HACCP plan builder, stage 2 AI draft | A few pence per draft, from the AI allowance |
| Risk assessment AI draft (if added later) | A few pence per draft, from the AI allowance |
| Kitchen voice input | None |
| Maintenance inventory | None |
| Reorder the side menu | None |
| Bar opening and closing checks | None |
| Site safety information to contractors | None |
| Contractor sign-in and test logging | None |
| Choose how often urgent alerts are sent | None |
| Combine SafeTrack into DocTrack | None for hosting; changes pricing |
| One Owner login for several businesses | None |
| Staff roster kiosk | None |
| TrainTrack links to training providers | None for hosting; pennies per certificate read; some providers may charge |
| Choose AI model and effort | Depends on choices; stronger settings cost more per use, capped by spending limits |
| White-labelling for resellers | Little or none for hosting; possibly a small cost per partner web address and email address |
| FireTrack sound level meter | None |
| Temperature probes and sensors | Hardware paid by each business (plus a maker subscription for option 1); possibly a larger database plan later; text alerts a few pence each |
| Label scanning | About 1-2p per label; about 40p for a chemical including its data sheet and COSHH draft (mostly in the Live AI plan already) |

Hosting stays on the one Render web service and database in Frankfurt for
everything above.
