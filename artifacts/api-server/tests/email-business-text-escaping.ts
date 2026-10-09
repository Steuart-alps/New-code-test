/**
 * Template-level escaping tests for contractor and compliance emails.
 *
 * The content filter accepts business punctuation (ampersands, apostrophes,
 * double quotes, Unicode names, "<" / ">" comparisons). These tests render the
 * real templates with that text and check that every value:
 *   - stays readable once the HTML is decoded,
 *   - cannot add HTML elements or attributes (same tag/attribute structure as a
 *     render with plain placeholder text), and
 *   - appears verbatim, unescaped, in plain-text bodies and subjects.
 *
 * Pure renderers only: FixTrack templates run with previewOnly, nothing is
 * dispatched, no provider key is set and no database connection is opened.
 */
import assert from "node:assert/strict";

// The renderer modules import @workspace/db, which needs a URL at import time.
// pg's Pool connects lazily, and nothing below runs a query.
process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/escaping-test-no-connection";
// The bundled logger cannot spawn its pino-pretty worker; use plain JSON logs.
process.env.NODE_ENV = "production";
for (const key of ["RESEND_API_KEY", "FIXTRACK_TEST_EMAIL_OUTBOX"]) delete process.env[key];

type EmailModule = typeof import("../src/lib/email");
type FixTrackModule = typeof import("../src/lib/fixTrackNotifications");
type ComplianceModule = typeof import("../src/lib/contractorComplianceReminders");
let email: EmailModule;
let fixTrack: FixTrackModule;
let compliance: ComplianceModule;

// ── Business text the content filter allows ─────────────────────────────────
const BIZ = {
  contractorName: `Siobhán O'Brien & Sons "Heating" Ltd`,
  companyName: `Smith & Jones — Zoë's Café`,
  title: `Boiler room: pressure < 3 bar & flow > 2 L/s`,
  notes: `Check return ≥ 50°C && supply ≤ 60°C; label "Valve A" isn't stiff (x < y > z)`,
  location: `Plant room 2 — "North" wing`,
  site: `Ørsted House & Annex`,
  certificate: `Gas Safe "Domestic" & 'Commercial' < 2025 >`,
};

// Placeholder text with the same branches (present/absent) as BIZ.
const PLAIN = {
  contractorName: "Alpha",
  companyName: "Bravo",
  title: "Charlie",
  notes: "Delta",
  location: "Echo",
  site: "Foxtrot",
  certificate: "Golf",
};

// ── Minimal HTML structure helpers ──────────────────────────────────────────
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>/g;

