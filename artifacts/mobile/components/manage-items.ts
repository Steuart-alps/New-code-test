/**
 * Entries of the Manage hub (app/manage/index.tsx): what managers check or act
 * on away from a desk, and records anyone may look up on site. Each entry opens
 * its own screen under app/manage/. Import-free so tests can load it with Node.
 */
export type ManageAudience = 'everyone' | 'managers';

export interface ManageItem {
  id: string;
  label: string;
  subtitle: string;
  /** Feather icon name. */
  icon: string;
  iconColor: string;
  route: string;
  audience: ManageAudience;
  /** Service key the account must have (hasService); omitted = always. */
  service?: string;
}

export const MANAGE_ITEMS: ManageItem[] = [
];

/** Client admins and consultants manage the business; staff and viewers don't. */
export function isManagerRole(role: string | null | undefined): boolean {
  return role === 'client_admin' || role === 'consultant';
}

export function visibleManageItems(
  items: readonly ManageItem[],
  role: string | null | undefined,
  hasService: (key: string) => boolean,
): ManageItem[] {
  return items.filter((item) =>
    (item.audience === 'everyone' || isManagerRole(role)) && (!item.service || hasService(item.service)));
}
