import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCalendarInvite } from "../src/lib/email";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/calendar");

type FixtureCase = {
  filename: string;
  expectedStart: string;
  expectedEnd: string;
  expectedSequence: string;
  expectedSummary: string;
  expectedMethod?: string;
  expectedStatus?: string;
  invite: string;
};

const cases: FixtureCase[] = [
  {
    filename: "uk-dst-start.ics",
    expectedStart: "20300331",
    expectedEnd: "20300401",
    expectedSequence: "0",
    expectedSummary: "Boiler service",
    invite: buildCalendarInvite({
      itemTitle: "Boiler service",
      dueDate: new Date("2030-03-31T00:00:00.000Z"),
      contractorName: "Alex Morgan",
      contractorEmail: "alex@example.test",
      companyName: "ALPS Consulting",
      fromEmail: "compliance@example.test",
      notes: "Site: London\nLocation: Plant room",
      descriptionLabel: "Maintenance job",
      uid: "fix-track-44-880@complytrack",
      sequence: 0,
      allDay: true,
      generatedAt: new Date("2030-03-01T12:34:56.000Z"),
    }),
  },
  {
    filename: "uk-dst-end-long-unicode-update.ics",
    expectedStart: "20301027",
    expectedEnd: "20301028",
    expectedSequence: "2",
    expectedSummary: "Révision complète — chaudière № 12 🔧 with an intentionally long title for calendar clients",
    invite: buildCalendarInvite({
      itemTitle: "Révision complète — chaudière № 12 🔧 with an intentionally long title for calendar clients",
      dueDate: new Date("2030-10-27T00:00:00.000Z"),
      contractorName: "Zoë O’Connor",
      contractorEmail: "zoe@example.test",
      companyName: "ÅLPS “Facilities” ^ Europe",
      fromEmail: "compliance@example.test",
      notes: "Site: Café Français\nLocation: Sous-sol\nBring replacement seal; confirm access with José.",
      descriptionLabel: "Maintenance job",
      uid: "fix-track-44-881@complytrack",
      sequence: 2,
      allDay: true,
      generatedAt: new Date("2030-10-01T08:00:00.000Z"),
    }),
  },
  {
    filename: "uk-cancelled-calendar-update.ics",
    expectedStart: "20301027",
    expectedEnd: "20301028",
    expectedSequence: "3",
    expectedSummary: "Révision complète — chaudière № 12 🔧 with an intentionally long title for calendar clients",
    expectedMethod: "CANCEL",
    expectedStatus: "CANCELLED",
    invite: buildCalendarInvite({
      itemTitle: "Révision complète — chaudière № 12 🔧 with an intentionally long title for calendar clients",
      dueDate: new Date("2030-10-27T00:00:00.000Z"),
      contractorName: "Zoë O’Connor",
      contractorEmail: "zoe@example.test",
      companyName: "ÅLPS “Facilities” ^ Europe",
      fromEmail: "compliance@example.test",
      notes: "This FixTrack assignment has been cancelled.",
      descriptionLabel: "Cancelled maintenance job",
      uid: "fix-track-44-881@complytrack",
      sequence: 3,
      allDay: true,
      method: "CANCEL",
      eventStatus: "CANCELLED",
      generatedAt: new Date("2030-10-01T08:00:00.000Z"),
    }),
  },
];

function unfold(ics: string): string[] {
  assert.ok(ics.endsWith("\r\n"), "calendar data must end with CRLF");
  assert.ok(!/(?<!\r)\n/.test(ics), "calendar data must not contain bare LF line endings");
  const physicalLines = ics.slice(0, -2).split("\r\n");
  for (const line of physicalLines) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `line exceeds 75 octets: ${line}`);
  }
  const logicalLines: string[] = [];
  for (const line of physicalLines) {
    if (/^[ \t]/.test(line)) {
      assert.ok(logicalLines.length > 0, "folded line must follow a content line");
      logicalLines[logicalLines.length - 1] += line.slice(1);
    } else {
      logicalLines.push(line);
    }
  }
  return logicalLines;
}

function property(lines: string[], name: string): string {
  const prefix = `${name}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, `missing ${name}`);
  return line.slice(prefix.length);
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

for (const fixture of cases) {
  const path = resolve(FIXTURE_DIR, fixture.filename);
  if (process.env.UPDATE_ICS_FIXTURES === "1") writeFileSync(path, fixture.invite);
  const normalizedFixture = readFileSync(path, "utf8").replace(/\r?\n/g, "\r\n");
  const recordedFixture = normalizedFixture.endsWith("\r\n") ? normalizedFixture : `${normalizedFixture}\r\n`;
  assert.equal(fixture.invite, recordedFixture, `${fixture.filename} changed; regenerate intentionally`);

  const lines = unfold(fixture.invite);
  assert.equal(property(lines, "VERSION"), "2.0");
  assert.equal(property(lines, "CALSCALE"), "GREGORIAN");
  assert.equal(property(lines, "METHOD"), fixture.expectedMethod ?? "REQUEST");
  assert.equal(property(lines, "SEQUENCE"), fixture.expectedSequence);
  assert.equal(property(lines, "STATUS"), fixture.expectedStatus ?? "CONFIRMED");
  assert.equal(property(lines, "DTSTART;VALUE=DATE"), fixture.expectedStart);
  assert.equal(property(lines, "DTEND;VALUE=DATE"), fixture.expectedEnd);
  assert.equal(unescapeText(property(lines, "SUMMARY")), fixture.expectedSummary);
  assert.ok(property(lines, "UID").endsWith("@complytrack"));
  assert.match(property(lines, "DTSTAMP"), /^\d{8}T\d{6}Z$/);
  assert.ok(lines.some((line) => line.startsWith("ORGANIZER;CN=") && line.includes(":MAILTO:")));
  assert.ok(lines.some((line) => line.startsWith("ATTENDEE;ROLE=REQ-PARTICIPANT;")));
  assert.equal(lines.at(-1), "END:VCALENDAR");
}

console.log(`${cases.length} calendar compatibility fixtures passed`);