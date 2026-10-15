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
  {
    id: 'tasks',
    label: 'Tasks',
    subtitle: 'Set, assign and review routine jobs for your team',
    icon: 'check-square',
    iconColor: '#2563eb',
    route: '/manage/tasks',
    audience: 'managers',
  },
  // Site registers: read only on the phone (GET /api/registers/* is open to
  // every role; allergen records are part of KitchenTrack, as on the website).
  {
    id: 'allergens',
    label: 'Allergen records',
    subtitle: 'The 14 allergens in each dish or product',
    icon: 'coffee',
    iconColor: '#b45309',
    route: '/manage/allergens',
    audience: 'everyone',
    service: 'kitchentrack',
  },
  {
    id: 'coshh',
    label: 'COSHH register',
    subtitle: 'Hazardous substances, controls, PPE and data sheets',
    icon: 'droplet',
    iconColor: '#c2410c',
    route: '/manage/coshh',
    audience: 'everyone',
  },
  {
    id: 'asbestos',
    label: 'Asbestos register',
    subtitle: 'Where asbestos is, its condition and the survey',
    icon: 'shield',
    iconColor: '#475569',
    route: '/manage/asbestos',
    audience: 'everyone',
  },
  // The website shows Contractors and Calendar to every role, and their read
  // APIs only require sign-in; contractor email approvals inside are managers only.
  {
    id: 'contractors', label: 'Contractors', subtitle: 'Certificates expiring or overdue, contacts and approvals',
    icon: 'briefcase', iconColor: '#7c3aed', route: '/manage/contractors', audience: 'everyone',
  },
  {
    id: 'calendar', label: 'Calendar', subtitle: 'What is due: overdue, today, this week and later',
    icon: 'calendar', iconColor: '#2563eb', route: '/manage/calendar', audience: 'everyone',
  },
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