/** Tag sequence with each tag's attribute names, e.g. `a[href,style]`. */
function structure(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(TAG)) {
    const [, close, name, rest] = m;
    const attrs: string[] = [];
    const leftover = rest
      .replace(/\s([a-zA-Z-]+)\s*=\s*"[^"]*"/g, (_all, attr: string) => { attrs.push(attr.toLowerCase()); return ""; })
      .replace(/\/\s*$/, "")
      .trim();
    // Anything not consumed as a quoted attribute would be an injected
    // unquoted attribute or a broken-out value.
    assert.equal(leftover, "", `unexpected tag content in <${close}${name}${rest}>`);
    out.push(`${close}${name.toLowerCase()}[${attrs.join(",")}]`);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Visible text: tags removed, entities decoded, whitespace collapsed. */
function visibleText(html: string): string {
  return decodeEntities(html.replace(TAG, " ")).replace(/\s+/g, " ");
}

/** Attribute values, decoded. */
function attributeValues(html: string): string[] {
  const values: string[] = [];
  for (const m of html.matchAll(TAG)) {
    for (const a of m[3].matchAll(/\s[a-zA-Z-]+\s*=\s*"([^"]*)"/g)) values.push(decodeEntities(a[1]));
  }
  return values;
}

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Shared assertions for one rendered HTML body. */
function assertSafeAndReadable(label: string, bizHtml: string, plainHtml: string, values: string[]) {
  check(`${label}: business text adds no elements or attributes`, () => {
    assert.deepEqual(structure(bizHtml), structure(plainHtml));
  });
  check(`${label}: no raw markup characters leak from values`, () => {
    for (const v of values) {
      if (/[&<>"']/.test(v)) assert.ok(!bizHtml.includes(v), `raw value present in HTML: ${v}`);
      assert.ok(bizHtml.includes(email.escapeHtml(v)), `escaped value missing: ${email.escapeHtml(v)}`);
    }
  });
  check(`${label}: values read back exactly once decoded`, () => {
    const text = visibleText(bizHtml);
    for (const v of values) assert.ok(text.includes(v), `decoded text missing: ${v}`);
  });
  check(`${label}: business text never lands in an attribute value`, () => {
    for (const attr of attributeValues(bizHtml)) {
      for (const v of values) assert.ok(!attr.includes(v), `value found inside attribute: ${v}`);
    }
  });
  check(`${label}: Unicode kept as literal characters`, () => {
    for (const ch of ["á", "Ø", "ë", "é", "≥", "≤", "°", "—"]) {
      if (values.some((v) => v.includes(ch))) assert.ok(bizHtml.includes(ch), `missing ${ch}`);
    }
  });
}

function assertPlainText(label: string, text: string, values: string[]) {
  check(`${label}: plain text keeps values verbatim`, () => {
    for (const v of values) assert.ok(text.includes(v), `plain text missing: ${v}`);
    assert.ok(!/&(amp|lt|gt|quot|#x27|#39);/.test(text), "plain text contains HTML entities");
  });
}

async function main() {
// Imported after DATABASE_URL is defaulted above.
email = await import("../src/lib/email");
fixTrack = await import("../src/lib/fixTrackNotifications");
compliance = await import("../src/lib/contractorComplianceReminders");

// ── FixTrack contractor assignment ──────────────────────────────────────────
console.log("FixTrack contractor assignment");
{
  const render = (v: typeof BIZ) => fixTrack.sendContractorAssignmentEmail({
    contractorName: v.contractorName,
    contractorEmail: "contractor@example.test",
    issueTitle: v.title,
    issueType: "plumbing",
    issuePriority: "high",
    issueLocation: v.location,
    issueDescription: v.notes,
    siteName: v.site,
    companyName: v.companyName,
    bookedToken: "booked-token-fixture",
    completedToken: "completed-token-fixture",
    baseUrl: "https://app.example.test",
    clientId: 1,
    previewOnly: true,
  });
  const biz = await render(BIZ);
  const plain = await render(PLAIN);
  assertSafeAndReadable("assignment", biz.html, plain.html,
    [BIZ.contractorName, BIZ.companyName, BIZ.title, BIZ.notes, BIZ.location, BIZ.site]);
  check("assignment: subject keeps title and site verbatim", () => {
    assert.equal(biz.subject, `Job Assigned: ${BIZ.title} — ${BIZ.site}`);
  });
  check("assignment: one-time action links are unchanged", () => {
    assert.ok(biz.html.includes(`href="https://app.example.test/api/fix-track/action/booked-token-fixture"`));
    assert.ok(biz.html.includes(`href="https://app.example.test/api/fix-track/action/completed-token-fixture"`));
  });
}

// ── FixTrack quote request ──────────────────────────────────────────────────
console.log("FixTrack quote request");
{
  const render = (v: typeof BIZ) => fixTrack.sendContractorQuoteEmail({
    contractorName: v.contractorName,
    contractorEmail: "contractor@example.test",
    issueTitle: v.title,
    issueType: "gas",
    issuePriority: "urgent",
    issueLocation: v.location,
    issueDescription: v.notes,
    siteName: v.site,
    companyName: v.companyName,
    clientId: 1,
    quoteToken: "quote-token-fixture",
    baseUrl: "https://app.example.test",
    previewOnly: true,
  });
  const biz = await render(BIZ);
  const plain = await render(PLAIN);
  assertSafeAndReadable("quote", biz.html, plain.html,
    [BIZ.contractorName, BIZ.companyName, BIZ.title, BIZ.notes, BIZ.location, BIZ.site]);
  check("quote: subject keeps title and site verbatim", () => {
    assert.equal(biz.subject, `Quote Requested: ${BIZ.title} — ${BIZ.site}`);
  });
  check("quote: quote link is unchanged", () => {
    assert.ok(biz.html.includes(`href="https://app.example.test/contractor-quote/quote-token-fixture"`));
  });
}

// ── Compliance check reminder (buildReminderEmail) ──────────────────────────
console.log("Compliance check reminder");
{
  const token = "11111111-2222-4333-8444-555555555555";
  const render = (v: typeof BIZ) => email.buildReminderEmail({
    contractorName: v.contractorName,
    companyName: v.companyName,
    itemTitle: v.title,
    dueDate: new Date("2030-06-14T00:00:00Z"),
    leadTimeDays: 14,
    notes: v.notes,
    ccMaintenanceEmail: "facilities@example.test",
    scheduleLink: `https://app.example.test/schedule/${token}`,
  });
  const biz = render(BIZ);
  const plain = render(PLAIN);
  const values = [BIZ.contractorName, BIZ.companyName, BIZ.title, BIZ.notes];
  assertSafeAndReadable("reminder", biz.html, plain.html, values);
  assertPlainText("reminder", biz.text, values);
  check("reminder: queued placeholder substitution still removes the bearer", () => {
    // Mirrors sendReminderForItem: only the placeholder is stored in rendered fields.
    const safeHtml = biz.html.split(token).join("{{BOOKED_TOKEN}}");
    const safeText = biz.text.split(token).join("{{BOOKED_TOKEN}}");
    assert.ok(!safeHtml.includes(token) && !safeText.includes(token));
    assert.ok(safeHtml.includes(`href="https://app.example.test/schedule/{{BOOKED_TOKEN}}"`));
    assert.ok(safeText.includes("https://app.example.test/schedule/{{BOOKED_TOKEN}}"));
  });
}

// ── Visit confirmation (public scheduling route) ────────────────────────────
console.log("Visit confirmation");
{
  const render = (v: typeof BIZ) => email.buildVisitConfirmationEmail({
    contractorName: v.contractorName,
    companyName: v.companyName,
    itemTitle: v.title,
    visitDate: new Date("2030-06-10T09:00:00Z"),
  });
  const biz = render(BIZ);
  const plain = render(PLAIN);
  const values = [BIZ.contractorName, BIZ.companyName, BIZ.title];
  assertSafeAndReadable("visit confirmation", biz.html, plain.html, values);
  assertPlainText("visit confirmation", biz.text, values);
  check("visit confirmation: subject keeps title verbatim", () => {
    assert.equal(biz.subject, `Visit Confirmed: ${BIZ.title} — ${biz.dateStr}`);
  });
}

// ── Contractor expiry reminder (contractor-facing, portal link) ─────────────
type Alert = Parameters<ComplianceModule["buildManagerEmailHtml"]>[0][number];
const alertsFor = (v: typeof BIZ): Alert[] => [
  {
    contractorId: 7, contractorName: v.contractorName, contractorEmail: "contractor@example.test",
    company: v.companyName, kind: "cert", milestone: "cert:1:2030-07-01:30",
    detail: `${v.certificate} certificate expires on 01 Jul 2030`,
  },
  {
    contractorId: 7, contractorName: v.contractorName, contractorEmail: "contractor@example.test",
    company: v.companyName, kind: "insurance", milestone: "insurance:2030-07-01:30",
    detail: "Public liability insurance expires on 01 Jul 2030",
  },
];

console.log("Contractor expiry reminder (contractor)");
{
  const portalUrl = "https://app.example.test/contractor-portal/portal-token-fixture";
  const render = (v: typeof BIZ) =>
    compliance.buildContractorEmailHtml(v.contractorName, alertsFor(v), v.site, portalUrl);
  const biz = render(BIZ);
  const plain = render(PLAIN);
  assertSafeAndReadable("contractor expiry", biz, plain,
    [BIZ.contractorName, BIZ.site, `${BIZ.certificate} certificate expires on 01 Jul 2030`]);
  check("contractor expiry: queued portal placeholder still replaces the working link", () => {
    // Mirrors queuePortalReminders: the bearer link is stored only encrypted.
    const stored = biz.replaceAll(portalUrl, "{{PORTAL_URL}}");
    assert.ok(!stored.includes("portal-token-fixture"));
    assert.ok(stored.includes(`href="{{PORTAL_URL}}"`));
  });
  check("contractor expiry: no-portal variant escapes the client name too", () => {
    const noPortal = compliance.buildContractorEmailHtml(BIZ.contractorName, alertsFor(BIZ), BIZ.site);
    assert.deepEqual(
      structure(noPortal),
      structure(compliance.buildContractorEmailHtml(PLAIN.contractorName, alertsFor(PLAIN), PLAIN.site)),
    );
    assert.ok(visibleText(noPortal).includes(BIZ.site));
  });
}

// ── Contractor expiry digest (manager-facing) ───────────────────────────────
console.log("Contractor expiry reminder (manager digest)");
{
  const appUrl = "https://app.example.test";
  const biz = compliance.buildManagerEmailHtml(alertsFor(BIZ), appUrl);
  const plain = compliance.buildManagerEmailHtml(alertsFor(PLAIN), appUrl);
  assertSafeAndReadable("manager digest", biz, plain,
    [BIZ.contractorName, BIZ.companyName, `${BIZ.certificate} certificate expires on 01 Jul 2030`]);
}

// ── Defence in depth: hostile text still cannot form markup ─────────────────
console.log("Hostile text probe");
{
  const hostile = `"><img src=x onerror=alert(1)><a href='javascript:alert(2)'>x</a>`;
  const v = { ...BIZ, contractorName: hostile, title: hostile, companyName: hostile, notes: hostile, site: hostile, certificate: hostile };
  const pairs: [string, string, string][] = [
    ["visit confirmation", email.buildVisitConfirmationEmail({ contractorName: hostile, companyName: hostile, itemTitle: hostile, visitDate: new Date("2030-06-10T09:00:00Z") }).html,
      email.buildVisitConfirmationEmail({ contractorName: "A", companyName: "B", itemTitle: "C", visitDate: new Date("2030-06-10T09:00:00Z") }).html],
    ["contractor expiry", compliance.buildContractorEmailHtml(hostile, alertsFor(v), hostile), compliance.buildContractorEmailHtml("A", alertsFor(PLAIN), "B")],
    ["manager digest", compliance.buildManagerEmailHtml(alertsFor(v), "https://app.example.test"), compliance.buildManagerEmailHtml(alertsFor(PLAIN), "https://app.example.test")],
  ];
  for (const [label, html, baseline] of pairs) {
    check(`${label}: hostile text adds no elements or attributes`, () => {
      assert.deepEqual(structure(html), structure(baseline));
      assert.ok(!/<img|<a href='javascript/i.test(html));
    });
  }
}

console.log(`\nemail business-text escaping: ${passed} checks passed`);
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
