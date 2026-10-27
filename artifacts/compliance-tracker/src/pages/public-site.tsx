import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ShieldCheck, ArrowRight, CheckCircle2, Scale, Printer, MapPin, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildSignupPath } from "@/lib/signup-plan";
import alpsLogo from "@/assets/alps-logo.png";
import content from "@/content/public-pages.json";
import { copyrightNotice } from "@/lib/copyright";

// Public marketing pages: modules (/features), free printable logs
// (/templates) and pricing. Their wording lives in public-pages.json, which
// scripts/seo-pages.mjs also reads to prerender the same pages for crawlers.

type ModuleContent = (typeof content.modules)[number];
type TemplateContent = (typeof content.templates)[number];

const moduleBySlug = new Map(content.modules.map((m) => [m.slug, m]));
const templateBySlug = new Map(content.templates.map((t) => [t.slug, t]));

function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

function signupPathFor(module: ModuleContent) {
  return module.serviceKey ? buildSignupPath([module.serviceKey], false) : "/signup";
}

export function ConsultantPanel() {
  return (
    <section className="bg-[#162D42] text-white px-6 py-12 print:hidden">
      <div className="max-w-4xl mx-auto grid gap-6 md:grid-cols-[1fr_auto] md:items-center">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-white/60 mb-2">Want a consultant too?</p>
          <h2 className="font-display text-3xl mb-3 text-white">Real people on your site, backed up online</h2>
          <p className="text-white/75 leading-relaxed max-w-2xl">
            ComplyTrack is built by ALPS Consultancy. Our consultants visit your site and work as part of your
            management team, then use ComplyTrack to keep your records right between visits. Consultancy is a
            one-year agreement you can end with three months' notice if it isn't working out.
          </p>
        </div>
        <a
          href={content.consultancyUrl}
          className="inline-flex items-center justify-center gap-2 border border-white/40 px-6 py-3 rounded-[2px] hover:bg-white/10 transition-colors"
        >
          Meet ALPS Consultancy <ArrowRight className="w-4 h-4" />
        </a>
      </div>
    </section>
  );
}

