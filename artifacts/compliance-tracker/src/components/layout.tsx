import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { 
  ShieldCheck,
  Bell,
  LogOut,
  ChevronDown,
  ArrowLeft,
  ArrowLeftRight,
  Smartphone,
  Lock,
  Menu,
  ChevronRight,
  MessageSquareWarning
} from "lucide-react";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuth, useIsConsultant, useCanAdmin } from "@/context/auth-context";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetHeader, SheetDescription } from "@/components/ui/sheet";
import alpsLogo from "@/assets/alps-logo.png";
import { ModuleActionsPanel } from "@/components/module-actions-panel";
import { FeedbackDialog } from "@/components/feedback-dialog";
import { CancellationBanner } from "@/components/cancellation-banner";

const moduleActionRoutes: { prefix: string; moduleKey: string }[] = [
  { prefix: "/daily-track-am", moduleKey: "daily_am" },
  { prefix: "/daily-track-pm", moduleKey: "daily_pm" },
  { prefix: "/food-safety", moduleKey: "kitchen" },
  { prefix: "/kitchen", moduleKey: "kitchen" },
  { prefix: "/fire-safety", moduleKey: "fire" },
  { prefix: "/legionella", moduleKey: "legionella" },
  { prefix: "/pool-track", moduleKey: "pool" },
  { prefix: "/aqua-track", moduleKey: "pool" },
  { prefix: "/pat-track", moduleKey: "pat" },
  { prefix: "/pest-track", moduleKey: "pest" },
  { prefix: "/fix-track", moduleKey: "fix" },
  { prefix: "/safe-track", moduleKey: "safe" },
  { prefix: "/premises-track", moduleKey: "premises" },
  { prefix: "/room-track", moduleKey: "room" },
  { prefix: "/doc-track", moduleKey: "doc" },
  { prefix: "/train-track", moduleKey: "train" },
  { prefix: "/bike-track", moduleKey: "bike" },
  { prefix: "/hot-tub", moduleKey: "hot_tub" },
  { prefix: "/tree-track", moduleKey: "tree" },
  { prefix: "/green-track", moduleKey: "green" },
  { prefix: "/swim-track", moduleKey: "swim" },
  { prefix: "/incidents", moduleKey: "incident" },
];

import { getNavGroups, isNavItemActive, isNavItemAvailable, type NavGroup } from "@/lib/nav-groups";

function useNavGroups(): NavGroup[] {
  const isConsultant = useIsConsultant();
  const canAdmin = useCanAdmin();
  return getNavGroups({ isConsultant, canAdmin });
}

function NavSidebarGroup({ group, location, hasService, primaryColor, onNavigate, layoutIdPrefix, storageScope }: { group: NavGroup; location: string; hasService: (s: string) => boolean; primaryColor: string; onNavigate?: () => void; layoutIdPrefix: string; storageScope: string }) {
  const storageKey = `complytrack:nav:${storageScope}:${group.id}`;
  const hasActiveRoute = group.items.some(item => isNavItemActive(item, location));
  const hasAvailableItems = group.items.some(item => isNavItemAvailable(item, hasService));
  const [isOpen, setIsOpen] = useState(() => {
    if (hasActiveRoute) return true;
    if (!hasAvailableItems) return false;
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved !== null) return saved === "true";
    } catch {
      // Private browsing may disable storage; keep the default.
    }
    return group.defaultOpen;
  });

  useEffect(() => {
    if (hasActiveRoute) setIsOpen(true);
  }, [location, hasActiveRoute]);

  function toggleOpen(open: boolean) {
    setIsOpen(open);
    try {
      window.localStorage.setItem(storageKey, String(open));
    } catch {
      // Navigation still works if storage is unavailable.
    }
  }

  return (
    <Collapsible open={isOpen} onOpenChange={toggleOpen} className="space-y-1">
      <CollapsibleTrigger className={cn("flex items-center justify-between w-full px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest hover:text-sidebar-foreground/80 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-foreground/30 rounded-sm", hasActiveRoute ? "text-sidebar-foreground" : "text-sidebar-foreground/60")}>
        <span>{group.title}</span>
        <ChevronRight className={cn("w-3 h-3 transition-transform duration-200", isOpen && "rotate-90")} />
      </CollapsibleTrigger>
      <AnimatePresence initial={false}>
        {isOpen && (
          <CollapsibleContent forceMount asChild>
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="space-y-1 overflow-hidden"
            >
              {group.items.map((item) => {
                const isActive = isNavItemActive(item, location);
                const isLocked = !isNavItemAvailable(item, hasService);
                const isComingSoon = item.comingSoon === true;
                const inner = (
                  <div className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-sm font-medium transition-all duration-200 group relative",
                    isActive
                      ? "text-sidebar-foreground"
                      : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent",
                    (isLocked || isComingSoon) && "opacity-70"
                  )}
                  >
                    {isActive && !isComingSoon && (
                      <motion.div
                        layoutId={`${layoutIdPrefix}-active`}
                        className="absolute inset-0 rounded-sm z-0"
                        style={{ backgroundColor: `${primaryColor}20`, borderLeft: `3px solid ${primaryColor}` }}
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                      />
                    )}
                    <item.icon className={cn("w-4 h-4 z-10 relative", isActive && !isComingSoon ? "text-sidebar-foreground" : "text-sidebar-foreground/40 group-hover:text-sidebar-foreground/70")} style={isActive && !isComingSoon ? { color: primaryColor } : {}} />
                    <span className="z-10 relative text-sm tracking-wide flex-1 text-left">{item.label}</span>
                    {isComingSoon ? (
                      <span className="z-10 relative text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sidebar-foreground/10 text-sidebar-foreground/50 tracking-wide">
                        Soon
                      </span>
                    ) : isLocked ? (
                      <Lock className="w-3.5 h-3.5 z-10 relative text-sidebar-foreground/40" />
                    ) : null}
                  </div>
                );
                return isComingSoon ? (
                  <div key={item.href} className="cursor-default">{inner}</div>
                ) : (
                  <Link key={item.href} href={item.href} onClick={onNavigate} className="block focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-foreground/30 rounded-sm">{inner}</Link>
                );
              })}
            </motion.div>
          </CollapsibleContent>
        )}
      </AnimatePresence>
    </Collapsible>
  );
}

