import { useState, useSyncExternalStore, type ComponentType } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft, ArrowRight, Bell, CheckCircle2, ClipboardCheck, GraduationCap, KeyRound, LayoutDashboard, ListChecks, Menu, BarChart2, Users,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth, type AuthUser } from "@/context/auth-context";
import { cn } from "@/lib/utils";

/**
 * Quick tutorial: a short, skippable walk round the app. It opens by itself
 * the first time someone reaches the dashboard (after the setup wizard for
 * managers) and can be reopened from "Quick tutorial" in the menu. "Seen" is
 * remembered per user in this browser, like the track guidance banner.
 */

const SEEN_KEY = "complytrack:quickTutorialSeen";

// A tiny store so the dashboard can open the tutorial before (or without)
// the layout's listener mounting first: child effects run before parents'.
let open = false;
const listeners = new Set<() => void>();
function setOpen(next: boolean) {
  open = next;
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function openQuickTutorial() {
  setOpen(true);
}

function seenKey(userId: number) {
  return `${SEEN_KEY}:${userId}`;
}

export function hasSeenQuickTutorial(userId: number): boolean {
  try {
    return window.localStorage.getItem(seenKey(userId)) === "true";
  } catch {
    return true; // Storage unavailable: don't reopen it on every page load.
  }
}

function markSeen(userId: number) {
  try {
    window.localStorage.setItem(seenKey(userId), "true");
  } catch {
    // Storage unavailable: it simply may show again next visit.
  }
}

/** Opens the tutorial once for a user who has not seen it on this browser. */
export function showQuickTutorialIfNew(userId: number) {
  if (!hasSeenQuickTutorial(userId)) openQuickTutorial();
}

type Step = {
  icon: ComponentType<{ className?: string }>;
  title: string;
  body: string[];
  links?: { href: string; label: string }[];
};

export function getQuickTutorialSteps({ role, totpEnabled }: Pick<AuthUser, "role" | "totpEnabled">): Step[] {
  const manager = role === "consultant" || role === "client_admin";
  const viewer = role === "client_viewer";

  const welcome: Step = {
    icon: GraduationCap,
    title: "Welcome to ComplyTrack",
    body: [
      "This quick tour shows you where everything is. It takes about a minute.",
      "You can skip it now and open it again any time from Quick tutorial in the menu.",
    ],
  };
  const dashboard: Step = role === "client_staff"
    ? {
      icon: ListChecks,
      title: "Your tasks for today",
      body: [
        "Your dashboard starts with My tasks today: the checks your manager has given you. Tick each one off when it's done.",
        "Below that, each module shows its status: green is up to date, amber needs attention soon and red is overdue.",
      ],
      links: [{ href: "/tasks", label: "Open my tasks" }],
    }
    : {
      icon: LayoutDashboard,
      title: "Your dashboard",
      body: [
        "The dashboard shows today's status for every module you use: green is up to date, amber needs attention soon and red is overdue.",
        "Click a row to open that module. If you have more than one site, pick a site at the top to see just that one.",
      ],
    };
  const modules: Step = {
    icon: Menu,
    title: "Modules live in the menu",
    body: [
      "Each area of compliance has its own module, for example FireTrack for fire alarm tests and KitchenTrack for food temperatures.",
      "Find them in the menu on the left. On a phone, tap the menu button (three lines) at the top left.",
      manager
        ? "A padlock means a module isn't in your plan yet. You can add it under Settings, in Billing & Subscription."
        : "A padlock means your business doesn't use that module yet. Ask your manager if you need it.",
    ],
  };
  const record: Step = viewer
    ? {
      icon: ClipboardCheck,
      title: "Looking at records",
      body: [
        "Open any module to see its records and history.",
        "Your account can view records but not add or change them.",
      ],
    }
    : {
      icon: ClipboardCheck,
      title: "Recording a check",
      body: [
        "Open a module, use its button to log a check or add a record, fill in the form and save. Each record keeps who did it and when.",
        manager
          ? "Staff can change daily records on the day and the day after. After that, you can still correct a record by giving a reason, and the change is kept in its history."
          : "You can change your daily records on the day and the day after. After that, ask your manager to correct them.",
      ],
    };
  const team: Step = {
    icon: Users,
    title: "Bring in your team",
    body: [
      "Invite your staff under Users so they can sign in and log checks themselves. Each person sees their own tasks for the day.",
      "Have more than one location? Add each one under Sites.",
    ],
    links: [{ href: "/users", label: "Open Users" }],
  };
  const security: Step = {
    icon: KeyRound,
    title: "Keep your account safe",
    body: [
      totpEnabled
        ? "Two-step sign-in is on for your account: when you sign in, you type the 6-digit code from your authenticator app as well as your password."
        : "Turn on two-step sign-in so a stolen password isn't enough to get in. You scan a code with an authenticator app on your phone, such as Microsoft Authenticator or Google Authenticator, then type the 6-digit code it shows each time you sign in.",
      "You'll find it under Security at the top of the page. On a phone, tap your initials at the top right.",
      ...(manager ? ["As an owner you can also make it required for everyone in your business, under Settings in Two-factor requirement."] : []),
    ],
    links: [
      ...(totpEnabled ? [] : [{ href: "/account-security", label: "Set up two-step sign-in" }]),
      ...(manager ? [{ href: "/settings", label: "Open Settings" }] : []),
    ],
  };
  const reminders: Step = {
    icon: Bell,
    title: "Reminders",
    body: [
      "The bell at the top of the page shows your reminders and alerts.",
      manager
        ? "ComplyTrack also emails reminders about checks that are coming up or overdue, so nothing slips."
        : "Check it at the start of your shift to see what needs doing.",
    ],
  };
  const reports: Step = {
    icon: BarChart2,
    title: "Reports for inspections",
    body: [
      "Reports pulls your records together, ready to show an inspector, insurer or head office, and you can download them.",
    ],
    links: [{ href: "/reports", label: "Open Reports" }],
  };
  const done: Step = {
    icon: CheckCircle2,
    title: "You're ready to go",
    body: [
      "Need a hand or spotted something wrong? Use Submit feedback at the bottom of the menu to reach the ALPS team.",
      "You can open this tutorial again any time from Quick tutorial in the menu.",
    ],
  };

  if (manager) return [welcome, dashboard, modules, record, team, security, reminders, reports, done];
  return [welcome, dashboard, modules, record, security, reminders, done];
}

export function QuickTutorial() {
  const { user } = useAuth();
  const isOpen = useSyncExternalStore(subscribe, () => open, () => false);
  const [index, setIndex] = useState(0);
  const [, navigate] = useLocation();
  if (!user) return null;

  const steps = getQuickTutorialSteps(user);
  const step = steps[Math.min(index, steps.length - 1)];
  const isFirst = index === 0;
  const isLast = index >= steps.length - 1;
  const Icon = step.icon;

  function close() {
    markSeen(user!.id);
    setOpen(false);
    setIndex(0);
  }

  function goTo(href: string) {
    close();
    navigate(href);
  }

  return (
    <Dialog open={isOpen} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="max-w-md rounded-sm" data-testid="quick-tutorial">
        <div className="flex flex-col items-center text-center gap-3 pt-2">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <Icon className="h-7 w-7 text-primary" />
          </div>
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Quick tutorial · {index + 1} of {steps.length}
          </p>
          <DialogTitle className="font-display text-xl">{step.title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
              {step.body.map((line) => <p key={line}>{line}</p>)}
            </div>
          </DialogDescription>
          {step.links && step.links.length > 0 && (
            <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
              {step.links.map((link) => (
                <button key={link.href} type="button" onClick={() => goTo(link.href)}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary underline underline-offset-2">
                  {link.label} <ArrowRight className="h-4 w-4" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-center gap-1.5 pt-2" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.title} className={cn("h-1.5 rounded-full transition-all", i === index ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30")} />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 pt-2">
          {isLast ? <span /> : (
            <Button variant="ghost" size="sm" onClick={close} data-testid="quick-tutorial-skip">Skip tutorial</Button>
          )}
          <div className="flex gap-2">
            {!isFirst && (
              <Button variant="outline" size="sm" onClick={() => setIndex((i) => i - 1)}>
                <ArrowLeft className="mr-1 h-4 w-4" /> Back
              </Button>
            )}
            {isLast ? (
              <Button size="sm" onClick={close} data-testid="quick-tutorial-finish">Finish</Button>
            ) : (
              <Button size="sm" onClick={() => setIndex((i) => i + 1)} data-testid="quick-tutorial-next">
                Next <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
