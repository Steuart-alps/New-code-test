import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeftRight, Building2 } from "lucide-react";
import { useAuth, type AuthClient } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";

/**
 * The business a consultant has open. `client` from /auth/me is always the
 * consultant's own business, so this loads the one they switched to. Null for
 * everyone else, and while it loads.
 */
export function useOpenBusiness(): AuthClient | null {
  const { user, activeClientId } = useAuth();
  const { data } = useQuery<AuthClient | null>({
    queryKey: ["open-business", user?.id, activeClientId],
    enabled: user?.role === "consultant" && activeClientId !== null,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const response = await apiFetch(`/clients/${activeClientId}`);
      return response.ok ? response.json() : null;
    },
  });
  return user?.role === "consultant" && data?.id === activeClientId ? data : null;
}

/**
 * "You are working in <business>" strip for consultants, on every screen size,
 * so they always know which client they are entering records for.
 */
export function OpenBusinessBanner() {
  const business = useOpenBusiness();
  if (!business) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-sm border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-[#162D42]"
      data-testid="open-business-banner"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Building2 className="h-4 w-4 shrink-0 text-sky-700" />
        <span className="min-w-0">You are working in <strong className="break-words">{business.name}</strong></span>
      </span>
      <Link href="/clients" className="flex items-center gap-1.5 text-xs font-semibold underline underline-offset-2">
        <ArrowLeftRight className="h-3.5 w-3.5" /> Switch client
      </Link>
    </div>
  );
}
