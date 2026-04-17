import { Router, type IRouter } from "express";
import { Resend } from "resend";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId } from "../middleware/requireAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const KEY_DOMAIN_ID = "resendDomainId";
const KEY_DOMAIN_NAME = "resendDomainName";

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured.");
  return new Resend(apiKey);
}

async function readSetting(clientId: number, key: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
  return row?.value ?? null;
}

async function writeSetting(clientId: number, key: string, value: string | null) {
  const [existing] = await db
    .select()
    .from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
  if (existing) {
    await db
      .update(appSettingsTable)
      .set({ value, updatedAt: new Date() })
      .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
  } else {
    await db
      .insert(appSettingsTable)
      .values({ clientId, key, value, updatedAt: new Date() });
  }
}

router.get("/email-domain", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const domainId = await readSetting(clientId, KEY_DOMAIN_ID);
  const domainName = await readSetting(clientId, KEY_DOMAIN_NAME);

  if (!domainId) {
    res.json({ configured: false, domainName: null, status: null, records: [] });
    return;
  }

  try {
    const resend = getResend();
    const result = await resend.domains.get(domainId);
    const data: any = result.data;
    if (!data) {
      res.json({ configured: false, domainName: null, status: null, records: [] });
      return;
    }
    res.json({
      configured: true,
      domainId,
      domainName: data.name ?? domainName,
      status: data.status ?? "pending",
      records: data.records ?? [],
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch domain from Resend");
    res.status(502).json({ error: err.message ?? "Could not reach email provider" });
  }
});

router.post("/email-domain", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const name: string = String(req.body?.name ?? "").trim().toLowerCase();
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(name)) {
    res.status(400).json({ error: "Please enter a valid domain (e.g. yourcompany.co.uk)" });
    return;
  }

  // If a domain is already registered, remove it first
  const existingId = await readSetting(clientId, KEY_DOMAIN_ID);
  if (existingId) {
    try {
      await getResend().domains.remove(existingId);
    } catch {
      // ignore — may have been removed remotely
    }
  }

  try {
    const resend = getResend();
    const result = await resend.domains.create({ name });
    const data: any = result.data;
    if (!data?.id) {
      res.status(502).json({ error: result.error?.message ?? "Failed to register domain" });
      return;
    }
    await writeSetting(clientId, KEY_DOMAIN_ID, data.id);
    await writeSetting(clientId, KEY_DOMAIN_NAME, data.name ?? name);
    res.json({
      configured: true,
      domainId: data.id,
      domainName: data.name ?? name,
      status: data.status ?? "pending",
      records: data.records ?? [],
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to create domain in Resend");
    res.status(502).json({ error: err.message ?? "Could not register domain" });
  }
});

router.post("/email-domain/verify", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const domainId = await readSetting(clientId, KEY_DOMAIN_ID);
  if (!domainId) {
    res.status(404).json({ error: "No domain configured" });
    return;
  }
  try {
    const resend = getResend();
    await resend.domains.verify(domainId);
    const result = await resend.domains.get(domainId);
    const data: any = result.data;
    res.json({
      configured: true,
      domainId,
      domainName: data?.name ?? null,
      status: data?.status ?? "pending",
      records: data?.records ?? [],
    });
  } catch (err: any) {
    logger.error({ err }, "Domain verification failed");
    res.status(502).json({ error: err.message ?? "Verification failed" });
  }
});

router.delete("/email-domain", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const domainId = await readSetting(clientId, KEY_DOMAIN_ID);
  if (domainId) {
    try {
      await getResend().domains.remove(domainId);
    } catch {
      // ignore
    }
  }
  await writeSetting(clientId, KEY_DOMAIN_ID, null);
  await writeSetting(clientId, KEY_DOMAIN_NAME, null);
  res.json({ configured: false, domainName: null, status: null, records: [] });
});

export default router;
