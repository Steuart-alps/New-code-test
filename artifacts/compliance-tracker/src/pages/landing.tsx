import { useLocation } from "wouter";
import { ShieldCheck, CheckCircle2, Users, Bell, FileText, ArrowRight, Star, Zap, Lock, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import alpsLogo from "@/assets/alps-logo.png";

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
  "Add sites as you grow — your price updates from the next billing cycle",
];

const TESTIMONIALS = [
  { quote: "We used to chase contractors over email and spreadsheets. ComplyTrack does it all for us automatically — our certificates are always up to date.", author: "Sarah M.", role: "Operations Manager, Leeds" },
  { quote: "We manage compliance across four sites. Having everything in one place — and giving our consultant view-only access when needed — has been a game-changer.", author: "James K.", role: "Facilities Director, London" },
];

export default function LandingPage() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-[#F7F2E4] text-foreground font-sans">
      {/* Nav */}
      <nav className="absolute top-0 w-full z-50 bg-[#162D42]/95 backdrop-blur border-b border-white/10 text-white">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-6 h-6 text-primary" />
              <span className="font-medium text-xl font-display tracking-wide">ComplyTrack</span>
            </div>
            <div className="hidden sm:flex items-center gap-3 pl-4 border-l border-white/20">
              <span className="text-sm text-white/60 font-display italic">by</span>
              <img src={alpsLogo} alt="Alps Consultancy" className="h-6 opacity-80 brightness-0 invert" />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button className="text-sm font-medium text-white/80 hover:text-white transition-colors" onClick={() => navigate("/login")}>Sign in</button>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-none rounded-[2px]" onClick={() => navigate("/signup")}>Start free trial</Button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden bg-[#162D42] text-white pt-40 pb-32 px-6">
        <div className="max-w-4xl mx-auto text-center relative z-10">
          <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: "easeOut" }}>
            <div className="inline-flex items-center gap-2 border border-white/20 text-white/80 rounded-full px-4 py-1.5 text-sm font-medium mb-10 tracking-wide">
              <Star className="w-3.5 h-3.5 text-primary fill-primary" /> Trusted by businesses across the UK
            </div>
            <h1 className="text-5xl sm:text-7xl font-display leading-[1.1] mb-8 tracking-tight text-white">
              Health & Safety<br />
              <span className="text-primary italic">Done Right.</span>
            </h1>
            <p className="text-xl text-white/70 mb-12 max-w-2xl mx-auto leading-relaxed font-light">
              ComplyTrack brings the calm, assured professionalism of a seasoned consultant to your daily operations. Stay on top of compliance across one site or many.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-5">
              <Button size="lg" className="px-10 py-7 text-lg bg-primary hover:bg-primary/90 text-primary-foreground rounded-[2px] w-full sm:w-auto" onClick={() => navigate("/signup")}>
                Start your free trial <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
              <Button size="lg" variant="outline" className="px-10 py-7 text-lg border-white/30 text-white hover:bg-white/10 rounded-[2px] w-full sm:w-auto" onClick={() => navigate("/login")}>
                Sign in to your account
              </Button>
            </div>
            <p className="text-sm text-white/50 mt-6 tracking-wide">14-day free trial · No credit card required</p>
          </motion.div>
        </div>

        {/* Decorative elements */}
        <div className="absolute top-0 right-0 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px] pointer-events-none translate-x-1/3 -translate-y-1/3" />
      </section>

      {/* Social proof bar */}
      <div className="bg-white border-b border-border/50 py-6 px-6">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-center gap-10 text-sm font-medium text-muted-foreground uppercase tracking-widest">
          {["ISO 45001 aligned", "GDPR compliant", "UK-based support", "14-day free trial"].map(item => (
            <div key={item} className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />
              {item}
            </div>
          ))}
        </div>
      </div>

      {/* Features */}
      <section className="py-32 px-6 bg-[#F7F2E4]">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="text-4xl sm:text-5xl font-display mb-6 text-[#162D42]">Everything you need to stay compliant</h2>
            <p className="text-muted-foreground text-xl font-light max-w-2xl mx-auto">Built for UK businesses managing their own Health & Safety compliance, with the elegance and clarity of professional consultancy.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.1, duration: 0.6, ease: "easeOut" }}
                viewport={{ once: true, margin: "-50px" }}
                className="bg-white border-none shadow-sm rounded-none p-8 group hover:-translate-y-1 transition-transform duration-300"
              >
                <div className="w-12 h-12 bg-[#F7F2E4] rounded-full flex items-center justify-center mb-6 group-hover:bg-primary transition-colors duration-300">
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
      <section className="bg-white py-32 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-4xl sm:text-5xl font-display text-center mb-20 text-[#162D42]">Understated confidence</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-10">
            {TESTIMONIALS.map((t) => (
              <div key={t.author} className="bg-[#F7F2E4] border-none rounded-none p-10">
                <div className="flex gap-1 mb-6">
                  {Array.from({ length: 5 }).map((_, i) => <Star key={i} className="w-4 h-4 fill-[#162D42] text-[#162D42]" />)}
                </div>
                <p className="text-[#1A1A1A] mb-8 text-xl font-display italic leading-relaxed">"{t.quote}"</p>
                <div>
                  <p className="font-semibold text-sm tracking-wide uppercase text-[#162D42]">{t.author}</p>
                  <p className="text-sm text-muted-foreground mt-1 font-light">{t.role}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-32 px-6 bg-[#F7F2E4]" id="pricing">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="text-4xl sm:text-5xl font-display mb-6 text-[#162D42]">Simple, transparent pricing</h2>
            <p className="text-muted-foreground text-xl font-light">One price. Pay only for the sites you manage.</p>
          </div>
          <div className="max-w-md mx-auto">
            <div className="bg-[#162D42] text-white shadow-2xl p-12 flex flex-col rounded-none relative">
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/20 blur-[50px] pointer-events-none" />
              <h3 className="font-display text-3xl mb-2">Per site</h3>
              <p className="text-sm text-white/60 font-light mb-8">Scales with your business — one site or one hundred</p>
              <div className="flex items-baseline gap-2 mb-10 border-b border-white/10 pb-10">
                <span className="text-6xl font-display">£10</span>
                <span className="text-sm text-white/60 font-light tracking-wide">/ month</span>
              </div>
              <ul className="space-y-4 mb-10 flex-1">
                {PRICING_FEATURES.map(f => (
                  <li key={f} className="flex items-start gap-3 text-sm text-white/80 font-light leading-relaxed">
                    <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-primary" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Button
                onClick={() => navigate("/signup")}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground py-6 text-lg rounded-[2px]"
              >
                Start free trial
              </Button>
            </div>
          </div>
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
              <img src={alpsLogo} alt="Alps Consultancy" className="h-6 opacity-70 brightness-0 invert" />
            </div>
          </div>
          <p className="text-sm font-light">© {new Date().getFullYear()} Alps Consultancy. All rights reserved.</p>
          <button onClick={() => navigate("/login")} className="text-sm font-light hover:text-white transition-colors">Sign in</button>
        </div>
      </footer>
    </div>
  );
}

