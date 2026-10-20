/**
 * Departments sit under a site; ones made before that (siteId null) span every
 * site. GET /departments includes the site's name, so the same department
 * name at two sites reads as "Housekeeping (Main Hotel)".
 */
export type DepartmentRow = { id: number; name: string; siteId?: number | null; siteName?: string | null };

export function departmentLabel(department: DepartmentRow | undefined | null): string {
  if (!department) return "";
  return department.siteName ? `${department.name} (${department.siteName})` : department.name;
}
