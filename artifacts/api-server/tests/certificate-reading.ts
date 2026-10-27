// Pure tests for reading a contractor certificate with Claude (src/lib/certificateReading.ts),
// against a local stand-in for the Anthropic API: what is sent, and how the
// reply is cleaned up for the person to check. No real API key or network is used.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

type Reply = { stopReason: string; text: string };
const requests: Array<{ headers: IncomingMessage["headers"]; body: any }> = [];
let reply: Reply = { stopReason: "end_turn", text: "{}" };

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    requests.push({ headers: req.headers, body: JSON.parse(raw) });
    const events: Array<[string, unknown]> = [
      ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42000, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: reply.stopReason, stop_sequence: null }, usage: { output_tokens: 1500 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
delete process.env.CERTIFICATE_READING_MODEL;
delete process.env.CERTIFICATE_READING_EFFORT;

const { readCertificate } = await import("../src/lib/certificateReading");
const { ReportReadingError, UnreadableReportError } = await import("../src/lib/reportReading");

const checks = [
  { id: 11, title: "Electrical Installation Condition Report (EICR)", track: "Electrical", siteName: "Clubhouse", siteAddress: "6 Greek Street,\n Leeds LS1 5RW", contractorName: "Sparks Ltd", frequencyMonths: 60 },
  { id: 12, title: "Gas Safety Inspection", track: null, siteName: null, contractorName: null, frequencyMonths: 12 },
  { id: 13, title: "Fire Alarm Maintenance", track: "FireTrack", siteName: "Clubhouse", contractorName: null, frequencyMonths: 6 },
];
const input = {
  bytes: Buffer.from("%PDF-1.4\n"),
  mimeType: "application/pdf",
  fileName: "eicr.pdf",
  today: "2026-10-27",
  checks,
  itemId: null as number | null,
};
const reading = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  wrong_file: false,
  certificate_type: "Electrical Installation Condition Report (EICR)",
  name: "EICR 2026 - Clubhouse",
  check_id: 11,
  check_reason: "An EICR for the clubhouse.",
  new_check: null,
  contractor: "Sparks Ltd",
  issue_date: "2026-10-20",
  next_inspection_date: "2031-10-20",
  outcome: "unsatisfactory",
  summary: "Unsatisfactory: one C1, one C2, one FI and two C3s.",
  defects: [
    { code: "C1", description: "Exposed  live conductors ", location: "Kitchen", reference: "1", needs_work: true },
    { code: "C2", description: "No RCD protection", location: null, reference: "2", needs_work: true },
    { code: "C3", description: "No surge protection", location: null, reference: "3", needs_work: true },
    { code: "FI", description: "Circuit 7 not traced", location: "DB2", reference: "4", needs_work: false },
    { code: "LIM", description: "Loft not inspected", location: null, reference: null, needs_work: false },
    { code: "other", description: "Replace cracked socket", location: "Bar", reference: null, needs_work: true },
    { code: "C2", description: "   ", location: null, reference: null, needs_work: true },
  ],
  unclear: ["Engineer's signature date"],
  ...overrides,
});

