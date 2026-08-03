import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Tags, 
  ShieldCheck,
  Bell,
  Briefcase,
  Building,
  Building2,
  Settings,
  Users,
  LogOut,
  ChevronDown,
  ArrowLeftRight,
  Flame,
  UtensilsCrossed,
  Droplets,
  Waves,
  TreePine,
  Lock,
  GraduationCap,
  ClipboardList,
  Sunrise,
  Sunset,
  LayoutGrid,
  Wrench,
  FolderOpen,
  BookOpen,
  Bike,
  Waves as WavesIcon,
  Tractor,
  Anchor,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuth, useIsConsultant, useCanAdmin } from "@/context/auth-context";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import alpsLogo from "@/assets/alps-logo.png";

function useNavGroups() {
  const isConsultant = useIsConsultant();
  const canAdmin = useCanAdmin();

  const groups: { title: string; items: { href: string; label: string; icon: any; serviceKey?: string }[] }[] = [
    {
      title: "COMPLYTRACK",
      items: [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { href: "/external", label: "Compliance Checks", icon: Briefcase },
        { href: "/contractors", label: "Contractors", icon: Building },
        { href: "/categories", label: "Categories", icon: Tags },
      ],
    },
    {
      title: "MODULES",
      items: [
        { href: "/fire-safety",    label: "FireTrack",       icon: Flame,           serviceKey: "firetrack" },
        { href: "/kitchen",        label: "KitchenTrack",    icon: UtensilsCrossed, serviceKey: "kitchentrack" },
        { href: "/legionella",     label: "LegionellaTrack", icon: Droplets,        serviceKey: "legionellatrack" },
        { href: "/safe-track",     label: "SafeTrack",       icon: GraduationCap,   serviceKey: "safetrack" },
        { href: "/fix-track",      label: "FixTrack",        icon: Wrench,          serviceKey: "fixtrack" },
        { href: "/doc-track",      label: "DocTrack",        icon: FolderOpen,      serviceKey: "doctrack" },
        { href: "/train-track",    label: "TrainTrack",      icon: BookOpen,        serviceKey: "traintrack" },
        { href: "/hot-tub",        label: "TubTrack",         icon: Waves,           serviceKey: "hottubtrack" },
        { href: "/tree-track",     label: "TreeTrack",       icon: TreePine,        serviceKey: "treetrack" },
        { href: "/bike-track",     label: "BikeTrack",       icon: Bike,            serviceKey: "biketrack" },
        { href: "/pool-track",     label: "PoolTrack",       icon: WavesIcon,       serviceKey: "pooltrack" },
        { href: "/green-track",    label: "GreenTrack",      icon: Tractor,         serviceKey: "greentrack" },
        { href: "/swim-track",     label: "SwimTrack",       icon: Anchor,          serviceKey: "swimtrack" },
        { href: "/daily-track-am", label: "DailyTrack AM",   icon: Sunrise,         serviceKey: "dailytrack_am" },
        { href: "/daily-track-pm", label: "DailyTrack PM",   icon: Sunset,          serviceKey: "dailytrack_pm" },
      ],
    },
  ];

  const systemItems: { href: string; label: string; icon: any; serviceKey?: string }[] = [];
  if (canAdmin) {
    systemItems.push({ href: "/sites", label: "Sites", icon: Building2 });
    systemItems.push({ href: "/users", label: "Users", icon: Users });
    systemItems.push({ href: "/staff-roster", label: "Staff Roster", icon: ClipboardList });
  }
  if (isConsultant) {
    systemItems.push({ href: "/clients", label: "Clients", icon: Building2 });
  }
  if (canAdmin) {
    systemItems.push({ href: "/settings", label: "Settings", icon: Settings });
  }

  if (systemItems.length > 0) {
    groups.push({ title: "SYSTEM", items: systemItems });
  }

  return groups;
}

