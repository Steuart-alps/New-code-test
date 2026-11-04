// Pure tests for drafting a COSHH assessment from a safety data sheet with
// Claude (src/lib/coshhDrafting.ts), against a local stand-in for the
// Anthropic API: what is sent, and how the reply is cleaned up for the person
// to check. No real API key or network is used.
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
      ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30000, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: reply.stopReason, stop_sequence: null }, usage: { output_tokens: 2500 } }],
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
delete process.env.COSHH_DRAFTING_MODEL;
delete process.env.COSHH_DRAFTING_EFFORT;

const { draftCoshhAssessment } = await import("../src/lib/coshhDrafting");
const { ReportReadingError, UnreadableReportError } = await import("../src/lib/reportReading");

const pdf = { bytes: Buffer.from("%PDF-1.4\n"), mimeType: "application/pdf", fileName: "Kitchen degreaser SDS.pdf" };
const input = { files: [pdf], today: "2026-11-04" };
const sheet = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  wrong_file: false,
  product_name: "  Heavy Duty   Degreaser ",
  supplier: "Clean Co Ltd",
  sds_date: "2025-03-14",
  hazard_pictograms: ["ghs05", "ghs07", "ghs99"],
  signal_word: "Danger",
  hazard_statements: "H314 Causes severe skin burns and eye damage\n\n\n\nEUH071 Corrosive to the respiratory tract",
  health_effects: "Burns to skin and eyes.",
  exposure_limits: "Sodium hydroxide: STEL 2 mg/m3 (EH40)",
  exposure_routes: ["skin", "eyes", "inhalation", "telepathy"],
  ppe: ["gloves", "eye_protection", "hat"],
  ppe_details: "Nitrile gloves (EN ISO 374); goggles (EN 166)",
  controls: "Use diluted from the dispenser.\nNever mix with bleach.",
  storage: "Locked store, away from acids.",
  spill_procedure: "Absorb with sand.",
  first_aid: "Eyes: rinse for 15 minutes.",
  disposal: "Licensed waste contractor.",
  task: "Cleaning kitchen surfaces with the degreaser",
  who_at_risk: "Kitchen staff and cleaners",
  risk_level: "Medium",
  health_surveillance_required: false,
  monitoring_required: false,
  lev_required: false,
  summary: "Corrosive alkaline cleaner.",
  unclear: ["Section 8 glove thickness", "  "],
  ...overrides,
});

