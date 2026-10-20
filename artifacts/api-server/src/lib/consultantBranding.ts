import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

/** Practice branding of the consultant who manages a business. */
export interface ConsultantBranding {
  consultantUserId: number;
  practiceName: string;
  /** Finalised private object path, or null when no logo is set. */
  logoObjectPath: string | null;
  logoContentType: string | null;
  updatedAt: Date;
}

/** Largest logo the branding routes accept or serve. */
export const MAX_BRANDING_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * Storage tenant that owns a consultant's logo. It is deliberately not a
 * numeric client id: the logo is shown to several businesses, so it is never
 * readable through the per-client /storage/objects route, only through the
 * branding routes after their own access check.
 */
export const brandingStorageTenant = (consultantUserId: number) => `consultant-${consultantUserId}`;

const storage = new ObjectStorageService();

/**
 * Branding to show for a business: the practice of an active consultant
 * linked to it (consultant_clients, or the consultant's own users.client_id)
 * who has set a practice name. With several branded consultants, the earliest
 * branding wins so the choice is stable. Callers must already have checked
 * that the requester may see this client.
 */
export async function getConsultantBranding(clientId: number): Promise<ConsultantBranding | null> {
  const result = await db.execute(sql`
    SELECT b.consultant_user_id, b.practice_name, b.logo_object_path, b.logo_content_type, b.updated_at
    FROM consultant_branding b
    JOIN users u ON u.id = b.consultant_user_id AND u.active = true AND u.role = 'consultant'
    WHERE NULLIF(btrim(b.practice_name), '') IS NOT NULL
      AND (u.client_id = ${clientId}
        OR EXISTS (SELECT 1 FROM consultant_clients cc WHERE cc.user_id = u.id AND cc.client_id = ${clientId}))
    ORDER BY b.created_at, b.consultant_user_id
    LIMIT 1
  `);
  const row = (result.rows ?? [])[0] as {
    consultant_user_id: number; practice_name: string; logo_object_path: string | null;
    logo_content_type: string | null; updated_at: Date | string;
  } | undefined;
  if (!row) return null;
  return {
    consultantUserId: Number(row.consultant_user_id),
    practiceName: row.practice_name.trim(),
    logoObjectPath: row.logo_object_path,
    logoContentType: row.logo_content_type,
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Logo bytes for a branding record (e.g. to embed in a PDF), or null when
 * there is no logo or storage cannot provide it. Ownership is re-checked
 * against the consultant's storage tenant before reading.
 */
export async function readConsultantBrandingLogo(
  branding: Pick<ConsultantBranding, "consultantUserId" | "logoObjectPath" | "logoContentType">,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!branding.logoObjectPath || !branding.logoContentType) return null;
  try {
    const file = await storage.getObjectEntityFile(branding.logoObjectPath);
    await storage.assertTenantObjectOwnership(file, brandingStorageTenant(branding.consultantUserId));
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BRANDING_LOGO_BYTES) return null;
    const [bytes] = await file.download({ validation: "crc32c" });
    return { bytes, contentType: branding.logoContentType };
  } catch (err) {
    logger.warn({ err, consultantUserId: branding.consultantUserId }, "Consultant branding logo unavailable");
    return null;
  }
}
