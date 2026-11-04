import { useState, useSyncExternalStore, type ComponentType } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft, ArrowRight, BarChart2, Bell, Building2, CheckCircle2, ClipboardCheck, ClipboardList, Clock, FileUp, GraduationCap, HardHat,
  KeyRound, LayoutDashboard, ListChecks, ListOrdered, Menu, Network, PenLine, Sparkles, Users,
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
  // Owners and ALPS consultants set the business up; Managers look after their
  // own departments' team and checklist times; Staff record; Viewers only see
  // their own training (they never reach the main app, see App.tsx).
  const owner = role === "consultant" || role === "client_admin";
  const headOfDept = role === "client_manager";
  const viewer = role === "client_viewer";

  const welcome: Step = {
    icon: GraduationCap,
    title: "Welcome to ComplyTrack",
    body: owner
      ? [
        "This tour starts with setting up your business, in the order that works best, then shows you round the app. It takes a few minutes.",
        "You can skip it now and open it again any time from Quick tutorial in the menu.",
      ]
      : [
        "This quick tour shows you where everything is. It takes about a minute.",
        "You can skip it now and open it again any time from Quick tutorial in the menu.",
      ],
  };

  // ── Setting up (Owners and ALPS) ──────────────────────────────────────────
  const setupOrder: Step = {
    icon: ListOrdered,
    title: "Set up in this order",
    body: [
      "1. Sites  2. Departments  3. Your team (users and staff roster)  4. Contractors  5. Upload your lists  6. Checklist due times.",
      "The setup guide takes you through the first steps, and everything stays under Set up in the menu so you can come back to it.",
      "Would rather we did it? ALPS can set everything up for you from your own lists: ask on the first page of the setup guide.",
    ],
    links: [{ href: "/setup", label: "Open the setup guide" }],
  };
  const sites: Step = {
    icon: Building2,
    title: "1. Your sites",
    body: [
      "Add each location you look after under Sites, for example a clubhouse, hotel or second branch. Records, checklists and reports are kept per site.",
      "Put the full address with the postcode. ComplyTrack uses it to warn you the afternoon before a frosty night, so you can grit and de-ice.",
    ],
    links: [{ href: "/sites", label: "Open Sites" }],
  };
  const departments: Step = {
    icon: Network,
    title: "2. Departments",
    body: [
      "Split each site into the teams that do the work, for example Kitchen, Housekeeping, Maintenance or Greenkeeping. You'll find them under Settings, in Departments.",
      "Staff then see the checks for their own department, and the dashboard shows a bar for each one.",
    ],
    links: [{ href: "/settings", label: "Open Settings" }],
  };
  const users: Step = {
    icon: Users,
    title: "3. Your team: users and roles",
    body: [
      "Add your team under Users before you start recording, so every check is in a real person's name. Each person is emailed a link to set their own password.",
      "Pick a role for each: Owner (everything, including billing), Manager (head of one or more departments), Staff (records checks for their department) or Viewer (sees and signs off only their own training).",
    ],
    links: [{ href: "/users", label: "Open Users" }],
  };
  const roster: Step = {
    icon: ClipboardList,
    title: "3. Your team: the staff roster",
    body: [
      "The Staff Roster lists everyone who works for you, at each site, including people who never sign in. Training records hang off it.",
      "Roster names can be picked as the person who did a check. Upload your existing staff list rather than typing it in.",
    ],
    links: [{ href: "/staff-roster", label: "Open Staff Roster" }],
  };
  const contractors: Step = {
    icon: HardHat,
    title: "4. Contractors",
    body: [
      "Add the contractors who service your gas, electrics, fire alarm, lifts and so on under Contractors, with their trade and email.",
      "Each track has a Contractor checks box: choose who does each check, or press N/A if you don't need one. ComplyTrack emails them reminders with a link to upload the certificate.",
      "A check stays red until its certificate is in.",
    ],
    links: [{ href: "/contractors", label: "Open Contractors" }],
  };
  const uploadLists: Step = {
    icon: FileUp,
    title: "5. Upload your lists",
    body: [
      "Already have lists in a spreadsheet? Drop them all in at once under Upload your lists: contractors, staff, rooms, PAT appliances, fire call points, machinery and more. You check each one before it is saved.",
      "Have a compliance checklist spreadsheet already? Use Import spreadsheet on the Compliance Checks page and it is read as it is, one line per check.",
      "With the AI add-on you can also upload a photo or PDF of a paper list.",
    ],
    links: [{ href: "/upload-lists", label: "Open Upload your lists" }],
  };
  const dueTimes: Step = {
    icon: Clock,
    title: owner ? "6. Checklist due times" : "Checklist due times",
    body: [
      "Opening checks are due by 06:00 and closing checks by 18:00 unless you change them. Set each site's own times with Change, at the top of the opening and closing checklists.",
      "Checks show as overdue, and reminders go out, from the times you set.",
    ],
  };
  const ai: Step = {
    icon: Sparkles,
    title: "The AI add-on",
    body: [
      "The AI add-on reads things for you: photos or PDFs of lists, contractor certificates, audit reports (turning them into actions) and supplier allergen sheets.",
      "Turn it on under Settings, in AI features. It is charged per business each month with a monthly allowance; anything unused carries over for up to 12 months. Everything else works without it.",
    ],
    links: [{ href: "/settings", label: "Open Settings" }],
  };

  // ── Using the app ─────────────────────────────────────────────────────────
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
        "The dashboard shows today's status for every module you use: green is up to date, amber needs attention soon and red is overdue. Every bar and count opens the checks behind it.",
        "If you have more than one site, pick a site at the top to see just that one.",
      ],
    };
  const modules: Step = {
    icon: Menu,
    title: "Modules live in the menu",
    body: [
      "Each area of compliance has its own module, for example FireTrack for fire alarm tests and KitchenTrack for food temperatures. Golf clubs find GreenTrack and the greenkeeping checks under Greenkeeping.",
      "Find them in the menu on the left. On a phone, tap the menu button (three lines) at the top left.",
      owner
        ? "A padlock means a module isn't in your plan yet. You can add it under Settings, in Billing & Subscription."
        : "A padlock means your business doesn't use that module yet. Ask your manager if you need it.",
    ],
  };
  const record: Step = {
    icon: ClipboardCheck,
    title: "Recording a check",
    body: [
      "Open a module, use its button to log a check, fill in the form and save. Pass all ticks every item you haven't answered as a Pass. Any Fail needs a corrective action.",
      "Add photos or videos to any record, or press Say it and speak the check instead of typing.",
      "Every record is signed with your finger or mouse when you save, and keeps who did it and when.",
    ],
  };
  const changing: Step = {
    icon: PenLine,
    title: "Changing a record",
    body: [
      owner || headOfDept
        ? "Staff can change daily records on the day and the day after. After that, an Owner can still correct a record by giving a reason, and the change is kept in its history."
        : "You can change your daily records on the day and the day after. After that, ask your manager to correct them.",
    ],
  };
  const managerTeam: Step = {
    icon: Users,
    title: "Your team",
    body: [
      "As a Manager you can add and remove the Staff and Viewers in your own departments under Users.",
      "If you look after several departments, switch between them at the top of the page.",
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
      ...(owner ? ["As an owner you can also make it required for everyone in your business, under Settings in Two-factor requirement."] : []),
    ],
    links: [
      ...(totpEnabled ? [] : [{ href: "/account-security", label: "Set up two-step sign-in" }]),
      ...(owner ? [{ href: "/settings", label: "Open Settings" }] : []),
    ],
  };
  const reminders: Step = {
    icon: Bell,
    title: "Reminders and warnings",
    body: [
      "The bell at the top of the page shows your reminders and alerts. Reminders go to the person a check is given to, so nobody is flooded with emails.",
      owner
        ? "Urgent problems reach Managers and Owners the same day, and Owners get a regular summary. If a frosty night is forecast, a frost warning appears on the dashboard that afternoon."
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

  if (viewer) {
    const training: Step = {
      icon: GraduationCap,
      title: "Your training records",
      body: [
        "Your account shows your own training records. When a course or document needs signing off, open it and sign.",
        "Ask your manager if something is missing.",
      ],
    };
    return [welcome, training, security, done];
  }
  if (owner) {
    return [
      welcome, setupOrder, sites, departments, users, roster, contractors, uploadLists, dueTimes, ai,
      dashboard, modules, record, changing, security, reminders, reports, done,
    ];
  }
  if (headOfDept) return [welcome, dashboard, modules, record, changing, managerTeam, dueTimes, security, reminders, reports, done];
  return [welcome, dashboard, modules, record, changing, security, reminders, done];
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
      <DialogContent className="max-w-md rounded-sm max-h-[90dvh] overflow-y-auto" data-testid="quick-tutorial">
        <div className="flex flex-col items-center text-center gap-3 pt-2">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <Icon className="h-7 w-7 text-primary" />
          </div>
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Quick tutorial · {index + 1} of {steps.length}
          </p>
          <DialogTitle className="font-display font-bold text-xl">{step.title}</DialogTitle>
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