try {
  // ── A sheet is read into the form's fields ──────────────────────────────
  reply = { stopReason: "end_turn", text: sheet() };
  let claimed = 0;
  const draft = await draftCoshhAssessment(input, async () => { claimed += 1; });
  assert.equal(claimed, 1, "the AI allowance is claimed once, before the sheet is sent");
  const sent = requests.at(-1)!;
  assert.equal(sent.body.model, "claude-opus-5-5", "Opus 5.5 by default (agreed 27 Oct)");
  assert.equal(sent.body.output_config.effort, "high", "high effort by default");
  assert.equal(sent.body.fallbacks, "default");
  const schema = sent.body.output_config.format.schema;
  assert.ok(schema.required.includes("wrong_file"));
  assert.deepEqual(schema.properties.ppe.items.enum, ["gloves", "eye_protection", "face_shield", "respirator", "apron_overalls", "footwear"]);
  assert.match(sent.body.system, /Scope: you only read a safety data sheet/);
  assert.match(sent.body.system, /never approve/);
  assert.match(sent.body.system, /EH40/);
  const [doc, context] = sent.body.messages[0].content;
  assert.equal(doc.type, "document");
  assert.match(context.text, /File name: "Kitchen degreaser SDS\.pdf"/, "the file name is a quoted label");
  assert.match(context.text, /Today: 2026-11-04/);

  assert.equal(draft.productName, "Heavy Duty Degreaser", "spaces are tidied");
  assert.equal(draft.supplier, "Clean Co Ltd");
  assert.equal(draft.sdsDate, "2025-03-14");
  assert.deepEqual(draft.hazardPictograms, ["ghs05", "ghs07"], "unknown pictograms are dropped");
  assert.equal(draft.signalWord, "danger");
  assert.equal(draft.hazardStatements, "H314 Causes severe skin burns and eye damage\n\nEUH071 Corrosive to the respiratory tract", "line breaks kept, blank runs shortened");
  assert.deepEqual(draft.exposureRoutes, ["inhalation", "skin", "eyes"], "only the form's routes, in its order");
  assert.deepEqual(draft.ppe, ["gloves", "eye_protection"]);
  assert.equal(draft.controls, "Use diluted from the dispenser.\nNever mix with bleach.");
  assert.equal(draft.riskLevel, "medium");
  assert.deepEqual(draft.unclear, ["Section 8 glove thickness"]);
  assert.equal(draft.inputTokens, 30000);
  assert.equal(draft.outputTokens, 2500);
  console.log("ok - a safety data sheet is read into the assessment form's fields");

  // ── Odd values are left for the person ──────────────────────────────────
  reply = { stopReason: "end_turn", text: sheet({ sds_date: "14/03/2025", signal_word: "caution", risk_level: "extreme", supplier: " " }) };
  const odd = await draftCoshhAssessment(input);
  assert.equal(odd.sdsDate, null, "dates must be YYYY-MM-DD");
  assert.equal(odd.signalWord, null);
  assert.equal(odd.riskLevel, "medium", "an unknown risk level falls back to medium");
  assert.equal(odd.supplier, null);
  console.log("ok - bad dates, signal words and risk levels are left for the person");

  // ── Photos of the pages are read together ───────────────────────────────
  reply = { stopReason: "end_turn", text: sheet() };
  await draftCoshhAssessment({ ...input, files: [
    { bytes: Buffer.from([0xff, 0xd8, 0xff]), mimeType: "image/jpeg", fileName: "page 1.jpg" },
    { bytes: Buffer.from([0xff, 0xd8, 0xff]), mimeType: "image/jpeg", fileName: "page 2.jpg" },
  ] });
  const pages = requests.at(-1)!.body.messages[0].content;
  assert.equal(pages[0].text, 'Page or file 1: "page 1.jpg"');
  assert.equal(pages[1].type, "image");
  assert.equal(pages[2].text, 'Page or file 2: "page 2.jpg"');
  console.log("ok - photos of a sheet's pages are sent together as one sheet");

  // ── Files that cannot be read are not sent or claimed ───────────────────
  const before = requests.length;
  claimed = 0;
  const claim = async () => { claimed += 1; };
  await assert.rejects(draftCoshhAssessment({ ...input, files: [{ ...pdf, mimeType: "application/vnd.ms-excel" }] }, claim), UnreadableReportError);
  await assert.rejects(draftCoshhAssessment({ ...input, files: [{ ...pdf, bytes: Buffer.alloc(21 * 1024 * 1024) }] }, claim), UnreadableReportError);
  await assert.rejects(draftCoshhAssessment({ ...input, files: Array.from({ length: 11 }, () => pdf) }, claim), /up to 10/);
  await assert.rejects(draftCoshhAssessment({ ...input, files: [] }, claim), UnreadableReportError);
  assert.equal(requests.length, before, "nothing is sent for a file that cannot be read");
  assert.equal(claimed, 0, "nor claimed against the AI allowance");
  await assert.rejects(draftCoshhAssessment(input, async () => { throw new Error("allowance used"); }), /allowance used/);
  assert.equal(requests.length, before, "nothing is sent once the allowance is used");
  console.log("ok - unreadable files and a used-up allowance are turned away before anything is sent");

  // ── Replies that cannot be used ─────────────────────────────────────────
  reply = { stopReason: "refusal", text: "" };
  await assert.rejects(draftCoshhAssessment(input), ReportReadingError);
  reply = { stopReason: "max_tokens", text: "{" };
  await assert.rejects(draftCoshhAssessment(input), /too long/);
  reply = { stopReason: "end_turn", text: "not json" };
  await assert.rejects(draftCoshhAssessment(input), ReportReadingError);
  reply = { stopReason: "end_turn", text: sheet({ wrong_file: true }) };
  await assert.rejects(draftCoshhAssessment(input), /does not look like a safety data sheet/);
  reply = { stopReason: "end_turn", text: sheet({ product_name: "  " }) };
  await assert.rejects(draftCoshhAssessment(input), /does not look like a safety data sheet/);
  console.log("ok - unusable replies and files that are not safety data sheets give a message the person can act on");
} finally {
  server.close();
}
