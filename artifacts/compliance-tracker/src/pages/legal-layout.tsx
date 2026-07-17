import { ReactNode } from "react";
import { useLocation } from "wouter";
import { ShieldCheck, ArrowLeft } from "lucide-react";
import alpsLogo from "@/assets/alps-logo.png";

export function LegalLayout({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  const [, navigate] = useLocation();
  return (
    <div className="min-h-screen bg-background">
      <header className="bg-[#162D42] text-white px-6 py-5">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <button onClick={() => navigate("/")} className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <span className="font-medium font-display text-lg tracking-wide">ComplyTrack</span>
          </button>
          <img src={alpsLogo} alt="Alps Consultancy" className="h-6 opacity-70 brightness-0 invert" />
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-12">
        <button
          onClick={() => navigate("/")}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4" /> Back to home
        </button>
        <h1 className="font-display text-4xl text-foreground mb-2">{title}</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: {updated}</p>
        <div className="space-y-8 text-[15px] leading-relaxed text-foreground/90 [&_h2]:font-display [&_h2]:text-2xl [&_h2]:text-foreground [&_h2]:mb-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1.5 [&_p+p]:mt-3">
          {children}
        </div>
      </main>
      <footer className="border-t border-border py-8 px-6 mt-8">
        <p className="max-w-3xl mx-auto text-sm text-muted-foreground">
          © {new Date().getFullYear()} ALPS Consulting Ltd. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
