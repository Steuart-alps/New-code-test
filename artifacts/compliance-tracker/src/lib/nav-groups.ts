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
  Tractor
} from "lucide-react";

export interface NavItem { href: string; label: string; icon: any; serviceKey?: string; serviceKeys?: string[]; comingSoon?: boolean }
export interface NavGroup { id: string; title: string; defaultOpen: boolean; items: NavItem[] }

export function getNavGroups({ isConsultant, canAdmin }: { isConsultant: boolean; canAdmin: boolean }): NavGroup[] {
  const groups: NavGroup[] = [
    {
      id: "core",
      title: "Core Work",
      defaultOpen: true,
      items: [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { href: "/reports",   label: "Reports",   icon: BarChart2 },
        { href: "/compliance-hub", label: "Compliance Hub", icon: FileCheck2 },
        { href: "/external", label: "Compliance Checks", icon: Briefcase },
        { href: "/contractors", label: "Contractors", icon: Building },
        { href: "/categories", label: "Categories", icon: Tags },
      ],
    },
    {
      id: "modules",
      title: "Compliance Modules",
      defaultOpen: true,
      items: [
        { href: "/fire-safety",    label: "FireTrack",       icon: Flame,           serviceKey: "firetrack" },
        { href: "/kitchen",        label: "KitchenTrack",    icon: UtensilsCrossed, serviceKey: "kitchentrack" },
        { href: "/legionella",     label: "LegionellaTrack", icon: Droplets,        serviceKey: "legionellatrack" },
        { href: "/fix-track",      label: "FixTrack",        icon: Wrench,          serviceKey: "fixtrack" },
        { href: "/premises-track", label: "PremisesTrack",   icon: Building2,       serviceKey: "premisestrack" },
        { href: "/room-track",     label: "RoomTrack",       icon: BedDouble,       serviceKey: "roomtrack" },
        { href: "/safe-track",     label: "SafeTrack",       icon: ShieldCheck,     serviceKey: "safetrack" },
        { href: "/incidents",      label: "IncidentTrack",   icon: AlertOctagon,    serviceKey: "incidenttrack" },
        { href: "/hot-tub",        label: "TubTrack",         icon: Waves,           serviceKey: "hottubtrack" },
        { href: "/tree-track",     label: "TreeTrack",       icon: TreePine,        serviceKey: "treetrack" },
        { href: "/bike-track",     label: "BikeTrack",       icon: Bike,            serviceKey: "biketrack" },
        { href: "/aqua-track",     label: "AquaTrack",       icon: Anchor,          serviceKey: "aquatrack" },
        { href: "/green-track",    label: "GreenTrack",      icon: Tractor,         serviceKey: "greentrack" },
        { href: "/pat-track",      label: "PATtrack",        icon: Zap,             serviceKey: "pattrack" },
        { href: "/pest-track",     label: "PestTrack",       icon: Bug,             serviceKey: "pesttrack" },
        { href: "/daily-track-am", label: "DailyTrack AM",   icon: Sunrise,         serviceKeys: ["dailytrack_am", "kitchentrack", "premisestrack"] },
        { href: "/daily-track-pm", label: "DailyTrack PM",   icon: Sunset,          serviceKeys: ["dailytrack_pm", "kitchentrack", "premisestrack"] },
      ],
    },
    {
      id: "people",
      title: "People & Documents",
      defaultOpen: false,
      items: [
        { href: "/doc-track",      label: "DocTrack",        icon: FolderOpen,      serviceKey: "doctrack" },
        { href: "/train-track",    label: "TrainTrack",      icon: BookOpen,        serviceKey: "traintrack" },
      ]
    },
    {
      id: "admin",
      title: "Administration",
      defaultOpen: false,
      items: []
    }
  ];

  if (canAdmin) {
    const peopleGroup = groups.find(g => g.id === "people");
    if (peopleGroup) {
      peopleGroup.items.push(
        { href: "/users", label: "Users", icon: Users },
        { href: "/staff-roster", label: "Staff Roster", icon: ClipboardList }
      );
    }
    const adminGroup = groups.find(g => g.id === "admin");
    if (adminGroup) {
      adminGroup.items.push({ href: "/sites", label: "Sites", icon: Building2 });
    }
  }

  if (isConsultant) {
    groups.find(g => g.id === "admin")?.items.push({ href: "/clients", label: "Clients", icon: Building2 });
  }

  if (canAdmin) {
    groups.find(g => g.id === "admin")?.items.push(
      { href: "/privacy-governance", label: "Privacy Centre", icon: ShieldCheck },
      { href: "/settings", label: "Settings", icon: Settings }
    );
  }

  return groups.filter(g => g.items.length > 0);
}
