import { useState } from "react";
import { useLocation } from "wouter";
import {
  ShieldCheck, CheckCircle2, Users, Bell, FileText, ArrowRight, Star, Zap, Lock,
  BarChart3, Flame, UtensilsCrossed, Droplets, Building2, Wrench, Plus, Minus, FolderOpen, BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import alpsLogo from "@/assets/alps-logo.png";

// ─── Module definitions ────────────────────────────────────────────────────────

const MODULES = [
  {
    key: "core",
    label: "ComplyTrack Core",
    price: 10,
    icon: ShieldCheck,
    color: "text-[#162D42]",
    bg: "bg-[#162D42]/5",
    border: "border-[#162D42]/20",
    activeBorder: "border-[#162D42]",
    activeBg: "bg-[#162D42]/5",
    required: true,
    description: "The foundation — compliance item tracking, contractor & certificate management, and audit trails.",
    features: [
      "Compliance checks & action items",
      "Contractor & certificate tracking",
      "Multi-site management",
      "Role-based team access",
      "Automated email reminders",
    ],
  },
  {
    key: "firetrack",
    label: "FireTrack",
    price: 10,
    icon: Flame,
    color: "text-orange-700",
    bg: "bg-orange-50",
    border: "border-orange-200",
    activeBorder: "border-orange-500",
    activeBg: "bg-orange-50",
    required: false,
    description: "Digital fire safety logbook — record and track every check required under the Regulatory Reform (Fire Safety) Order.",
    features: [
      "Weekly alarm tests & emergency lights",
      "Monthly extinguisher & door checks",
      "Annual fire drill logging",
      "Overdue & due-soon status cards",
      "Full timestamped audit history",
    ],
  },
  {
    key: "kitchentrack",
    label: "KitchenTrack",
    price: 10,
    icon: UtensilsCrossed,
    color: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
    activeBorder: "border-amber-500",
    activeBg: "bg-amber-50",
    required: false,
    description: "Digital food safety diary — daily temperature logs, delivery checks, and HACCP records for food businesses.",
    features: [
      "Kitchen open & close checks",
      "Daily cooking, cooling & hot-holding temps",
      "Delivery & cold food checks",
      "Corrective action logging",
      "Manager digital sign-off",
      "Configurable temperature limits",
    ],
  },
  {
    key: "legionellatrack",
    label: "LegionellaTrack",
    price: 10,
    icon: Droplets,
    color: "text-sky-700",
    bg: "bg-sky-50",
    border: "border-sky-200",
    activeBorder: "border-sky-500",
    activeBg: "bg-sky-50",
    required: false,
    description: "Water safety logbook — L8 ACOP and HSG274 compliant checks for Legionella risk management.",
    features: [
      "Cold & hot water temperature checks",
      "Sentinel flush & shower clean records",
      "Tank inspection & risk assessment logging",
      "Temperature recording with °C field",
      "Overdue check alerts by type",
    ],
  },
  {
    key: "fixtrack",
    label: "FixTrack",
    price: 10,
    icon: Wrench,
    color: "text-orange-700",
    bg: "bg-orange-50",
    border: "border-orange-200",
    activeBorder: "border-orange-500",
    activeBg: "bg-orange-50",
    required: false,
    description: "Staff maintenance issue reporting — log faults, assign responsibility, attach photos, and track resolution to close.",
    features: [
      "Report issues by type (electrical, plumbing, HVAC…)",
      "Attach photos and videos as evidence",
      "Set priority: low, medium, high, urgent",
      "Track status from reported → in progress → resolved",
      "Assign issues and set target resolution dates",
      "Solution notes and resolution log",
    ],
  },
  {
    // Backend service key is "safetrack" (see api-server/src/lib/services.ts
    // and ADDON_KEYS) even though the product is branded "PremisesTrack" —
    // this key must match exactly or checkout/signup rejects the selection.
    key: "safetrack",
    label: "PremisesTrack",
    price: 10,
    icon: Building2,
    color: "text-violet-700",
    bg: "bg-violet-50",
    border: "border-violet-200",
    activeBorder: "border-violet-500",
    activeBg: "bg-violet-50",
    required: false,
    description: "Digital premises safety logbook — routine workplace inspections, fault reporting, and housekeeping records.",
    features: [
      "Routine premises inspection checklists",
      "Slip, trip & fall hazard records",
      "Maintenance fault & repair logging",
      "Signage & housekeeping audits",
      "Timestamped inspection history",
    ],
  },
  {
    key: "doctrack",
    label: "DocTrack",
    price: 10,
    icon: FolderOpen,
    color: "text-cyan-700",
    bg: "bg-cyan-50",
    border: "border-cyan-200",
    activeBorder: "border-cyan-500",
    activeBg: "bg-cyan-50",
    required: false,
    description: "Centralised document library — store and access risk assessments, SOPs, policies, and procedures in one place.",
    features: [
      "Upload PDF, Word, Excel, PowerPoint, photos & videos",
      "Categorise as risk assessment, SOP, policy or procedure",
      "Assign documents to specific sites",
      "Instant download with short-lived secure links",
      "Searchable document library",
    ],
  },
  {
    key: "traintrack",
    label: "TrainTrack",
    price: 10,
    icon: BookOpen,
    color: "text-emerald-700",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    activeBorder: "border-emerald-500",
    activeBg: "bg-emerald-50",
    required: false,
    description: "Staff training records and certificate expiry tracking — know who is trained, in what, and when it expires.",
    features: [
      "Log training completions per staff member",
      "Track certificate expiry dates",
      "Amber alerts when certificates expire within 30 days",
      "Red alerts for any expired certificates",
      "Filter by site, status, or staff name",
      "Covers fire safety, food hygiene, manual handling & more",
    ],
  },
];

const FEATURES = [
  { icon: Users, title: "Multi-Site Ready", desc: "Manage compliance across one site or many. Each location's records, contractors, and tasks kept neatly separate." },
  { icon: Bell, title: "Automated Reminders", desc: "Contractors and staff get email reminders as deadlines approach — so nothing slips through the cracks." },
  { icon: FileText, title: "Full Audit Trail", desc: "Every action is timestamped and logged — your digital paper trail for inspections and audits." },
  { icon: BarChart3, title: "Live Status Dashboard", desc: "See your compliance status at a glance and spot issues long before they become problems." },
  { icon: Lock, title: "Role-Based Access", desc: "Invite your team — and your H&S consultant — with exactly the right level of access." },
  { icon: Zap, title: "Calendar Invites Built In", desc: "Every reminder includes a calendar attachment so contractors and staff can book the work straight in." },
];

const TESTIMONIALS = [
  { quote: "We used to chase contractors over email and spreadsheets. ComplyTrack does it all for us automatically — our certificates are always up to date.", author: "Sarah M.", role: "Operations Manager, Leeds" },
  { quote: "We manage compliance across four sites. Having everything in one place — and giving our consultant view-only access when needed — has been a game-changer.", author: "James K.", role: "Facilities Director, London" },
];

// ─── Pricing builder (interactive) ────────────────────────────────────────────

function PricingBuilder({ onStart }: { onStart: (selected: string[]) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(["core"]));
  const [bundleActive, setBundleActive] = useState(false);

  const toggle = (key: string) => {
    if (key === "core") return; // required
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setBundleActive(false);
  };

  const activateBundle = () => {
    setBundleActive(true);
    setSelected(new Set(MODULES.map(m => m.key)));
  };

  const deactivateBundle = () => {
    setBundleActive(false);
    setSelected(new Set(["core"]));
  };

  const addonKeys = MODULES.filter(m => !m.required).map(m => m.key);
  const allAddonsSelected = addonKeys.every(k => selected.has(k));

  const rawTotal = bundleActive ? 50 : MODULES.filter(m => selected.has(m.key)).reduce((s, m) => s + m.price, 0);
  const total = Math.min(rawTotal, 50);
  const saving = bundleActive && total === 50 ? MODULES.filter(m => !m.required).length * 10 - 30 : 0;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="text-center mb-14">
        <h2 className="text-4xl sm:text-5xl font-display mb-5 text-[#162D42]">Build your compliance stack</h2>
        <p className="text-muted-foreground text-xl font-light max-w-xl mx-auto">
          Start with the core and add the modules you need. Pay only for what you use — capped at £50/site/month for everything.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-8">
        {MODULES.map((mod, i) => {
          const Icon = mod.icon;
          const active = selected.has(mod.key) || bundleActive;

          return (
            <motion.div
              key={mod.key}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08, duration: 0.5, ease: "easeOut" }}
              viewport={{ once: true, margin: "-40px" }}
              onClick={() => !mod.required && toggle(mod.key)}
              className={`relative border-2 p-6 transition-all duration-200 ${
                mod.required ? "cursor-default" : "cursor-pointer"
              } ${active ? `${mod.activeBorder} ${mod.activeBg}` : `border-border bg-white hover:border-${mod.border}`}`}
            >
              {mod.required && (
                <span className="absolute top-4 right-4 text-xs uppercase tracking-widest font-medium text-muted-foreground bg-muted px-2 py-0.5">
                  Included
                </span>
              )}
              {!mod.required && (
                <div className={`absolute top-4 right-4 w-5 h-5 border-2 flex items-center justify-center transition-all ${
                  active ? "border-current bg-current" : "border-border bg-white"
                } ${mod.color}`}>
                  {active && <CheckCircle2 className="w-3 h-3 text-white" />}
                </div>
              )}

              <div className="flex items-start gap-4 mb-4">
                <div className={`p-2.5 rounded-none ${mod.bg}`}>
                  <Icon className={`w-5 h-5 ${mod.color}`} />
                </div>
                <div>
                  <div className="font-display text-lg text-[#162D42]">{mod.label}</div>
                  <div className="text-sm font-medium text-muted-foreground">
                    {mod.required ? "£10/site/mo" : "+ £10/site/mo"}
                  </div>
                </div>
              </div>

              <p className="text-sm text-muted-foreground leading-relaxed mb-4 font-light">{mod.description}</p>

              <ul className="space-y-1.5">
                {mod.features.map(f => (
                  <li key={f} className="flex items-start gap-2 text-sm text-[#1A1A1A]/80">
                    <CheckCircle2 className={`w-4 h-4 flex-shrink-0 mt-0.5 ${active ? mod.color : "text-muted-foreground"}`} />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          );
        })}
      </div>

      {/* Bundle toggle */}
      <div
        onClick={bundleActive ? deactivateBundle : activateBundle}
        className={`border-2 p-5 cursor-pointer transition-all duration-200 flex items-center justify-between mb-8 ${
          bundleActive
            ? "border-emerald-500 bg-emerald-50"
            : "border-border bg-white hover:border-emerald-400"
        }`}
      >
        <div className="flex items-center gap-3">
          <div className={`w-5 h-5 border-2 flex items-center justify-center transition-all ${
            bundleActive ? "border-emerald-600 bg-emerald-600" : "border-border bg-white"
          }`}>
            {bundleActive && <CheckCircle2 className="w-3 h-3 text-white" />}
          </div>
          <div>
            <span className="font-display text-[#162D42] text-lg">ComplyTrack Complete</span>
            <span className="text-sm text-muted-foreground ml-3 font-light">All current and future modules — best value</span>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="font-display text-2xl text-emerald-800">£50<span className="text-sm font-sans font-normal text-muted-foreground">/site/mo</span></div>
          <div className="text-xs text-emerald-700 font-medium">Save £{(MODULES.filter(m => !m.required).length * 10) - (50 - 10)}/mo vs. all add-ons</div>
        </div>
      </div>

      {/* Live total + CTA */}
      <div className="bg-[#162D42] text-white p-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
        <div>
          <div className="text-sm text-white/60 uppercase tracking-widest font-medium mb-1">Your plan · per site per month</div>
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-display">£{total}</span>
            <span className="text-white/60 text-sm">+ VAT</span>
          </div>
          <div className="text-sm text-white/60 mt-1 font-light">
            {bundleActive
              ? "All modules — capped price"
              : `${Array.from(selected).length} module${Array.from(selected).length !== 1 ? "s" : ""} selected · 14-day free trial`}
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:items-end">
          <Button
            size="lg"
            onClick={() => onStart(Array.from(selected))}
            className="bg-primary hover:bg-primary/90 text-primary-foreground px-10 py-6 text-base rounded-[2px] w-full sm:w-auto"
          >
            Start free trial <ArrowRight className="w-5 h-5 ml-2" />
          </Button>
          <p className="text-xs text-white/50 text-center sm:text-right">No credit card required during trial</p>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const [, navigate] = useLocation();

  function handleStart(selected: string[]) {
    const addons = selected.filter(k => k !== "core");
    const params = new URLSearchParams();
    if (addons.length > 0) params.set("modules", addons.join(","));
    const qs = params.toString();
    navigate(`/signup${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="min-h-screen bg-[#F7F2E4] text-foreground font-sans">
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 bg-[#162D42]/95 backdrop-blur border-b border-white/10 text-white">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-6 h-6 text-primary" />
              <span className="font-medium text-xl font-display tracking-wide">ComplyTrack</span>
            </div>
            <div className="hidden sm:flex items-center gap-3 pl-4 border-l border-white/20">
              <span className="text-sm text-white/60 font-display italic">by</span>
              <img src={alpsLogo} alt="ALPS Consulting" className="h-6 opacity-80 brightness-0 invert" />
            </div>
          </div>
          <div className="flex items-center gap-6">
            <a href="#pricing" className="text-sm text-white/70 hover:text-white transition-colors hidden sm:block">Pricing</a>
            <button className="text-sm font-medium text-white/80 hover:text-white transition-colors" onClick={() => navigate("/login")}>Sign in</button>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-none rounded-[2px]" onClick={() => navigate("/signup")}>Start free trial</Button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden bg-[#162D42] text-white pt-48 pb-36 px-6">
        <div className="max-w-4xl mx-auto text-center relative z-10">
          <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: "easeOut" }}>
            <div className="inline-flex items-center gap-2 border border-white/20 text-white/80 rounded-full px-4 py-1.5 text-sm font-medium mb-10 tracking-wide">
              <Star className="w-3.5 h-3.5 text-primary fill-primary" /> Built for UK Health & Safety compliance
            </div>
            <h1 className="text-5xl sm:text-7xl font-display leading-[1.05] mb-8 tracking-tight text-white">
              Health & Safety<br />
              <span className="text-primary italic">Done Right.</span>
            </h1>
            <p className="text-xl text-white/70 mb-12 max-w-2xl mx-auto leading-relaxed font-light">
              A modular compliance platform from ALPS Consulting. Choose the modules your business needs — fire safety, food hygiene, water safety — and pay only for what you use.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-5">
              <Button size="lg" className="px-10 py-7 text-lg bg-primary hover:bg-primary/90 text-primary-foreground rounded-[2px] w-full sm:w-auto" onClick={() => navigate("/signup")}>
                Start free trial <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
              <Button size="lg" variant="outline" className="px-10 py-7 text-lg border-white/30 text-white hover:bg-white/10 rounded-[2px] w-full sm:w-auto" onClick={() => navigate("/login")}>
                Sign in to your account
              </Button>
            </div>
            <p className="text-sm text-white/50 mt-6 tracking-wide">14-day free trial · No credit card required</p>
          </motion.div>
        </div>
        <div className="absolute top-0 right-0 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px] pointer-events-none translate-x-1/3 -translate-y-1/3" />
      </section>

      {/* Trust bar */}
      <div className="bg-white border-b border-border/50 py-6 px-6">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-center gap-10 text-sm font-medium text-muted-foreground uppercase tracking-widest">
          {["ISO 45001 aligned", "GDPR compliant", "UK H&S legislation", "14-day free trial"].map(item => (
            <div key={item} className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />
              {item}
            </div>
          ))}
        </div>
      </div>

      {/* Module showcase */}
      <section className="py-32 px-6 bg-[#F7F2E4]">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl sm:text-5xl font-display mb-5 text-[#162D42]">One platform, every compliance discipline</h2>
            <p className="text-muted-foreground text-xl font-light max-w-2xl mx-auto">
              Each module is built for a specific area of UK Health & Safety law. Use them together or separately — your call.
            </p>
          </div>

          {/* Module feature cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-20">
            {MODULES.map((mod, i) => {
              const Icon = mod.icon;
              return (
                <motion.div
                  key={mod.key}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.1, duration: 0.5, ease: "easeOut" }}
                  viewport={{ once: true, margin: "-40px" }}
                  className="bg-white border-none shadow-sm p-8 flex flex-col group hover:-translate-y-1 transition-transform duration-300"
                >
                  <div className={`w-12 h-12 ${mod.bg} flex items-center justify-center mb-5 group-hover:scale-110 transition-transform duration-300`}>
                    <Icon className={`w-6 h-6 ${mod.color}`} />
                  </div>
                  <div className="font-display text-xl text-[#162D42] mb-1">{mod.label}</div>
                  <div className={`text-sm font-medium mb-4 ${mod.color}`}>
                    {mod.required ? "Core — £10/site/mo" : "Add-on — £10/site/mo"}
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed font-light flex-1">{mod.description}</p>
                </motion.div>
              );
            })}
          </div>

          {/* Legislation callout strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { icon: Flame, label: "FireTrack", legislation: "Regulatory Reform (Fire Safety) Order 2005" },
              { icon: UtensilsCrossed, label: "KitchenTrack", legislation: "Food Safety Act 1990 + HACCP Regulation (EC) 852/2004" },
              { icon: Droplets, label: "LegionellaTrack", legislation: "HSG274 / L8 ACOP — Legionella bacteria control" },
              { icon: Building2, label: "PremisesTrack", legislation: "Workplace (Health, Safety and Welfare) Regulations 1992" },
            ].map(({ icon: Icon, label, legislation }) => (
              <div key={label} className="bg-white/60 border border-border/40 p-5 flex items-start gap-4">
                <Icon className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-sm text-[#162D42]">{label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 font-light">{legislation}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing builder */}
      <section className="py-32 px-6 bg-white" id="pricing">
        <PricingBuilder onStart={handleStart} />
      </section>

      {/* Platform features */}
      <section className="py-32 px-6 bg-[#F7F2E4]">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="text-4xl sm:text-5xl font-display mb-6 text-[#162D42]">Everything that runs underneath</h2>
            <p className="text-muted-foreground text-xl font-light max-w-2xl mx-auto">Every module is built on a shared platform with these capabilities.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.1, duration: 0.6, ease: "easeOut" }}
                viewport={{ once: true, margin: "-50px" }}
                className="bg-white border-none shadow-sm p-8 group hover:-translate-y-1 transition-transform duration-300"
              >
                <div className="w-12 h-12 bg-[#F7F2E4] flex items-center justify-center mb-6 group-hover:bg-primary transition-colors duration-300">
                  <f.icon className="w-5 h-5 text-[#162D42] group-hover:text-white transition-colors duration-300" />
                </div>
                <h3 className="font-medium text-xl font-display text-[#162D42] mb-3">{f.title}</h3>
                <p className="text-muted-foreground leading-relaxed font-light">{f.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="bg-[#162D42] py-32 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-4xl sm:text-5xl font-display text-center mb-20 text-white">Understated confidence</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-10">
            {TESTIMONIALS.map((t) => (
              <div key={t.author} className="bg-white/5 border border-white/10 p-10">
                <div className="flex gap-1 mb-6">
                  {Array.from({ length: 5 }).map((_, i) => <Star key={i} className="w-4 h-4 fill-primary text-primary" />)}
                </div>
                <p className="text-white/80 mb-8 text-xl font-display italic leading-relaxed">"{t.quote}"</p>
                <div>
                  <p className="font-semibold text-sm tracking-wide uppercase text-white">{t.author}</p>
                  <p className="text-sm text-white/50 mt-1 font-light">{t.role}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-32 px-6 bg-[#F7F2E4] text-center">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-4xl sm:text-5xl font-display mb-6 text-[#162D42]">Ready to get compliant?</h2>
          <p className="text-muted-foreground text-xl font-light mb-12">
            Start your 14-day free trial. No credit card required. Add your team, invite your H&S consultant, and start logging on day one.
          </p>
          <Button size="lg" className="px-12 py-7 text-lg bg-[#162D42] hover:bg-[#162D42]/90 text-white rounded-[2px]" onClick={() => navigate("/signup")}>
            Start free trial <ArrowRight className="w-5 h-5 ml-2" />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-[#162D42] py-16 px-6 text-white/80">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="flex flex-col sm:flex-row items-center gap-6">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-primary" />
              <span className="font-medium font-display text-lg tracking-wide text-white">ComplyTrack</span>
            </div>
            <div className="hidden sm:block w-px h-6 bg-white/20" />
            <div className="flex items-center gap-3">
              <span className="text-sm font-display italic text-white/60">by</span>
              <img src={alpsLogo} alt="ALPS Consulting" className="h-6 opacity-70 brightness-0 invert" />
            </div>
          </div>
          <p className="text-sm font-light">© {new Date().getFullYear()} ALPS Consulting Ltd. All rights reserved.</p>
          <div className="flex items-center gap-5">
            <button onClick={() => navigate("/terms")} className="text-sm font-light hover:text-white transition-colors">Terms</button>
            <button onClick={() => navigate("/privacy")} className="text-sm font-light hover:text-white transition-colors">Privacy</button>
            <button onClick={() => navigate("/login")} className="text-sm font-light hover:text-white transition-colors">Sign in</button>
          </div>
        </div>
      </footer>
    </div>
  );
}
