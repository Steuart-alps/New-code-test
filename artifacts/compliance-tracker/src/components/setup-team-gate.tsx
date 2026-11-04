import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, UsersRound } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { onboardingRequest } from "@/lib/onboarding";

/** The team step of setup: Managers/Staff added, or the Owner said only Owners record for now. */
export type SetupTeam = { recorders: number; aloneAt: string | null; ready: boolean };
type SetupSummary = { needsSetup: boolean; canManage: boolean; team?: SetupTeam };

export const SETUP_STATE_KEY = "setup-state";

/**
 * Pages an Owner can use while the team step is still to do: setting up the
 * business (people, sites, departments, settings) and moving between
 * businesses. Every other page holds checklists or forms.
 */
const OPEN_BEFORE_TEAM = [
  "/dashboard", "/setup", "/users", "/staff-roster", "/settings", "/sites", "/categories", "/contractors",
  "/compliance-hub", "/account-security", "/privacy-governance", "/feedback", "/clients", "/portfolio", "/business-dashboard",
];

/**
 * True while a business being set up has nobody to record checks: no Manager
 * or Staff login, and no Owner confirmation that only Owners record for now.
 * Only Owners and consultants are ever held back (anyone else means the team
 * exists), and a finished setup never is.
 */
export function useTeamStepPending(): boolean {
  const { user, activeClientId } = useAuth();
  const isAdmin = user?.role === "consultant" || user?.role === "client_admin";
  const clientId = user?.role === "consultant" ? activeClientId : null;
  const { data } = useQuery<SetupSummary>({
    queryKey: [SETUP_STATE_KEY, clientId],
    queryFn: () => onboardingRequest<SetupSummary>("/setup/state", clientId),
    enabled: isAdmin,
    staleTime: 60_000,
  });
  return !!data && data.needsSetup && data.canManage && data.team?.ready === false;
}

/** Shows "Add your team first" in place of a checklist or form page until the team step is done. */
export function SetupTeamGate({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const pending = useTeamStepPending();
  const open = OPEN_BEFORE_TEAM.some((path) => location === path || location.startsWith(`${path}/`));
  if (!pending || open) return <>{children}</>;
  return (
    <section className="mx-auto max-w-xl rounded-xl border border-primary/30 bg-primary/5 p-6 space-y-4" aria-label="Add your team first">
      <div className="flex items-start gap-3">
        <UsersRound className="h-6 w-6 shrink-0 text-primary" />
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold">Add your team first</h2>
          <p className="text-sm text-muted-foreground">
            Before anyone fills in a checklist or form, add the people who will do the checks, so every record is in the name of the person who did it.
          </p>
          <p className="text-sm text-muted-foreground">
            If nobody else will sign in yet, you can say so on the same step and start recording straight away.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link href="/users" className="text-sm text-primary hover:underline px-2">Go to Users</Link>
        <Link href="/setup?step=team"
          className="inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          Add your team <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}
