import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  ListTodo, 
  Tags, 
  ShieldCheck,
  Bell,
  Search,
  Briefcase,
  Building,
  Settings
} from "lucide-react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

const navGroups = [
  {
    title: "Overview",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
    ]
  },
  {
    title: "External Compliance",
    items: [
      { href: "/contractors", label: "Contractors", icon: Building },
      { href: "/external", label: "External Checks", icon: Briefcase },
    ]
  },
  {
    title: "Internal Compliance",
    items: [
      { href: "/internal", label: "Internal Checks", icon: ListTodo },
    ]
  },
  {
    title: "System",
    items: [
      { href: "/categories", label: "Categories", icon: Tags },
      { href: "/settings", label: "Settings", icon: Settings },
    ]
  }
];

export function AppLayout({ children, title }: { children: ReactNode; title: string }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row font-sans">
      {/* Sidebar - Desktop */}
      <aside className="hidden md:flex flex-col w-64 bg-sidebar text-sidebar-foreground border-r border-sidebar-border shadow-xl z-20">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border bg-sidebar/50 backdrop-blur-sm">
          <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <div className="bg-primary/20 p-2 rounded-xl border border-primary/30">
              <ShieldCheck className="w-5 h-5 text-primary" />
            </div>
            <span className="font-display font-bold text-lg tracking-tight">Comply<span className="text-primary">Track</span></span>
          </Link>
        </div>
        
        <nav className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
          {navGroups.map((group) => (
            <div key={group.title} className="space-y-2">
              <div className="text-xs font-bold text-sidebar-foreground/50 uppercase tracking-wider px-2">
                {group.title}
              </div>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
                  return (
                    <Link key={item.href} href={item.href} className="block">
                      <div className={cn(
                        "flex items-center gap-3 px-3 py-2 rounded-xl font-medium transition-all duration-200 group relative",
                        isActive 
                          ? "bg-primary text-primary-foreground shadow-md shadow-primary/20" 
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      )}>
                        {isActive && (
                          <motion.div 
                            layoutId="sidebar-active" 
                            className="absolute inset-0 bg-primary rounded-xl z-0"
                            transition={{ type: "spring", stiffness: 300, damping: 30 }}
                          />
                        )}
                        <item.icon className={cn("w-4 h-4 z-10 relative", isActive ? "text-primary-foreground" : "text-sidebar-foreground/50 group-hover:text-sidebar-accent-foreground")} />
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
          <div className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-sidebar-accent cursor-pointer transition-colors">
            <Avatar className="w-9 h-9 border-2 border-sidebar-border shadow-sm">
              {/* placeholder avatar */}
              <AvatarImage src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100&h=100&fit=crop" />
              <AvatarFallback>AD</AvatarFallback>
            </Avatar>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">Admin User</span>
              <span className="text-xs text-sidebar-foreground/50">admin@company.com</span>
            </div>
          </div>
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
          
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex relative group">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors" />
              <input 
                type="text" 
                placeholder="Search..." 
                className="bg-card/50 border border-border focus:border-primary/50 focus:bg-card focus:ring-4 focus:ring-primary/10 rounded-full py-1.5 pl-9 pr-4 text-sm w-48 lg:w-64 transition-all outline-none shadow-sm"
              />
            </div>
            <button className="relative p-2 rounded-full hover:bg-card border border-transparent hover:border-border transition-all shadow-sm bg-card/30">
              <Bell className="w-5 h-5 text-muted-foreground" />
              <span className="absolute top-1 right-1.5 w-2 h-2 bg-rose-500 rounded-full border-2 border-card"></span>
            </button>
            <div className="md:hidden">
              <Avatar className="w-8 h-8">
                <AvatarFallback>AD</AvatarFallback>
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
                  isActive ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:bg-muted"
                )}>
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
