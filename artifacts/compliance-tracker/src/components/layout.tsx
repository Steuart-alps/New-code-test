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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuth, useIsConsultant, useCanAdmin } from "@/context/auth-context";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

function useNavGroups() {
  const isConsultant = useIsConsultant();
  const canAdmin = useCanAdmin();

  const items: { href: string; label: string; icon: any }[] = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/external", label: "Compliance Checks", icon: Briefcase },
    { href: "/contractors", label: "Contractors", icon: Building },
  ];
  if (canAdmin) {
    items.push({ href: "/categories", label: "Categories", icon: Building2 });
    items.push({ href: "/users", label: "Users", icon: Users });
  }
  if (isConsultant) {
    items.push({ href: "/clients", label: "Clients", icon: Building2 });
  }
  if (canAdmin) {
    items.push({ href: "/settings", label: "Settings", icon: Settings });
  }

  return [{ title: "", items }];
}

export function AppLayout({ children, title }: { children: ReactNode; title: string }) {
  const [location] = useLocation();
  const { user, client, logout, activeClientId } = useAuth();
  const isConsultant = useIsConsultant();
  const navGroups = useNavGroups();

  const primaryColor = client?.primaryColor ?? "#6366f1";

  const initials = user?.name
    ? user.name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)
    : "??";

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row font-sans">
      {/* Sidebar - Desktop */}
      <aside className="hidden md:flex flex-col w-64 bg-sidebar text-sidebar-foreground border-r border-sidebar-border shadow-xl z-20">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border bg-sidebar/50 backdrop-blur-sm">
          <Link href="/dashboard" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            {client?.logoUrl ? (
              <img src={client.logoUrl} alt={client.name} className="w-8 h-8 object-contain rounded-lg" />
            ) : (
              <div className="p-2 rounded-xl border" style={{ backgroundColor: `${primaryColor}25`, borderColor: `${primaryColor}40` }}>
                <ShieldCheck className="w-5 h-5" style={{ color: primaryColor }} />
              </div>
            )}
            <span className="font-display font-bold text-lg tracking-tight truncate">
              {client ? client.name : <><span>ALPS</span><span style={{ color: primaryColor }}> Compliance</span></>}
            </span>
          </Link>
        </div>
        
        <nav className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
          {navGroups.map((group) => (
            <div key={group.title} className="space-y-2">
              {group.title && (
                <div className="text-xs font-bold text-sidebar-foreground/50 uppercase tracking-wider px-2">
                  {group.title}
                </div>
              )}
              <div className="space-y-1">
                {group.items.map((item) => {
                  const isActive = location === item.href || (item.href !== "/dashboard" && location.startsWith(item.href));
                  return (
                    <Link key={item.href} href={item.href} className="block">
                      <div className={cn(
                        "flex items-center gap-3 px-3 py-2 rounded-xl font-medium transition-all duration-200 group relative",
                        isActive 
                          ? "text-white shadow-md" 
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      )}
                        style={isActive ? { backgroundColor: primaryColor } : {}}
                      >
                        {isActive && (
                          <motion.div 
                            layoutId="sidebar-active" 
                            className="absolute inset-0 rounded-xl z-0"
                            style={{ backgroundColor: primaryColor }}
                            transition={{ type: "spring", stiffness: 300, damping: 30 }}
                          />
                        )}
                        <item.icon className={cn("w-4 h-4 z-10 relative", isActive ? "text-white" : "text-sidebar-foreground/50 group-hover:text-sidebar-accent-foreground")} />
                        <span className="z-10 relative text-sm">{item.label}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-sidebar-border bg-sidebar/50">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-sidebar-accent cursor-pointer transition-colors w-full text-left">
                <Avatar className="w-9 h-9 border-2 border-sidebar-border shadow-sm">
                  <AvatarFallback style={{ backgroundColor: `${primaryColor}30`, color: primaryColor }}>
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="text-sm font-semibold truncate">{user?.name ?? "Unknown"}</span>
                  <span className="text-xs text-sidebar-foreground/50 truncate">{user?.email ?? ""}</span>
                </div>
                <ChevronDown className="w-4 h-4 text-sidebar-foreground/40 flex-shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {isConsultant && activeClientId && (
                <>
                  <DropdownMenuItem asChild>
                    <Link href="/clients">
                      <ArrowLeftRight className="w-4 h-4 mr-2" />
                      Switch Client
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive">
                <LogOut className="w-4 h-4 mr-2" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        <img 
          src={`${import.meta.env.BASE_URL}images/dashboard-bg.png`}
          alt="Background" 
          className="absolute inset-0 w-full h-full object-cover opacity-30 pointer-events-none -z-10 mix-blend-multiply"
        />

        {/* Top Header */}
        <header className="h-16 bg-background/60 backdrop-blur-xl border-b border-border/50 flex items-center justify-between px-4 sm:px-6 lg:px-8 z-10 sticky top-0 supports-[backdrop-filter]:bg-background/60">
          <div className="flex items-center gap-4">
            <h1 className="text-xl sm:text-2xl font-display font-bold text-foreground drop-shadow-sm">
              {title}
            </h1>
          </div>
          
          <div className="flex items-center gap-3">
            {isConsultant && (
              <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-full">
                <ShieldCheck className="w-3.5 h-3.5 text-amber-600" />
                <span className="text-amber-700 font-medium">Consultant</span>
              </div>
            )}
            <button className="relative p-2 rounded-full hover:bg-card border border-transparent hover:border-border transition-all shadow-sm bg-card/30">
              <Bell className="w-5 h-5 text-muted-foreground" />
              <span className="absolute top-1 right-1.5 w-2 h-2 bg-rose-500 rounded-full border-2 border-card"></span>
            </button>
            <div className="md:hidden">
              <Avatar className="w-8 h-8">
                <AvatarFallback style={{ backgroundColor: `${primaryColor}30`, color: primaryColor }}>
                  {initials}
                </AvatarFallback>
              </Avatar>
            </div>
          </div>
        </header>

        {/* Mobile Nav */}
        <nav className="md:hidden flex overflow-x-auto border-b border-border bg-card/80 backdrop-blur-md px-4 py-2 scrollbar-hide">
          {navGroups.flatMap(g => g.items).map((item) => {
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href} className="flex-shrink-0 mr-2">
                <div className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors border",
                  isActive ? "text-white border-transparent" : "bg-card text-muted-foreground border-border hover:bg-muted"
                )}
                  style={isActive ? { backgroundColor: primaryColor, borderColor: primaryColor } : {}}
                >
                  <item.icon className="w-3.5 h-3.5" />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Page Content */}
        <div className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="max-w-7xl mx-auto space-y-6"
          >
            {children}
          </motion.div>
        </div>
      </main>
    </div>
  );
}
