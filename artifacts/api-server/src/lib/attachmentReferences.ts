import { sql } from "drizzle-orm";

/**
 * Every database location that can retain a private object reference. Keep this
 * registry aligned with the attachment sources in routes/export.ts. The two
 * specialised sources below cover the linked certificates table and FixTrack's
 * JSON media array.
 */
export const TENANT_ATTACHMENT_REFERENCE_SOURCES = [
  "doc_track_documents.object_path",
  "safe_risk_assessments.object_path",
  "safe_sops.object_path",
  "safe_handbook.object_path",
  "site_documents.object_path",
  "client_documents.object_path",
  "contractor_certificates.object_path",
  "certificates.file_url",
  "check_photos.object_path",
  "fix_track_issues.media_urls",
  "fix_track_issues.completion_document_path",
  "fix_track_action_tokens.completion_object_path",
] as const;

type SqlExecutor = {
  execute(query: unknown): Promise<{ rows?: unknown[] }>;
};

/**
 * Check all attachment stores for a reference owned by the same tenant.
 *
 * Call this after removing the reference being deleted, in the same database
 * transaction. Object ACL ownership is tenant-scoped too, so a malformed
 * cross-tenant row must not let one tenant control another tenant's lifecycle.
 */
export async function hasTenantAttachmentReference(
  executor: SqlExecutor,
  tenantId: number,
  objectPath: string,
): Promise<boolean> {
  const result = await executor.execute(sql`
    SELECT (
      EXISTS (SELECT 1 FROM doc_track_documents WHERE client_id = ${tenantId} AND object_path = ${objectPath})
      OR EXISTS (SELECT 1 FROM safe_risk_assessments WHERE client_id = ${tenantId} AND object_path = ${objectPath})
      OR EXISTS (SELECT 1 FROM safe_sops WHERE client_id = ${tenantId} AND object_path = ${objectPath})
      OR EXISTS (SELECT 1 FROM safe_handbook WHERE client_id = ${tenantId} AND object_path = ${objectPath})
      OR EXISTS (SELECT 1 FROM site_documents WHERE client_id = ${tenantId} AND object_path = ${objectPath})
      OR EXISTS (SELECT 1 FROM client_documents WHERE client_id = ${tenantId} AND object_path = ${objectPath})
      OR EXISTS (SELECT 1 FROM contractor_certificates WHERE client_id = ${tenantId} AND object_path = ${objectPath})
      OR EXISTS (
        SELECT 1
        FROM certificates cert
        JOIN contractors contractor ON contractor.id = cert.contractor_id
        WHERE contractor.client_id = ${tenantId} AND cert.file_url = ${objectPath}
      )
      OR EXISTS (SELECT 1 FROM check_photos WHERE client_id = ${tenantId} AND object_path = ${objectPath})
      OR EXISTS (
        SELECT 1
        FROM fix_track_issues issue
        CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(issue.media_urls, '[]'::jsonb)) media(object_path)
        WHERE issue.client_id = ${tenantId} AND media.object_path = ${objectPath}
      )
      OR EXISTS (
        SELECT 1 FROM fix_track_issues
        WHERE client_id = ${tenantId} AND completion_document_path = ${objectPath}
      )
      OR EXISTS (
        SELECT 1 FROM fix_track_action_tokens
        WHERE client_id = ${tenantId} AND completion_object_path = ${objectPath}
      )
    ) AS referenced
  `);
  return Boolean((result.rows?.[0] as { referenced?: boolean } | undefined)?.referenced);
}