export function AppLayout({ children, title }: { children: ReactNode; title: string }) {
  const [location] = useLocation();
  const { user, client, logout, activeClientId, hasService } = useAuth();
  const isConsultant = useIsConsultant();
  const navGroups = useNavGroups();

  const primaryColor = client?.primaryColor ?? "#7FA8C9";

  const initials = user?.name
    ? user.name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)
    : "??";

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row font-sans">
      {/* Sidebar - Desktop */}
      <aside className="hidden md:flex flex-col w-64 bg-sidebar text-sidebar-foreground border-r border-sidebar-border z-20 relative">
        <div className="min-h-[80px] flex items-center px-6 py-4 border-b border-sidebar-border">
          <Link href="/dashboard" className="flex items-center gap-3 hover:opacity-80 transition-opacity w-full min-w-0">
            {client?.logoUrl ? (
              <img src={client.logoUrl} alt={client.name} className="w-8 h-8 object-contain rounded-sm flex-shrink-0" />
            ) : (
              <ShieldCheck className="w-6 h-6 flex-shrink-0" style={{ color: primaryColor }} />
            )}
            <span className="font-display font-medium text-lg tracking-wide break-words min-w-0 flex-1">
              {client ? client.name : "ComplyTrack"}
            </span>
          </Link>
        </div>
        
        <nav className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
          {navGroups.map((group) => (
            <div key={group.title} className="space-y-2">
              {group.title && (
                <div className="text-xs font-medium text-sidebar-foreground/40 uppercase tracking-widest px-3">
                  {group.title}
                </div>
              )}
              <div className="space-y-1">
                {group.items.map((item) => {
                  const isActive = location === item.href || (item.href !== "/dashboard" && location.startsWith(item.href));
                  const isLocked = item.serviceKey ? !hasService(item.serviceKey) : false;
                  return (
                    <Link key={item.href} href={item.href} className="block">
                      <div className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-sm font-medium transition-all duration-200 group relative",
                        isActive 
                          ? "text-sidebar-foreground" 
                          : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent",
                        isLocked && "opacity-70"
                      )}
                      >
                        {isActive && (
                          <motion.div 
                            layoutId="sidebar-active" 
                            className="absolute inset-0 rounded-sm z-0"
                            style={{ backgroundColor: `${primaryColor}20`, borderLeft: `3px solid ${primaryColor}` }}
                            transition={{ type: "spring", stiffness: 300, damping: 30 }}
                          />
                        )}
                        <item.icon className={cn("w-4 h-4 z-10 relative", isActive ? "text-sidebar-foreground" : "text-sidebar-foreground/40 group-hover:text-sidebar-foreground/70")} style={isActive ? { color: primaryColor } : {}} />
                        <span className="z-10 relative text-sm tracking-wide flex-1">{item.label}</span>
                        {isLocked && (
                          <Lock className="w-3.5 h-3.5 z-10 relative text-sidebar-foreground/40" />
                        )}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-sidebar-border bg-sidebar/50 flex flex-col gap-4">
          <div className="flex items-center justify-center gap-2 opacity-40">
            <span className="text-xs font-display italic">by</span>
            <img src={alpsLogo} alt="Alps Consultancy" className="h-4 grayscale invert" />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-3 px-3 py-2 rounded-sm hover:bg-sidebar-accent cursor-pointer transition-colors w-full text-left">
                <Avatar className="w-8 h-8 rounded-none border border-sidebar-border">
                  <AvatarFallback className="rounded-none bg-sidebar-accent text-sidebar-foreground text-xs">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="text-sm font-medium truncate">{user?.name ?? "Unknown"}</span>
                  <span className="text-xs text-sidebar-foreground/50 truncate font-light">{user?.email ?? ""}</span>
                </div>
                <ChevronDown className="w-4 h-4 text-sidebar-foreground/40 flex-shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52 rounded-none border-border">
              {isConsultant && activeClientId && (
                <>
                  <DropdownMenuItem asChild className="rounded-none cursor-pointer">
                    <Link href="/clients">
                      <ArrowLeftRight className="w-4 h-4 mr-2" />
                      Switch Client
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={logout} className="rounded-none cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10">
                <LogOut className="w-4 h-4 mr-2" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative bg-white">
        <div className="absolute inset-0 w-full h-full bg-[#F7F2E4]/30 pointer-events-none -z-10" />

        {/* Top Header */}
        <header className="h-[80px] bg-white/80 backdrop-blur-md border-b border-border flex items-center justify-between px-6 lg:px-8 z-10 sticky top-0">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-display font-medium text-[#162D42]">
              {title}
            </h1>
          </div>
          
          <div className="flex items-center gap-4">
            {isConsultant && (
              <div className="hidden sm:flex items-center gap-2 text-xs text-[#162D42] bg-[#F7F2E4] border border-border px-3 py-1.5 rounded-sm">
                <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                <span className="font-medium uppercase tracking-wider">Owner</span>
              </div>
            )}
            <button className="relative p-2 rounded-sm hover:bg-muted border border-transparent hover:border-border transition-all text-[#162D42]">
              <Bell className="w-5 h-5" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full border-2 border-white"></span>
            </button>
            <div className="md:hidden">
              <Avatar className="w-8 h-8 rounded-none">
                <AvatarFallback className="rounded-none bg-[#F7F2E4] text-[#162D42] text-xs font-medium">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </div>
            <button
              onClick={logout}
              className="flex items-center gap-2 px-4 py-2 rounded-[2px] text-sm font-medium text-destructive bg-destructive/5 hover:bg-destructive/10 transition-colors"
              data-testid="button-sign-out"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>

        {/* Mobile Nav */}
        <nav className="md:hidden flex overflow-x-auto border-b border-border bg-white px-4 py-3 scrollbar-hide">
          {navGroups.flatMap(g => g.items).map((item) => {
            const isActive = location === item.href;
            const isLocked = item.serviceKey ? !hasService(item.serviceKey) : false;
            return (
              <Link key={item.href} href={item.href} className="flex-shrink-0 mr-2">
                <div className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-sm text-sm font-medium transition-colors border",
                  isActive ? "text-primary border-primary bg-primary/5" : "bg-white text-muted-foreground border-border hover:bg-muted"
                )}
                >
                  <item.icon className="w-4 h-4" />
                  {item.label}
                  {isLocked && <Lock className="w-3 h-3 opacity-60 ml-1" />}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Page Content */}
        <div className="flex-1 overflow-auto p-6 lg:p-8">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className="max-w-7xl mx-auto space-y-8"
          >
            {children}
          </motion.div>
        </div>
      </main>
    </div>
  );
}

