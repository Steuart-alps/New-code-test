import { useLocation } from "wouter";
import { ShieldCheck, CheckCircle2, Users, Bell, FileText, ArrowRight, Star, Zap, Lock, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";

const FEATURES = [
  { icon: Users, title: "Multi-Site Ready", desc: "Manage compliance across one site or many. Keep each location's records, contractors, and tasks neatly separated." },
  { icon: Bell, title: "Automated Reminders", desc: "Contractors and staff get email reminders as deadlines approach — so nothing slips through the cracks." },
  { icon: FileText, title: "Contractor & Certificate Tracking", desc: "Track every contractor, insurance certificate, and compliance check with a full audit trail." },
  { icon: BarChart3, title: "Live Compliance Dashboard", desc: "See your compliance status at a glance and spot issues long before they become problems." },
  { icon: Lock, title: "Role-Based Access", desc: "Invite your team — and your H&S consultant if you have one — with the right level of access for each person." },
  { icon: Zap, title: "Calendar Invites Built In", desc: "Every reminder includes a calendar attachment so contractors and staff can book the work straight in." },
];

const PRICING_FEATURES = [
  "Every compliance module included",
  "Unlimited users on your account",
  "Automated email reminders & calendar invites",
  "Contractor & certificate tracking",
  "Add or remove sites anytime — billing adjusts automatically",
];

const TESTIMONIALS = [
  { quote: "We used to chase contractors over email and spreadsheets. ComplyTrack does it all for us automatically — our certificates are always up to date.", author: "Sarah M.", role: "Operations Manager, Leeds" },
  { quote: "We manage compliance across four sites. Having everything in one place — and giving our consultant view-only access when needed — has been a game-changer.", author: "James K.", role: "Facilities Director, London" },
];

export default function LandingPage() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur border-b border-border/50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-primary p-1.5 rounded-lg">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg font-display">ComplyTrack</span>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate("/login")}>Sign in</Button>
            <Button size="sm" onClick={() => navigate("/signup")}>Start free trial</Button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-background to-indigo-50/30 py-24 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary rounded-full px-4 py-1.5 text-sm font-medium mb-8">
              <Star className="w-3.5 h-3.5" /> Trusted by businesses across the UK
            </div>
            <h1 className="text-5xl sm:text-6xl font-bold font-display leading-tight mb-6 tracking-tight">
              Your Health & Safety compliance,<br className="hidden sm:block" />
              <span className="text-primary"> finally under control.</span>
            </h1>
            <p className="text-xl text-muted-foreground mb-10 max-w-2xl mx-auto leading-relaxed">
              ComplyTrack helps your business stay on top of compliance — across one site or many. Track contractors, send automated reminders, and give your H&S consultant access whenever you need a hand.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" className="px-8 py-6 text-base shadow-lg shadow-primary/25" onClick={() => navigate("/signup")}>
                Start your free trial <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
              <Button size="lg" variant="outline" className="px-8 py-6 text-base" onClick={() => navigate("/login")}>
                Sign in to your account
              </Button>
            </div>
            <p className="text-sm text-muted-foreground mt-5">14-day free trial · No credit card required to start</p>
          </motion.div>
        </div>

        {/* Decorative blobs */}
        <div className="absolute -top-32 -right-32 w-96 h-96 bg-primary/5 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -left-32 w-96 h-96 bg-indigo-200/20 rounded-full blur-3xl pointer-events-none" />
      </section>

      {/* Social proof bar */}
      <div className="bg-muted/30 border-y border-border/50 py-5 px-6">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-center gap-8 text-sm text-muted-foreground">
          {["ISO 45001 aligned", "GDPR compliant", "UK-based support", "14-day free trial"].map(item => (
            <div key={item} className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
              {item}
            </div>
          ))}
        </div>
      </div>

      {/* Features */}
      <section className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold font-display mb-3">Everything you need to stay compliant</h2>
            <p className="text-muted-foreground text-lg">Built for UK businesses managing their own Health & Safety compliance.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.07, duration: 0.4 }}
                viewport={{ once: true }}
                className="bg-card border border-border/50 rounded-2xl p-6 hover:shadow-md transition-shadow"
              >
                <div className="bg-primary/10 w-10 h-10 rounded-xl flex items-center justify-center mb-4">
                  <f.icon className="w-5 h-5 text-primary" />
                </div>
                <h3 className="font-semibold text-foreground mb-2">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="bg-muted/20 border-y border-border/50 py-20 px-6">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold font-display text-center mb-12">What businesses are saying</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {TESTIMONIALS.map((t) => (
              <div key={t.author} className="bg-card border border-border/50 rounded-2xl p-6">
                <div className="flex gap-1 mb-4">
                  {Array.from({ length: 5 }).map((_, i) => <Star key={i} className="w-4 h-4 fill-amber-400 text-amber-400" />)}
                </div>
                <p className="text-foreground mb-4 leading-relaxed">"{t.quote}"</p>
                <div>
                  <p className="font-semibold text-sm">{t.author}</p>
                  <p className="text-xs text-muted-foreground">{t.role}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-24 px-6" id="pricing">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-bold font-display mb-3">Simple, transparent pricing</h2>
            <p className="text-muted-foreground text-lg">One price. Pay only for the sites you manage.</p>
          </div>
          <div className="max-w-md mx-auto">
            <div className="relative rounded-2xl border border-primary bg-primary text-white shadow-2xl shadow-primary/30 p-8 flex flex-col">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-amber-400 text-amber-900 text-xs font-bold px-3 py-1 rounded-full">
                Everything included
              </div>
              <h3 className="font-bold text-lg mb-1 text-white">Per site</h3>
              <p className="text-xs mb-4 text-white/70">Scales with your business — one site or one hundred</p>
              <div className="flex items-baseline gap-1 mb-6">
                <span className="text-5xl font-bold text-white">£10</span>
                <span className="text-sm text-white/70">per site / month</span>
              </div>
              <ul className="space-y-3 mb-8 flex-1">
                {PRICING_FEATURES.map(f => (
                  <li key={f} className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-white/80" />
                    <span className="text-white/90">{f}</span>
                  </li>
                ))}
              </ul>
              <Button
                onClick={() => navigate("/signup")}
                variant="secondary"
                className="w-full bg-white text-primary hover:bg-white/90"
              >
                Start free trial
              </Button>
            </div>
          </div>
          <p className="text-center text-sm text-muted-foreground mt-8">
            Includes a 14-day free trial. Add or remove sites anytime — each added site is charged one month's access up front (no proration, no refunds). Have a discount code? Enter it during checkout.
          </p>
        </div>
      </section>

      {/* CTA Banner */}
      <section className="bg-primary py-20 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl font-bold text-white font-display mb-4">Ready to take control of your compliance?</h2>
          <p className="text-white/70 text-lg mb-8">Join businesses across the UK using ComplyTrack to stay safe, organised, and audit-ready.</p>
          <Button size="lg" variant="secondary" className="px-8 py-6 text-base" onClick={() => navigate("/signup")}>
            Create your free account <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/50 py-10 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="bg-primary p-1 rounded-md">
              <ShieldCheck className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold font-display text-sm">ComplyTrack</span>
          </div>
          <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} ComplyTrack. All rights reserved.</p>
          <button onClick={() => navigate("/login")} className="text-xs text-muted-foreground hover:text-foreground">Sign in</button>
        </div>
      </footer>
    </div>
  );
}
