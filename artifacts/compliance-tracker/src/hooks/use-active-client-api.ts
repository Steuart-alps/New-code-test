import { useCallback } from "react";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";

/**
 * Adds the consultant's selected tenant to every API request. The server still
 * derives and authorises client context through its normal query middleware.
 */
export function useActiveClientApi() {
  const { activeClientId } = useAuth();
  return useCallback((path: string, init?: RequestInit) => {
    const separator = path.includes("?") ? "&" : "?";
    const tenantPath = activeClientId
      ? `${path}${separator}clientId=${encodeURIComponent(activeClientId)}`
      : path;
    return apiFetch(tenantPath, init);
  }, [activeClientId]);
}