function PublicLayout({ children }: { children: ReactNode }) {
  const [, navigate] = useLocation();
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="bg-[#162D42] text-white px-6 py-4 print:hidden">
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <span className="font-medium font-display text-lg tracking-wide">ComplyTrack</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <Link href="/features" className="text-white/75 hover:text-white">Modules</Link>
            <Link href="/templates" className="text-white/75 hover:text-white">Free templates</Link>
            <Link href="/pricing" className="text-white/75 hover:text-white">Pricing</Link>
            <Link href="/login" className="text-white/75 hover:text-white">Sign in</Link>
            <Button
              size="sm"
              className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-[2px]"
              onClick={() => navigate("/signup")}
            >
              Start free trial
            </Button>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <ConsultantPanel />
      <footer className="border-t border-border py-8 px-6 print:hidden">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row gap-4 sm:items-center sm:justify-between text-sm text-muted-foreground">
          <div className="flex items-center gap-3">
            <img src={alpsLogo} alt="ALPS Consultancy" className="h-5 opacity-70" />
            <span>{copyrightNotice()}</span>
          </div>
          <div className="flex flex-wrap gap-4">
            <Link href="/features" className="hover:text-foreground">Modules</Link>
            <Link href="/templates" className="hover:text-foreground">Free templates</Link>
            <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function PageIntro({ eyebrow, heading, summary }: { eyebrow: string; heading: string; summary: string }) {
  return (
    <div className="mb-10">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground mb-3">{eyebrow}</p>
      <h1 className="font-display text-4xl sm:text-5xl text-[#162D42] dark:text-foreground mb-4 text-balance">{heading}</h1>
      <p className="text-lg text-muted-foreground leading-relaxed max-w-3xl">{summary}</p>
    </div>
  );
}

function TrialButtons({ signupPath, showPricing = true }: { signupPath: string; showPricing?: boolean }) {
  const [, navigate] = useLocation();
  return (
    <div className="flex flex-col sm:flex-row gap-3 print:hidden">
      <Button
        size="lg"
        className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-[2px]"
        onClick={() => navigate(signupPath)}
      >
        Start 14-day free trial <ArrowRight className="w-4 h-4 ml-2" />
      </Button>
      {showPricing && (
        <Button size="lg" variant="outline" className="rounded-[2px]" onClick={() => navigate("/pricing")}>
          See pricing
        </Button>
      )}
    </div>
  );
}

function FeaturesIndex() {
  usePageTitle(content.index.features.title);
  return (
    <PublicLayout>
      <div className="max-w-5xl mx-auto px-6 py-14">
        <PageIntro eyebrow="ComplyTrack modules" heading={content.index.features.heading} summary={content.index.features.summary} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {content.modules.map((m) => (
            <Link
              key={m.slug}
              href={`/features/${m.slug}`}
              className="block border border-border bg-card p-5 hover:border-primary transition-colors"
            >
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{m.name}</p>
              <h2 className="font-display text-xl text-foreground mb-2">{m.heading}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{m.summary}</p>
            </Link>
          ))}
        </div>
      </div>
    </PublicLayout>
  );
}

function FeaturePage({ module }: { module: ModuleContent }) {
  usePageTitle(module.title);
  const templates = module.templates.map((slug) => templateBySlug.get(slug)).filter((t): t is TemplateContent => !!t);
  return (
    <PublicLayout>
      <div className="max-w-5xl mx-auto px-6 py-14 grid gap-12">
        <div>
          <PageIntro eyebrow={`${module.name} · £10 per site per month`} heading={module.heading} summary={module.summary} />
          <TrialButtons signupPath={signupPathFor(module)} />
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          <section className="min-w-0">
            <h2 className="font-display text-2xl text-foreground mb-4">What it records</h2>
            <ul className="grid gap-3">
              {module.records.map((r) => (
                <li key={r} className="flex gap-3 text-foreground/90">
                  <CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="min-w-0">
            <h2 className="font-display text-2xl text-foreground mb-4">The rules behind it</h2>
            <ul className="grid gap-3">
              {module.law.map((l) => (
                <li key={l} className="flex gap-3 text-foreground/90">
                  <Scale className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                  <span>{l}</span>
                </li>
              ))}
            </ul>
            {"scotland" in module && module.scotland && (
              <p className="mt-5 border-l-4 border-primary pl-4 text-sm text-muted-foreground leading-relaxed">
                <strong className="text-foreground">In Scotland: </strong>{module.scotland}
              </p>
            )}
          </section>
        </div>

        <section>
          <h2 className="font-display text-2xl text-foreground mb-4">Good for</h2>
          <div className="flex flex-wrap gap-2">
            {module.goodFor.map((g) => (
              <span key={g} className="inline-flex items-center gap-1.5 border border-border px-3 py-1.5 text-sm text-foreground/90">
                <MapPin className="w-3.5 h-3.5 text-muted-foreground" /> {g}
              </span>
            ))}
          </div>
        </section>

        {templates.length > 0 && (
          <section>
            <h2 className="font-display text-2xl text-foreground mb-2">Not ready to go digital?</h2>
            <p className="text-muted-foreground mb-4">Print a free paper version and start today.</p>
            <ul className="grid gap-2">
              {templates.map((t) => (
                <li key={t.slug}>
                  <Link href={`/templates/${t.slug}`} className="inline-flex items-center gap-2 text-primary hover:underline">
                    <FileText className="w-4 h-4" /> {t.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="text-sm text-muted-foreground">
          ComplyTrack helps you keep records. It does not replace the risk assessments and competent advice the law asks for.{" "}
          <Link href="/features" className="text-primary hover:underline">See all modules</Link>.
        </p>
      </div>
    </PublicLayout>
  );
}

function TemplatesIndex() {
  usePageTitle(content.index.templates.title);
  return (
    <PublicLayout>
      <div className="max-w-5xl mx-auto px-6 py-14">
        <PageIntro eyebrow="Free to print" heading={content.index.templates.heading} summary={content.index.templates.summary} />
        <div className="grid gap-4 sm:grid-cols-2">
          {content.templates.map((t) => (
            <Link key={t.slug} href={`/templates/${t.slug}`} className="block border border-border bg-card p-5 hover:border-primary transition-colors">
              <h2 className="font-display text-xl text-foreground mb-2">{t.name}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{t.summary}</p>
            </Link>
          ))}
        </div>
      </div>
    </PublicLayout>
  );
}

function TemplatePage({ template }: { template: TemplateContent }) {
  usePageTitle(template.title);
  const module = moduleBySlug.get(template.module);
  return (
    <PublicLayout>
      <div className="max-w-5xl mx-auto px-6 py-14 print:p-0 print:max-w-none">
        <div className="print:hidden">
          <PageIntro eyebrow="Free printable template" heading={template.heading} summary={template.summary} />
          <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-start mb-10">
            <ul className="grid gap-2 list-disc pl-5 text-foreground/90">
              {template.guidance.map((g) => <li key={g}>{g}</li>)}
            </ul>
            <Button size="lg" variant="outline" className="rounded-[2px]" onClick={() => window.print()}>
              <Printer className="w-4 h-4 mr-2" /> Print this log
            </Button>
          </div>
        </div>

        <section className="bg-white text-black border border-border p-6 print:border-0 print:p-0" aria-label={`${template.name} to print`}>
          <div className="flex items-baseline justify-between gap-4 mb-4">
            <h2 className="font-display text-2xl">{template.name}</h2>
            <span className="text-xs text-neutral-500">complytrack.alpsconsultancy.co.uk</span>
          </div>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 mb-5 text-sm">
            {template.fields.map((f) => (
              <div key={f} className="flex items-end gap-2">
                <span className="font-medium whitespace-nowrap">{f}:</span>
                <span className="flex-1 border-b border-neutral-400 h-5" />
              </div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {template.columns.map((c) => (
                    <th key={c} className="border border-neutral-400 bg-neutral-100 px-2 py-2 text-left font-semibold align-bottom">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: template.rows }, (_, i) => (
                  <tr key={i}>
                    {template.columns.map((c) => <td key={c} className="border border-neutral-400 h-9 px-2" />)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {module && (
          <div className="mt-10 border border-border bg-card p-6 print:hidden">
            <h2 className="font-display text-2xl text-foreground mb-2">Do this on your phone instead</h2>
            <p className="text-muted-foreground mb-5 max-w-3xl">
              {module.name} keeps these records on a phone, reminds staff when the next check is due, and keeps the full
              history ready for an inspector. £10 per site per month, monthly, with a 14-day free trial.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <TrialButtons signupPath={signupPathFor(module)} />
              <Link href={`/features/${module.slug}`} className="inline-flex items-center text-primary hover:underline px-2">
                About {module.name}
              </Link>
            </div>
          </div>
        )}
      </div>
    </PublicLayout>
  );
}

function PricingPage() {
  usePageTitle(content.index.pricing.title);
  const rows: [string, string][] = [
    ["ComplyTrack Core", "£10 per site per month. Compliance checks, contractor certificates, reminders, multiple sites and team access."],
    ["Each module", "£10 per site per month. FireTrack, KitchenTrack, LegionellaTrack, TubTrack, GreenTrack and the rest."],
    ["ComplyTrack Complete", "£50 per site per month. Every module, including new ones as they launch."],
  ];
  return (
    <PublicLayout>
      <div className="max-w-5xl mx-auto px-6 py-14 grid gap-10">
        <div>
          <PageIntro eyebrow="Pricing" heading={content.index.pricing.heading} summary={content.index.pricing.summary} />
          <TrialButtons signupPath="/signup" showPricing={false} />
        </div>
        <div className="border border-border bg-card divide-y divide-border">
          {rows.map(([name, detail]) => (
            <div key={name} className="grid gap-1 sm:grid-cols-[14rem_1fr] p-5">
              <h2 className="font-display text-xl text-foreground">{name}</h2>
              <p className="text-muted-foreground">{detail}</p>
            </div>
          ))}
        </div>
        <ul className="grid gap-3 text-foreground/90">
          {[
            "Prices exclude VAT.",
            "Every new business gets a 14-day free trial. No card needed to start.",
            "Billed monthly. Cancel any time and the cancellation takes effect at the end of the month you have paid for.",
            "You pay per site, so a business with one site pays for one site.",
          ].map((t) => (
            <li key={t} className="flex gap-3"><CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" /> <span>{t}</span></li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Want help on site as well? ALPS consultants can include ComplyTrack as part of a consultancy agreement.{" "}
          <a href={content.consultancyUrl} className="text-primary hover:underline">Find out about ALPS Consultancy</a>.
        </p>
      </div>
    </PublicLayout>
  );
}

/** Routes /features, /templates and /pricing (and their sub-pages). */
export default function PublicSitePage({ location }: { location: string }) {
  const path = location.replace(/\/+$/, "") || "/";
  if (path === "/pricing") return <PricingPage />;
  if (path === "/features") return <FeaturesIndex />;
  if (path === "/templates") return <TemplatesIndex />;
  const featureSlug = path.match(/^\/features\/([^/]+)$/)?.[1];
  const module = featureSlug ? moduleBySlug.get(featureSlug) : undefined;
  if (module) return <FeaturePage module={module} />;
  const templateSlug = path.match(/^\/templates\/([^/]+)$/)?.[1];
  const template = templateSlug ? templateBySlug.get(templateSlug) : undefined;
  if (template) return <TemplatePage template={template} />;
  return <FeaturesIndex />;
}

