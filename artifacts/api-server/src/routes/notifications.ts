import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { complianceItemsTable, contractorsTable, appSettingsTable } from "@workspace/db/schema";
import { eq, isNotNull, isNull, ne } from "drizzle-orm";
import { sendEmail, buildReminderEmail, getEmailSettings } from "../lib/email";
import { TestEmailBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/notifications/send-reminders", async (req, res) => {
  const settings = await getEmailSettings();
  const defaultLeadTimeDays = parseInt(settings["defaultLeadTimeDays"] ?? "7", 10);
  const companyName = settings["companyName"] ?? "Compliance Tracker";

  const now = new Date();

  // Get all external compliance items that:
  // - have a due date
  // - have a contractor with email
  // - are not completed
  // - notification not yet sent OR the lead time window is now
  const items = await db
    .select({
      item: complianceItemsTable,
      contractor: contractorsTable,
    })
    .from(complianceItemsTable)
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(eq(complianceItemsTable.type, "external"));

  const results: Array<{
    itemId: number;
    title: string;
    contractorEmail: string;
    status: "sent" | "skipped" | "error";
    reason?: string | null;
  }> = [];

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const { item, contractor } of items) {
    if (!contractor?.email) {
      results.push({ itemId: item.id, title: item.title, contractorEmail: "", status: "skipped", reason: "No contractor email" });
      skipped++;
      continue;
    }

    if (!item.dueDate) {
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "skipped", reason: "No due date" });
      skipped++;
      continue;
    }

    if (item.status === "completed") {
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "skipped", reason: "Item completed" });
      skipped++;
      continue;
    }

    const leadTimeDays = item.leadTimeDays ?? defaultLeadTimeDays;
    const dueDate = new Date(item.dueDate);
    const notifyDate = new Date(dueDate.getTime() - leadTimeDays * 24 * 60 * 60 * 1000);

    if (now < notifyDate) {
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "skipped", reason: `Not yet in notification window (notify from ${notifyDate.toLocaleDateString()})` });
      skipped++;
      continue;
    }

    if (item.notificationSentAt) {
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "skipped", reason: `Already notified on ${new Date(item.notificationSentAt).toLocaleDateString()}` });
      skipped++;
      continue;
    }

    try {
      const { html, text } = buildReminderEmail({
        contractorName: contractor.name,
        companyName,
        itemTitle: item.title,
        dueDate,
        leadTimeDays,
        notes: item.notes,
      });

      await sendEmail({
        to: contractor.email,
        subject: `Compliance Check Reminder: ${item.title}`,
        html,
        text,
      });

      await db
        .update(complianceItemsTable)
        .set({ notificationSentAt: now })
        .where(eq(complianceItemsTable.id, item.id));

      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "sent" });
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "error", reason: message });
      errors++;
    }
  }

  res.json({ sent, skipped, errors, details: results });
});

router.post("/notifications/test-email", async (req, res) => {
  const { to } = TestEmailBody.parse(req.body);

  try {
    await sendEmail({
      to,
      subject: "Compliance Tracker — Test Email",
      html: `<p>This is a test email from your Compliance Tracker. Your email settings are configured correctly!</p>`,
      text: "This is a test email from your Compliance Tracker. Your email settings are configured correctly!",
    });
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send test email";
    res.json({ success: false, message });
  }
});

export default router;
