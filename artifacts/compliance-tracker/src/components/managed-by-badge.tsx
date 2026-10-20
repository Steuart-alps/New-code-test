import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/auth-context";
import { API_BASE, apiFetch } from "@/lib/api";

interface ManagedBy { practiceName: string; hasLogo: boolean; updatedAt: string }

/**
 * "Managed by <practice>" strip for people in a business linked to a
 * consultant who has set practice branding. Consultants never see it (it is
 * their own branding); nothing renders when no branding is set.
 */
export function ManagedByBadge() {
  const { user, activeClientId } = useAuth();
  const [logoFailed, setLogoFailed] = useState(false);
  const enabled = !!user && user.role !== "consultant";
  const { data } = useQuery<ManagedBy | null>({
    queryKey: ["managed-by", user?.id, activeClientId],
    enabled,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const response = await apiFetch("/managed-by");
      return response.ok ? response.json() : null;
    },
  });
  if (!enabled || !data?.practiceName) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="managed-by">
      {data.hasLogo && !logoFailed && (
        <img
          src={`${API_BASE}/managed-by/logo?v=${encodeURIComponent(data.updatedAt)}`}
          alt=""
          className="h-6 w-auto max-w-[96px] object-contain"
          onError={() => setLogoFailed(true)}
        />
      )}
      <span className="min-w-0 truncate">Managed by <span className="font-medium text-foreground">{data.practiceName}</span></span>
    </div>
  );
}
