import { 
  LayoutDashboard, 
  Tags, 
  ShieldCheck,
  Briefcase,
  Building,
  Building2,
  Settings,
  Users,
  AlertOctagon,
  Flame,
  UtensilsCrossed,
  Droplets,
  Waves,
  TreePine,
  ClipboardList,
  Sunrise,
  Sunset,
  Wrench,
  FolderOpen,
  BookOpen,
  Bike,
  Anchor,
  Zap,
  Bug,
  BarChart2,
  FileCheck2,
  BedDouble,
  Tractor,
  Inbox,
  Wheat,
  Beaker,
  ShieldAlert,
  LayoutGrid,
  CalendarDays,
  QrCode,
  FileSearch,
  BarChart3,
  FileUp,
} from "lucide-react";

export interface NavItem { href: string; label: string; icon: any; serviceKey?: string; serviceKeys?: string[]; comingSoon?: boolean }
export interface NavGroup { id: string; title: string; defaultOpen: boolean; items: NavItem[] }

export function isNavItemActive(item: NavItem, location: string): boolean {
  return location === item.href || location.startsWith(`${item.href}/`);
}

export function isNavItemAvailable(item: NavItem, hasService: (key: string) => boolean): boolean {
  if (item.serviceKeys) return item.serviceKeys.some(hasService);
  return !item.serviceKey || hasService(item.serviceKey);
}

/** Each section's open/closed choice is saved per user and business. */
export function navGroupStorageKey(scope: string, groupId: string): string {
  return `complytrack:nav:${scope}:${groupId}`;
}

/**
 * Whether a section starts open: always when it holds the current page,
 * never when every link in it is locked, else the saved choice, else its
 * default.
 */
export function isNavGroupInitiallyOpen(
  group: NavGroup,
  { location, hasService, saved }: { location: string; hasService: (key: string) => boolean; saved: string | null },
): boolean {
  if (group.items.some(item => isNavItemActive(item, location))) return true;
  if (!group.items.some(item => isNavItemAvailable(item, hasService))) return false;
  if (saved !== null) return saved === "true";
  return group.defaultOpen;
}

/**
 * The menu follows the order a business sets up ComplyTrack (the setup
 * wizard, then Getting started): settings, sites and the team first, then
 * the compliance checks, then the tracks where records are kept, then
 * reports. Sections a role can't use are dropped, so Staff and Viewers start
 * at Compliance.
 */