try {
  // ── An EICR is matched to its check; codes decide what needs work ───────
  reply = { stopReason: "end_turn", text: reading() };
  let claimed = 0;
  const result = await readCertificate(input, async () => { claimed += 1; });
  assert.equal(claimed, 1, "the AI allowance is claimed once, before the file is sent");
  const sent = requests.at(-1)!;
  assert.equal(sent.body.model, "claude-sonnet-5-5", "Sonnet 5.5 by default");
  assert.equal(sent.body.output_config.effort, "low", "low effort by default");
  assert.equal(sent.body.fallbacks, "default");
  assert.match(String(sent.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  const schema = sent.body.output_config.format.schema;
  assert.deepEqual(schema.properties.check_id.anyOf[0].enum, [11, 12, 13]);
  assert.ok(schema.properties.defects.items.properties.code.enum.includes("FI"));
  const [doc, context] = sent.body.messages[0].content;
  assert.equal(doc.type, "document");
  assert.match(context.text, /11 = "Electrical Installation Condition Report \(EICR\)"; track: "Electrical"; site: "Clubhouse" \("6 Greek Street, Leeds LS1 5RW"\); contractor: "Sparks Ltd"; every 60 months/);
  assert.match(context.text, /File name: "eicr\.pdf"/, "typed names are quoted as labels");
  assert.ok(schema.required.includes("wrong_file"));
  assert.match(sent.body.system, /Scope: you only read a contractor certificate or inspection report/);
  assert.match(context.text, /did not say which check/);
  assert.match(sent.body.system, /C1, C2 and FI need work; C3 does not/);
  assert.match(sent.body.system, /On Yes\/No checklists/);
  assert.match(sent.body.system, /struck through or overtyped with X's is the one that does NOT apply/);

  assert.equal(result.itemId, 11);
  assert.equal(result.issueDate, "2026-10-20");
  assert.equal(result.nextInspectionDate, "2031-10-20");
  assert.equal(result.nextInspectionSource, "certificate");
  assert.equal(result.outcome, "unsatisfactory");
  assert.equal(result.newCheck, null);
  assert.equal(result.defects.length, 6, "blank descriptions are dropped");
  const byCode = (text: string) => result.defects.find((d) => d.description === text)!;
  assert.equal(byCode("Exposed live conductors").needsWork, true, "spaces are tidied");
  assert.equal(byCode("No surge protection").needsWork, false, "a C3 is never remedial work");
  assert.equal(byCode("Circuit 7 not traced").needsWork, true, "an FI always is");
  assert.equal(byCode("Loft not inspected").code, "other", "unknown codes become other");
  assert.equal(byCode("Loft not inspected").needsWork, false);
  assert.equal(byCode("Replace cracked socket").needsWork, true, "other work follows the reading");
  assert.deepEqual(result.unclear, ["Engineer's signature date"]);
  assert.equal(result.inputTokens, 42000);
  assert.equal(result.outputTokens, 1500);
  console.log("ok - an EICR is matched to its check; C1, C2 and FI need work, C3s do not");

  // ── No stated next date: worked out from the check's repeat interval ────
  reply = { stopReason: "end_turn", text: reading({ check_id: 12, next_inspection_date: null, issue_date: "2026-01-31", defects: [] }) };
  const gas = await readCertificate(input);
  assert.equal(gas.itemId, 12);
  assert.equal(gas.nextInspectionDate, "2027-01-31");
  assert.equal(gas.nextInspectionSource, "repeat");
  console.log("ok - with no stated date the next inspection comes from the check's repeat interval");

  // ── Opened from a check: only that check is offered and kept ────────────
  reply = { stopReason: "end_turn", text: reading({ check_id: 12 }) };
  const fixed = await readCertificate({ ...input, itemId: 13 });
  assert.deepEqual(requests.at(-1)!.body.output_config.format.schema.properties.check_id.anyOf[0].enum, [13]);
  assert.match(requests.at(-1)!.body.messages[0].content[1].text, /opened this from check 13/);
  assert.equal(fixed.itemId, 13, "the check it was opened from wins");
  console.log("ok - opened from a check, the certificate stays with that check");

  // ── No check fits: a new one is suggested; unknown ids are dropped ──────
  reply = { stopReason: "end_turn", text: reading({ check_id: 99, new_check: { title: "LOLER Thorough Examination", frequency_months: 6 }, next_inspection_date: null, issue_date: "2026-10-01" }) };
  const loler = await readCertificate(input);
  assert.equal(loler.itemId, null, "an id that is not one of the checks is ignored");
  assert.deepEqual(loler.newCheck, { title: "LOLER Thorough Examination", frequencyMonths: 6 });
  assert.equal(loler.nextInspectionDate, "2027-04-01", "the suggested check's interval sets the next date");
  reply = { stopReason: "end_turn", text: reading({ issue_date: "20/10/2026", next_inspection_date: "2031-02-30" }) };
  const badDates = await readCertificate(input);
  assert.equal(badDates.issueDate, null, "dates must be YYYY-MM-DD");
  assert.equal(badDates.nextInspectionDate, null);
  console.log("ok - with no matching check a new one is suggested, and bad dates are left for the person");

  // ── Files that cannot be read are not sent or claimed ───────────────────
  const before = requests.length;
  claimed = 0;
  const claim = async () => { claimed += 1; };
  await assert.rejects(readCertificate({ ...input, mimeType: "application/vnd.ms-excel" }, claim), UnreadableReportError);
  await assert.rejects(readCertificate({ ...input, bytes: Buffer.alloc(16 * 1024 * 1024) }, claim), UnreadableReportError);
  await assert.rejects(readCertificate({ ...input, mimeType: "image/jpeg", bytes: Buffer.alloc(6 * 1024 * 1024) }, claim), UnreadableReportError);
  assert.equal(requests.length, before, "nothing is sent for a file that cannot be read");
  assert.equal(claimed, 0, "nor claimed against the AI allowance");
  await assert.rejects(readCertificate(input, async () => { throw new Error("allowance used"); }), /allowance used/);
  assert.equal(requests.length, before, "nothing is sent once the allowance is used");
  console.log("ok - unreadable files and a used-up allowance are turned away before anything is sent");

  // ── Replies that cannot be used ─────────────────────────────────────────
  reply = { stopReason: "refusal", text: "" };
  await assert.rejects(readCertificate(input), ReportReadingError);
  reply = { stopReason: "max_tokens", text: "{" };
  await assert.rejects(readCertificate(input), /too long/);
  reply = { stopReason: "end_turn", text: "not json" };
  await assert.rejects(readCertificate(input), ReportReadingError);
  reply = { stopReason: "end_turn", text: reading({ wrong_file: true }) };
  await assert.rejects(readCertificate(input), /does not look like a contractor certificate/);
  console.log("ok - unusable replies and files that are not certificates give a message the person can act on");

  console.log("Certificate reading checks passed.");
} finally {
  server.close();
}
