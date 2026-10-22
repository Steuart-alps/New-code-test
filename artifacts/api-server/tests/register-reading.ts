// Pure tests for reading a PAT register list with Claude (src/lib/registerReading.ts),
// against a local stand-in for the Anthropic API: what is sent, and how the
// reply becomes rows for the appliance import. No real API key or network is used.
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
      ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1800, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: reply.stopReason, stop_sequence: null }, usage: { output_tokens: 900 } }],
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
delete process.env.REPORT_READING_MODEL;
delete process.env.REGISTER_READING_MONTHLY_LIMIT;

const { readApplianceList, registerReadingMonthlyLimit } = await import("../src/lib/registerReading");
const { ReportReadingError, UnreadableReportError } = await import("../src/lib/reportReading");

const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const input = {
  bytes: photo,
  mimeType: "image/jpeg",
  fileName: "pat-list.jpg",
  sites: [{ id: 4, name: "Clubhouse" }, { id: 7, name: "Greenkeepers shed" }],
  siteId: 4,
};

try {
  assert.equal(registerReadingMonthlyLimit(), 10, "ten lists a month by default");

  // ── A photo is sent as an image and the reply becomes import rows ─────────
  reply = {
    stopReason: "end_turn",
    text: JSON.stringify({
      appliances: [
        { name: " Kettle  1 ", asset_tag: "PAT-001", appliance_type: "Kitchen Appliance", site_id: null, location: "Bar", notes: null, unclear: false },
        { name: "Strimmer", asset_tag: null, appliance_type: "Garden Tool", site_id: 7, location: "Shed", notes: "Stihl", unclear: true },
        { name: "Laptop", asset_tag: null, appliance_type: "IT Equipment", site_id: 99, location: null, notes: null, unclear: false },
        { name: "   ", asset_tag: null, appliance_type: "Other", site_id: null, location: null, notes: null, unclear: false },
      ],
    }),
  };
  let counted = 0;
  const result = await readApplianceList(input, async () => { counted += 1; });
  assert.equal(counted, 1, "the reading is counted once, before it is sent");
  const sent = requests.at(-1)!;
  assert.equal(sent.body.model, "claude-opus-5-5");
  assert.equal(sent.body.fallbacks, "default");
  assert.match(String(sent.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  assert.equal(sent.body.output_config.format.type, "json_schema");
  const item = sent.body.output_config.format.schema.properties.appliances.items.properties;
  assert.ok(item.appliance_type.enum.includes("Kitchen Appliance"));
  assert.deepEqual(item.site_id.anyOf[0].enum, [4, 7]);
  const [image, context] = sent.body.messages[0].content;
  assert.equal(image.type, "image");
  assert.equal(image.source.media_type, "image/jpeg");
  assert.match(context.text, /The person chose site 4 \(Clubhouse\)/);

  assert.deepEqual(result.headers, ["Appliance name", "Asset tag", "Appliance type", "Site", "Location", "Notes"]);
  assert.equal(result.rows.length, 3, "blank names are dropped");
  assert.deepEqual(result.rows[0], ["Kettle 1", "PAT-001", "Kitchen Appliance", "Clubhouse", "Bar", ""], "no site from the list means the chosen site");
  assert.deepEqual(result.rows[1], ["Strimmer", "", "Other", "Greenkeepers shed", "Shed", "Check: hard to read. Stihl"], "unknown types become Other; unclear lines are marked");
  assert.equal(result.rows[2][3], "Clubhouse", "an unknown site falls back to the chosen site");
  assert.equal(result.unclear, 1);
  assert.equal(result.inputTokens, 1800);
  assert.equal(result.outputTokens, 900);
  console.log("ok - a photo is sent as an image and the reply becomes rows in the import's columns");

  // ── No site chosen leaves Site blank ────────────────────────────────────
  reply = { stopReason: "end_turn", text: JSON.stringify({ appliances: [{ name: "Toaster", asset_tag: null, appliance_type: "Kitchen Appliance", site_id: null, location: null, notes: null, unclear: false }] }) };
  const noSite = await readApplianceList({ ...input, siteId: null, bytes: Buffer.from("%PDF-1.4\n"), mimeType: "application/pdf" });
  assert.equal(requests.at(-1)!.body.messages[0].content[0].source.media_type, "application/pdf");
  assert.match(requests.at(-1)!.body.messages[0].content[1].text, /did not choose a site/);
  assert.equal(noSite.rows[0][3], "");
  console.log("ok - a PDF with no chosen site leaves Site blank for the person to fill in");

  // ── Files that cannot be read are not sent or counted ───────────────────
  const before = requests.length;
  counted = 0;
  const count = async () => { counted += 1; };
  await assert.rejects(readApplianceList({ ...input, mimeType: "application/vnd.ms-excel" }, count), UnreadableReportError);
  await assert.rejects(readApplianceList({ ...input, bytes: Buffer.alloc(9 * 1024 * 1024), mimeType: "application/pdf" }, count), UnreadableReportError);
  await assert.rejects(readApplianceList({ ...input, bytes: Buffer.alloc(6 * 1024 * 1024) }, count), UnreadableReportError);
  assert.equal(requests.length, before, "nothing is sent for a file that cannot be read");
  assert.equal(counted, 0, "nor counted towards the month's readings");
  await assert.rejects(readApplianceList(input, async () => { throw new Error("limit reached"); }), /limit reached/);
  assert.equal(requests.length, before, "nothing is sent once the month's readings are used");
  console.log("ok - unreadable files and a used-up month are turned away before anything is sent");

  // ── Replies that cannot be used ─────────────────────────────────────────
  reply = { stopReason: "refusal", text: "" };
  await assert.rejects(readApplianceList(input), ReportReadingError);
  reply = { stopReason: "end_turn", text: "not json" };
  await assert.rejects(readApplianceList(input), ReportReadingError);
  reply = { stopReason: "end_turn", text: JSON.stringify({ appliances: [] }) };
  await assert.rejects(readApplianceList(input), /No appliances were found/);
  console.log("ok - unusable replies give a message the person can act on");

  console.log("Register reading checks passed.");
} finally {
  server.close();
}
