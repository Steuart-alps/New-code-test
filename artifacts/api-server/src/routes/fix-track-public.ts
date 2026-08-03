/**
 * Public (no-auth) endpoints for contractor one-click job actions.
 * Accessed via links in the assignment email.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";

const router = Router();
const storage = new ObjectStorageService();

// ── Helpers ───────────────────────────────────────────────────────────────────

interface TokenRow {
  id: number;
  token: string;
  issue_id: number;
  client_id: number;
  contractor_id: number | null;
  action: string;
  expires_at: Date;
  used_at: Date | null;
  issue_title: string;
  issue_type: string;
  issue_priority: string;
  issue_location: string;
  issue_description: string | null;
  site_name: string | null;
  company_name: string;
}

async function lookupToken(token: string): Promise<TokenRow | null> {
  if (!token || token.length < 8) return null;
  const result = await db.execute(sql`
    SELECT
      t.*,
      fi.title       AS issue_title,
      fi.issue_type,
      fi.priority    AS issue_priority,
      fi.location    AS issue_location,
      fi.description AS issue_description,
      s.name         AS site_name,
      cl.name        AS company_name
    FROM   fix_track_action_tokens t
    JOIN   fix_track_issues fi ON fi.id  = t.issue_id
    LEFT   JOIN sites       s  ON s.id   = fi.site_id
    JOIN   clients          cl ON cl.id  = t.client_id
    WHERE  t.token = ${token}
    LIMIT  1
  `);
  return ((result.rows as any[])[0] as TokenRow) ?? null;
}

function esc(s: string) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const TYPE_LABELS: Record<string, string> = {
  electrical: "Electrical", plumbing: "Plumbing", gas: "Gas",
  structural: "Structural", equipment: "Equipment", hvac: "HVAC",
  it_comms: "IT / Comms", safety_hazard: "Safety Hazard",
  cleaning: "Cleaning", general: "General",
};
const PRI_LABELS: Record<string, string> = {
  urgent: "🔴 Urgent", high: "🟠 High", medium: "🟡 Medium", low: "🟢 Low",
};

function shell(title: string, body: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;
       min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px}
  .card{background:#fff;border-radius:12px;padding:28px 24px;max-width:480px;
        width:100%;margin-top:16px;box-shadow:0 2px 12px rgba(0,0,0,.07)}
  .brand{font-size:12px;color:#94a3b8;margin-bottom:20px;font-weight:700;letter-spacing:.06em}
  h1{font-size:20px;font-weight:700;color:#0f172a;margin-bottom:6px}
  .sub{font-size:14px;color:#64748b;margin-bottom:20px}
  .box{background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #3b82f6;
       border-radius:8px;padding:14px 16px;margin-bottom:20px}
  .box h2{font-size:15px;font-weight:700;color:#0f172a;margin-bottom:10px}
  .row{display:flex;gap:8px;margin-bottom:4px;font-size:13px}
  .lbl{color:#64748b;width:76px;flex-shrink:0}
  .val{color:#0f172a;font-weight:500}
  .desc{margin-top:8px;font-size:13px;color:#475569}
  label{display:block;font-size:13px;font-weight:600;color:#374151;margin:14px 0 5px}
  textarea{width:100%;border:1px solid #d1d5db;border-radius:8px;padding:10px 12px;
           font-size:14px;resize:vertical;min-height:80px;outline:none;font-family:inherit}
  textarea:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.2)}
  .file-label{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
              border:1.5px dashed #cbd5e1;border-radius:8px;cursor:pointer;
              font-size:13px;color:#475569;margin-top:6px;transition:border-color .15s,color .15s}
  .file-label:hover{border-color:#3b82f6;color:#2563eb}
  .fname{font-size:12px;color:#3b82f6;margin-top:6px;word-break:break-all}
  .btn{display:block;width:100%;background:#10b981;color:#fff;border:none;border-radius:8px;
       padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-top:20px;transition:background .15s}
  .btn:hover{background:#059669}
  .btn:disabled{background:#9ca3af;cursor:not-allowed}
  .msg{text-align:center;padding:10px 14px;border-radius:8px;margin-top:12px;font-size:13px}
  .err{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
  .inf{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}
  .big{font-size:48px;text-align:center;margin-bottom:14px}
  .stitle{font-size:22px;font-weight:700;color:#0f172a;text-align:center;margin-bottom:8px}
  .ssub{font-size:14px;color:#64748b;text-align:center}
</style>
</head>
<body><div class="card"><div class="brand">COMPLYTRACK</div>${body}</div></body>
</html>`;
}

function issueBlock(t: TokenRow) {
  return `<div class="box">
  <h2>${esc(t.issue_title)}</h2>
  <div class="row"><span class="lbl">Type</span>    <span class="val">${esc(TYPE_LABELS[t.issue_type] ?? t.issue_type)}</span></div>
  <div class="row"><span class="lbl">Priority</span><span class="val">${PRI_LABELS[t.issue_priority] ?? esc(t.issue_priority)}</span></div>
  <div class="row"><span class="lbl">Location</span><span class="val">${esc(t.issue_location)}</span></div>
  ${t.site_name ? `<div class="row"><span class="lbl">Site</span><span class="val">${esc(t.site_name)}</span></div>` : ""}
  ${t.issue_description ? `<p class="desc">${esc(t.issue_description)}</p>` : ""}
</div>`;
}

// ── GET /:token  — entry point for both action types ─────────────────────────

router.get("/:token", async (req, res) => {
  let t: TokenRow | null = null;
  try { t = await lookupToken(req.params.token); } catch { /* db error */ }

  if (!t) {
    return res.status(404).send(shell("Link Not Found",
      `<div class="big">🔗</div><div class="stitle">Link not found</div>
       <div class="ssub">This link is invalid or has expired. Ask the manager to resend.</div>`
    ));
  }

  if (t.used_at) {
    return res.send(shell("Already Actioned",
      `<div class="big">✅</div><div class="stitle">Already recorded</div>
       <div class="ssub">You already updated this job — no further action needed.</div>
       ${issueBlock(t)}`
    ));
  }

  if (new Date(t.expires_at) < new Date()) {
    return res.status(410).send(shell("Link Expired",
      `<div class="big">⏰</div><div class="stitle">This link has expired</div>
       <div class="ssub">Job links are valid for 30 days. Ask the manager to send a new one.</div>`
    ));
  }

  // ── Booked: act immediately ───────────────────────────────────────────────

  if (t.action === "booked") {
    await db.execute(sql`UPDATE fix_track_action_tokens SET used_at = now() WHERE id = ${t.id}`);
    await db.execute(sql`
      UPDATE fix_track_issues SET status = 'in_progress', updated_at = now() WHERE id = ${t.issue_id}
    `);
    return res.send(shell("Job Booked",
      `<div class="big">📅</div>
       <div class="stitle">Job marked as Booked</div>
       <div class="ssub" style="margin-bottom:20px">${esc(t.company_name)} has been notified that you've confirmed the booking.</div>
       ${issueBlock(t)}`
    ));
  }

  // ── Completed: show form ──────────────────────────────────────────────────

  if (t.action === "completed") {
    const tok = esc(req.params.token);
    const company = esc(t.company_name);
    return res.send(shell("Mark Job Completed", `
<h1>Mark Job Completed</h1>
<p class="sub">Confirm the job is done. You can optionally add notes or upload a completion document.</p>
${issueBlock(t)}
<div id="frm">
  <label for="notes">Completion notes <span style="font-weight:400;color:#94a3b8">(optional)</span></label>
  <textarea id="notes" placeholder="e.g. Replaced faulty valve, tested and confirmed working…"></textarea>
  <label>Completion document <span style="font-weight:400;color:#94a3b8">(optional)</span></label>
  <label class="file-label" for="fi">📎 Choose file (PDF, photo, or document)</label>
  <input type="file" id="fi" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.heic" style="display:none">
  <div id="fn" class="fname"></div>
  <button class="btn" id="btn" type="button">✓ Confirm Completed</button>
</div>
<div id="msg"></div>
<script>
const fi=document.getElementById('fi'),fn=document.getElementById('fn'),
      btn=document.getElementById('btn'),msg=document.getElementById('msg');
let file=null;
fi.addEventListener('change',()=>{file=fi.files[0]||null;fn.textContent=file?file.name:'';});
btn.addEventListener('click',async()=>{
  btn.disabled=true;btn.textContent='Saving…';
  msg.className='msg inf';msg.textContent='Submitting…';
  let path=null;
  try{
    if(file){
      msg.textContent='Uploading document…';
      const r1=await fetch('/api/fix-track/action/${tok}/upload-url',{method:'POST'});
      if(!r1.ok)throw new Error('Could not get upload URL');
      const {uploadUrl,objectPath}=await r1.json();
      const r2=await fetch(uploadUrl,{method:'PUT',body:file,headers:{'Content-Type':file.type}});
      if(!r2.ok)throw new Error('Upload failed');
      path=objectPath;
    }
    msg.textContent='Confirming…';
    const r3=await fetch('/api/fix-track/action/${tok}',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({notes:document.getElementById('notes').value.trim()||null,completionObjectPath:path})
    });
    if(!r3.ok)throw new Error(await r3.text());
    document.getElementById('frm').style.display='none';
    msg.style.display='none';
    document.querySelector('.card').insertAdjacentHTML('beforeend',
      '<div class="big" style="margin-top:16px">✅</div>'+
      '<div class="stitle">Job marked as Completed</div>'+
      '<div class="ssub">${company} has been notified. Thank you!</div>'
    );
  }catch(e){
    msg.className='msg err';msg.textContent='Error: '+(e.message||'Please try again');
    btn.disabled=false;btn.textContent='✓ Confirm Completed';
  }
});
</script>`
    ));
  }

  res.status(400).send(shell("Error", `<p>Unknown action type.</p>`));
});

