// Every email the site sends uses one design: the ComplyTrack header, the
// message in a white card, and a footer with the ALPS logo and legal name.
// sendEmail and sendSystemEmail apply it; bodies already built with the
// layout are left alone, so nothing is wrapped twice.
// Usage: node tests/email-layout.mjs (DATABASE_URL must be set; nothing connects)
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.PUBLIC_APP_URL = "https://app.example.test";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-email-layout-"));
let lib;
try {
  const output = path.join(temp, "email.mjs");
  await build({
    entryPoints: [path.join(testsDir, "email-layout.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  lib = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const MARKER = 'data-complytrack-email="1"';
const count = (html, needle) => html.split(needle).length - 1;

function assertBranded(html, label) {
  assert.equal(count(html, MARKER), 1, `${label}: one layout`);
  assert.equal(count(html, "<html"), 1, `${label}: one HTML document`);
  assert.match(html, /🛡️ ComplyTrack/, `${label}: ComplyTrack header`);
  assert.match(html, /src="https:\/\/app\.example\.test\/email-assets\/alps-logo\.png"/, `${label}: ALPS logo from the site`);
  assert.match(html, /alt="ALPS Consultancy"/, `${label}: logo has a text alternative`);
  assert.match(html, /ALPS Consulting Ltd t\/as ALPS Consultancy/, `${label}: legal name in the footer`);
}

// A plain body is placed, unchanged, inside the layout.
const plain = `<div><h2>Reset your password</h2><a href="https://app.example.test/reset">Reset</a></div>`;
const wrapped = lib.applyEmailLayout(plain);
assertBranded(wrapped, "plain body");
assert.ok(wrapped.includes(plain), "plain body kept as written");

// An older body's Arial font is dropped so it reads in the layout's typeface,
// and small print is raised a step.
const arial = lib.applyEmailLayout(`<div style="font-family: Arial, sans-serif; max-width: 600px;"><p style="font-size:12px;">Small print</p><p style="font-size:18px;">Big</p></div>`);
assertBranded(arial, "Arial body");
assert.doesNotMatch(arial, /Arial, sans-serif/, "body's own Arial font removed");
assert.match(arial, /<div style="max-width: 600px;">/, "other body styles kept");
assert.match(arial, /font-size:13px;">Small print/, "12px raised to 13px");
assert.match(arial, /font-size:18px;">Big/, "larger text unchanged");

// A full document keeps only what is inside its <body>.
const fullDoc = `<!DOCTYPE html><html><body style="color:#111"><h2>Monthly summary</h2></body></html>`;
const fromDoc = lib.applyEmailLayout(fullDoc);
assertBranded(fromDoc, "full document");
assert.ok(fromDoc.includes("<h2>Monthly summary</h2>"), "document body kept");
assert.ok(!fromDoc.includes('style="color:#111"'), "old body tag dropped");

// Layout output passes through untouched, so retries render identical HTML.
assert.equal(lib.applyEmailLayout(wrapped), wrapped, "already branded HTML is not wrapped again");

// Emails built with the layout directly keep their subtitle and footer note.
const reminder = lib.buildCheckReminderEmailHtml(
  [{ module: "fire", moduleLabel: "Fire", modulePath: "/fire", checkType: "alarm", checkLabel: "Fire alarm test", status: "overdue", lastDate: null, dueDate: "2026-10-17", daysUntilDue: -2, frequencyLabel: "Weekly", siteId: null, siteName: null }],
  "https://app.example.test",
);
assertBranded(reminder, "check reminder");
assert.equal(lib.applyEmailLayout(reminder), reminder, "check reminder sent as built");
assert.match(reminder, /Safety Check Reminders/);
assert.match(reminder, /2 days overdue/, "an overdue check reads as overdue, not as due later");
assert.match(reminder, /You are receiving this as an account manager\./);
assert.match(reminder, /<a href="https:\/\/app\.example\.test" style="display:inline-block;background:#2563eb;/, "blue button");

// The same-day alert lists its items in the reminder email's table, with a badge each.
const urgent = lib.buildUrgentAlertEmail("Red Lion <Ltd>", [
  { kind: "compliance", id: 1, module: "compliance", title: "Fire risk assessment", site_id: null, site_name: null, urgent: true, assignee_user_id: null, owner_name: null, created_by: null },
  { kind: "fix", id: 2, module: "fix", title: "Dripping tap", site_id: 3, site_name: "Bar", urgent: false, assignee_user_id: null, owner_name: null, created_by: null },
], "Ann Smith");
assertBranded(urgent.html, "urgent alert");
assert.equal(urgent.subject, "2 items need action today at Red Lion <Ltd> — ComplyTrack");
assert.match(urgent.html, /Needs action today<\/div>/, "subtitle says why it was sent");
assert.match(urgent.html, /Hello Ann,/);
assert.match(urgent.html, /2 items need action today at Red Lion &lt;Ltd&gt;\./, "business name escaped");
assert.match(urgent.html, /<table[\s\S]*Fire risk assessment[\s\S]*>Critical<\/span>[\s\S]*Dripping tap[\s\S]*New FixTrack issue · Bar[\s\S]*>New<\/span>/, "items with badges in a table");
assert.match(urgent.html, /href="https:\/\/app\.example\.test\/fix-track\/2"/, "each item links to it");
assert.match(urgent.html, /style="display:inline-block;background:#2563eb;[^"]*font-size:16px;font-weight:700;">Open ComplyTrack/, "blue button");

// Business text in subtitles and notes is escaped by the caller; the layout adds none.
const named = lib.renderEmailLayout({ bodyHtml: "<p>Hi</p>", subtitle: "SafeTrack", footerNote: "Sent on behalf of A &amp; B." });
assertBranded(named, "subtitle and note");
assert.match(named, /SafeTrack<\/div>/);
assert.match(named, /ComplyTrack by ALPS Consultancy · Sent on behalf of A &amp; B\./);

// Builders whose bodies are wrapped at send time.
const visit = lib.buildVisitConfirmationEmail({ contractorName: "Sam", companyName: "Acme", itemTitle: "Boiler", visitDate: new Date("2026-11-02T10:00:00Z") });
assertBranded(lib.applyEmailLayout(visit.html), "visit confirmation");
const reset = lib.buildTwoFactorResetEmail({ to: "a@example.test", name: "Ann", resetAt: new Date("2026-10-19T12:00:00Z") });
assertBranded(lib.applyEmailLayout(reset.html), "two-factor reset alert");

console.log("email layout: all checks passed");
process.exit(0);