export function getNavGroups({ isConsultant, canAdmin, canManageUsers = canAdmin, isPlatformOperator = false }: { isConsultant: boolean; canAdmin: boolean; canManageUsers?: boolean; isPlatformOperator?: boolean }): NavGroup[] {
  const groups: NavGroup[] = [
    {
      id: "core",
      title: "Home",
      defaultOpen: true,
      items: [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      ],
    },
    {
      id: "setup",
      title: "Set up",
      defaultOpen: true,
      items: [],
    },
    {
      id: "compliance",
      title: "Compliance",
      defaultOpen: true,
      items: [
        { href: "/external", label: "Compliance Checks", icon: Briefcase },
        { href: "/contractors", label: "Contractors", icon: Building },
        { href: "/calendar", label: "Calendar", icon: CalendarDays },
        { href: "/compliance-hub", label: "Compliance Hub", icon: FileCheck2 },
      ],
    },
    {
      id: "safety",
      title: "Safety",
      defaultOpen: false,
      items: [
        { href: "/fire-safety",    label: "FireTrack",       icon: Flame,           serviceKey: "firetrack" },
        { href: "/legionella",     label: "LegionellaTrack", icon: Droplets,        serviceKey: "legionellatrack" },
        { href: "/safe-track",     label: "SafeTrack",       icon: ShieldCheck,     serviceKey: "safetrack" },
        { href: "/incidents",      label: "IncidentTrack",   icon: AlertOctagon,    serviceKey: "incidenttrack" },
        { href: "/coshh-track",    label: "COSHHTrack",      icon: Beaker,          serviceKey: "coshhtrack" },
        { href: "/asbestos",       label: "Asbestos Register", icon: ShieldAlert },
      ],
    },
    {
      id: "food-water",
      title: "Food & Water",
      defaultOpen: false,
      items: [
        { href: "/kitchen",        label: "KitchenTrack",    icon: UtensilsCrossed, serviceKey: "kitchentrack" },
        { href: "/allergens",      label: "Allergens",       icon: Wheat,           serviceKey: "kitchentrack" },
        { href: "/aqua-track",     label: "AquaTrack",       icon: Anchor,          serviceKey: "aquatrack" },
        { href: "/hot-tub",        label: "TubTrack",         icon: Waves,           serviceKey: "hottubtrack" },
      ],
    },
    {
      id: "operations",
      title: "Operations",
      defaultOpen: false,
      items: [
        { href: "/fix-track",      label: "FixTrack",        icon: Wrench,          serviceKey: "fixtrack" },
        { href: "/premises-track", label: "PremisesTrack",   icon: Building2,       serviceKey: "premisestrack" },
        { href: "/room-track",     label: "RoomTrack",       icon: BedDouble,       serviceKey: "roomtrack" },
        { href: "/tree-track",     label: "TreeTrack",       icon: TreePine,        serviceKey: "treetrack" },
        { href: "/bike-track",     label: "BikeTrack",       icon: Bike,            serviceKey: "biketrack" },
        { href: "/green-track",    label: "GreenTrack",      icon: Tractor,         serviceKey: "greentrack" },
        { href: "/pat-track",      label: "PATtrack",        icon: Zap,             serviceKey: "pattrack" },
        { href: "/pest-track",     label: "PestTrack",       icon: Bug,             serviceKey: "pesttrack" },
        { href: "/daily-track-am", label: "DailyTrack AM",   icon: Sunrise,         serviceKeys: ["dailytrack_am", "kitchentrack", "premisestrack"] },
        { href: "/daily-track-pm", label: "DailyTrack PM",   icon: Sunset,          serviceKeys: ["dailytrack_pm", "kitchentrack", "premisestrack"] },
      ],
    },
    {
      id: "people-training",
      title: "People & Training",
      defaultOpen: false,
      items: [
        { href: "/doc-track",      label: "DocTrack",        icon: FolderOpen,      serviceKey: "doctrack" },
        { href: "/train-track",    label: "TrainTrack",      icon: BookOpen,        serviceKey: "traintrack" },
      ],
    },
    {
      id: "reporting",
      title: "Reporting",
      defaultOpen: false,
      items: [
        { href: "/reports", label: "Reports", icon: BarChart2 },
      ],
    },
    {
      // Jobs that don't belong to any track; most work lives in the tracks.
      id: "other",
      title: "Other",
      defaultOpen: false,
      items: [
        { href: "/tasks", label: "Other reminders", icon: ClipboardList },
      ],
    },
    {
      id: "admin",
      title: "Administration",
      defaultOpen: false,
      items: []
    }
  ];
  const group = (id: string) => groups.find(g => g.id === id)!;

  if (isConsultant) {
    group("core").items.push({ href: "/portfolio", label: "Portfolio", icon: LayoutGrid });
  }

  // Set up, in wizard order: business details, departments and modules
  // (Settings), sites, then the team. The /settings, /sites, /staff-roster
  // and /categories routes are only registered for admins.
  const setup = group("setup").items;
  if (canAdmin) {
    setup.push(
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/sites", label: "Sites", icon: Building2 },
    );
  }
  if (canManageUsers) {
    // Managers look after the Staff and Viewers in their own department.
    setup.push({ href: "/users", label: "Users", icon: Users });
  }
  if (canAdmin) {
    setup.push({ href: "/staff-roster", label: "Staff Roster", icon: ClipboardList });
    // Every existing list dropped at once, each sorted into its import.
    setup.push({ href: "/upload-lists", label: "Upload your lists", icon: FileUp });
  }
  if (canManageUsers) {
    // Managers keep the equipment list and print its QR labels.
    setup.push({ href: "/equipment", label: "Equipment & QR labels", icon: QrCode });
    // Audit and inspection reports become actions (Owners, Managers, ALPS).
    group("reporting").items.push({ href: "/report-actions", label: "Report actions", icon: FileSearch });
  }

  if (canAdmin) {
    group("admin").items.push({ href: "/categories", label: "Categories", icon: Tags });
  }
  if (isConsultant) {
    group("admin").items.push({ href: "/clients", label: "Clients", icon: Building2 });
  }
  if (isPlatformOperator) {
    // ALPS's subscriptions, cancellations and module use across every business.
    group("admin").items.push({ href: "/business-dashboard", label: "Business dashboard", icon: BarChart3 });
  }
  if (canAdmin) {
    group("admin").items.push(
      { href: "/feedback", label: "Feedback inbox", icon: Inbox },
      { href: "/privacy-governance", label: "Privacy Centre", icon: ShieldCheck },
    );
  }

  return groups.filter(g => g.items.length > 0);
}

/** Pins are a small shortcut list, not a second menu. */
export const MAX_PINNED_NAV_ITEMS = 6;

/** Browser-only, per user and business: pins never reach the server. */
export function pinnedNavStorageKey(scope: string): string {
  return `complytrack:nav-pins:${scope}`;
}

/** Only links the user can open right now can be pinned. */
export function isNavItemPinnable(item: NavItem, hasService: (key: string) => boolean): boolean {
  return item.comingSoon !== true && isNavItemAvailable(item, hasService);
}

/** Reads a stored pin list, ignoring anything malformed or duplicated. */
export function parsePinnedHrefs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const hrefs = parsed.filter((href): href is string => typeof href === "string" && href.startsWith("/"));
    return [...new Set(hrefs)].slice(0, MAX_PINNED_NAV_ITEMS);
  } catch {
    return [];
  }
}

/**
 * The pinned links the user may still open, in pin order. A pin goes stale
 * when its module is no longer entitled or the user's role no longer shows
 * the link; `hrefs` is the cleaned list to store back.
 */
export function resolvePinnedNavItems(
  pinnedHrefs: string[],
  groups: NavGroup[],
  hasService: (key: string) => boolean,
): { items: NavItem[]; hrefs: string[] } {
  const byHref = new Map(groups.flatMap(g => g.items).map(item => [item.href, item]));
  const items = pinnedHrefs
    .map(href => byHref.get(href))
    .filter((item): item is NavItem => item !== undefined && isNavItemPinnable(item, hasService))
    .slice(0, MAX_PINNED_NAV_ITEMS);
  return { items, hrefs: items.map(item => item.href) };
}

/** Pins or unpins `href`; a new pin goes last and is refused once the list is full. */
export function togglePinnedHref(pinnedHrefs: string[], href: string): string[] {
  if (pinnedHrefs.includes(href)) return pinnedHrefs.filter(h => h !== href);
  if (pinnedHrefs.length >= MAX_PINNED_NAV_ITEMS) return pinnedHrefs;
  return [...pinnedHrefs, href];
}