// ── POST /:token — handle completed form submission ───────────────────────────

router.post("/:token", async (req, res) => {
  let t: TokenRow | null = null;
  try { t = await lookupToken(req.params.token); } catch { /* db error */ }

  if (!t || t.action !== "completed")  return res.status(400).send("Invalid token");
  if (t.used_at)                        return res.status(409).send("Already actioned");
  if (new Date(t.expires_at) < new Date()) return res.status(410).send("Link expired");

  const notes                = typeof req.body?.notes === "string"                ? req.body.notes.slice(0, 5000) : null;
  const completionObjectPath = typeof req.body?.completionObjectPath === "string" ? req.body.completionObjectPath : null;
  const today                = new Date().toISOString().slice(0, 10);

  await db.execute(sql`
    UPDATE fix_track_action_tokens
    SET    used_at = now(), completion_notes = ${notes}, completion_object_path = ${completionObjectPath}
    WHERE  id = ${t.id}
  `);
  await db.execute(sql`
    UPDATE fix_track_issues
    SET    status        = 'resolved',
           resolved_date = ${today},
           solution_notes = COALESCE(${notes}, solution_notes),
           updated_at    = now()
    WHERE  id = ${t.issue_id}
  `);

  res.status(200).send("ok");
});

// ── POST /:token/upload-url — presigned URL for completion document ────────────

router.post("/:token/upload-url", async (req, res) => {
  let t: TokenRow | null = null;
  try { t = await lookupToken(req.params.token); } catch { /* db error */ }

  if (!t || t.action !== "completed" || t.used_at) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }
  if (new Date(t.expires_at) < new Date()) return res.status(410).json({ error: "Link expired" });

  try {
    const uploadUrl  = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
    await storage.trySetObjectEntityAclPolicy(uploadUrl, { owner: String(t.client_id), visibility: "private" });
    res.json({ uploadUrl, objectPath });
  } catch (err: any) {
    res.status(500).json({ error: "Could not generate upload URL" });
  }
});

export default router;