export function AppLayout({ children, title }: { children: ReactNode; title: string }) {
  const [location] = useLocation();
  const { user, client, logout, activeClientId, hasService } = useAuth();
  const isConsultant = useIsConsultant();
  const navGroups = useNavGroups();
  const navStorageScope = `${user?.id ?? "guest"}:${activeClientId ?? client?.id ?? "none"}`;
  const [showAppDialog, setShowAppDialog] = useState(false);
  const [showFeedbackDialog, setShowFeedbackDialog] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const moduleActionKey = moduleActionRoutes.find(route => location.startsWith(route.prefix))?.moduleKey;

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
        
        <nav className="flex-1 overflow-y-auto px-4 py-6 space-y-6 scrollbar-hide">
          {navGroups.map((group) => (
            <NavSidebarGroup
              key={`${navStorageScope}:${group.id}`}
              group={group}
              location={location}
              hasService={hasService}
              primaryColor={primaryColor}
              layoutIdPrefix="desktop"
              storageScope={navStorageScope}
            />
          ))}
        </nav>

        <div className="p-4 border-t border-sidebar-border bg-sidebar/50 flex flex-col gap-4">
          <button
            onClick={() => setShowFeedbackDialog(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-sm text-sm text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
          >
            <MessageSquareWarning className="h-4 w-4" />
            Submit feedback
          </button>
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
              <DropdownMenuItem
                onClick={() => setShowAppDialog(true)}
                className="rounded-none cursor-pointer"
              >
                <Smartphone className="w-4 h-4 mr-2" />
                Get the mobile app
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout} className="rounded-none cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10">
                <LogOut className="w-4 h-4 mr-2" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Mobile app download dialog */}
      <Dialog open={showAppDialog} onOpenChange={setShowAppDialog}>
        <DialogContent className="max-w-sm rounded-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-primary" />
              ComplyTrack Mobile
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Log compliance checks, report issues, and view safety records from your phone — available for iOS and Android.
          </p>
          <div className="flex flex-col gap-3 mt-1">
            <a
              href="https://apps.apple.com/search?term=complytrack+alps"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 border border-border rounded-sm px-4 py-3 hover:bg-muted transition-colors"
            >
              <svg viewBox="0 0 24 24" className="w-6 h-6 flex-shrink-0" fill="currentColor">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              <div>
                <p className="text-xs text-muted-foreground leading-none mb-0.5">Download on the</p>
                <p className="text-sm font-semibold leading-none">App Store</p>
              </div>
            </a>
            <a
              href="https://play.google.com/store/search?q=complytrack+alps&c=apps"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 border border-border rounded-sm px-4 py-3 hover:bg-muted transition-colors"
            >
              <svg viewBox="0 0 24 24" className="w-6 h-6 flex-shrink-0" fill="currentColor">
                <path d="M3.18 23.76c.34.19.73.21 1.1.07l12.16-7.02-2.76-2.76-10.5 9.71zm16.53-9.54L17.1 12.7l2.61-2.61-2.37-1.37-2.61 2.61-8.95-8.95C5.34.99 4.97.97 4.6 1.11L16.24 12.73l3.47-2zm-16.53-12C2.84.54 2.5.92 2.5 1.5v20.92c0 .58.34.96.68 1.14l10.72-10.7L3.18 2.22zm18.14 10.49-2.22-1.28-2.93 2.93 2.93 2.93 2.25-1.3c.64-.37.64-1.36-.03-1.78z"/>
              </svg>
              <div>
                <p className="text-xs text-muted-foreground leading-none mb-0.5">Get it on</p>
                <p className="text-sm font-semibold leading-none">Google Play</p>
              </div>
            </a>
          </div>
          <p className="text-xs text-muted-foreground text-center pt-1">
            Sign in with your existing ComplyTrack account
          </p>
        </DialogContent>
      </Dialog>
      <FeedbackDialog open={showFeedbackDialog} onOpenChange={setShowFeedbackDialog} />

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative bg-white">
        <div className="absolute inset-0 w-full h-full bg-[#F7F2E4]/30 pointer-events-none -z-10" />

        {/* Top Header */}
        <header className="h-[80px] bg-white/80 backdrop-blur-md border-b border-border flex items-center justify-between px-6 lg:px-8 z-10 sticky top-0">
          <div className="flex items-center gap-3">
            <div className="md:hidden flex items-center">
              <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
                <SheetTrigger asChild>
                  <button className="p-1.5 -ml-2 mr-1 rounded-sm hover:bg-muted border border-transparent hover:border-border transition-all text-[#162D42]">
                    <Menu className="w-5 h-5" />
                  </button>
                </SheetTrigger>
                <SheetContent side="left" className="w-[280px] p-0 flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
                  <SheetHeader className="sr-only">
                    <SheetTitle>Navigation Menu</SheetTitle>
                    <SheetDescription>Main navigation menu for ComplyTrack.</SheetDescription>
                  </SheetHeader>
                  <div className="min-h-[80px] flex items-center px-6 py-4 border-b border-sidebar-border">
                    <Link href="/dashboard" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-3 hover:opacity-80 transition-opacity w-full min-w-0">
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
                  <nav className="flex-1 overflow-y-auto px-4 py-6 space-y-6 scrollbar-hide">
                    {navGroups.map((group) => (
                      <NavSidebarGroup
                        key={`${navStorageScope}:${group.id}`}
                        group={group}
                        location={location}
                        hasService={hasService}
                        primaryColor={primaryColor}
                        layoutIdPrefix="mobile"
                        storageScope={navStorageScope}
                        onNavigate={() => setMobileMenuOpen(false)}
                      />
                    ))}
                  </nav>
                  <div className="p-4 border-t border-sidebar-border">
                    <button
                      onClick={() => {
                        setMobileMenuOpen(false);
                        setShowFeedbackDialog(true);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 rounded-sm text-sm text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                    >
                      <MessageSquareWarning className="h-4 w-4" />
                      Submit feedback
                    </button>
                  </div>
                </SheetContent>
              </Sheet>
            </div>
            {location !== "/dashboard" && (
              <button
                onClick={() => window.history.back()}
                className="p-1.5 rounded-sm hover:bg-muted border border-transparent hover:border-border transition-all text-[#162D42]/60 hover:text-[#162D42]"
                title="Go back"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <h1 className="text-2xl font-display font-medium text-[#162D42] truncate">
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

        {/* Page Content */}
        <div className="flex-1 overflow-auto p-6 lg:p-8">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className="max-w-7xl mx-auto space-y-8"
          >
            <CancellationBanner />
            {location !== "/compliance-hub" && (
              <div className="flex items-center justify-between gap-3 rounded-sm border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-950">
                <span>Track records support your site-specific controls; review the applicable UK sources, appointments and corrective actions.</span>
                <Link href="/compliance-hub" className="shrink-0 font-semibold underline underline-offset-2">Compliance Hub</Link>
              </div>
            )}
            {children}
            {moduleActionKey && <ModuleActionsPanel moduleKey={moduleActionKey} />}
          </motion.div>
        </div>
      </main>
    </div>
  );
}
