import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";

/**
 * Per-client customisable form dropdown vocabularies.
 *
 * The API returns the effective option list for every whitelisted key (the
 * client's custom list where saved, otherwise the hardcoded default), plus the
 * defaults themselves so the editor can offer a "reset to default".
 */
export type FormOptionKey =
  | "incident_types"
  | "incident_severities"
  | "fixtrack_issue_types"
  | "fixtrack_trades"
  | "premises_inspection_types"
  | "traintrack_types"
  | "pest_types"
  | "pest_evidence_types"
  | "bike_types";

export interface FormOptionsResponse {
  options: Record<string, string[]>;
  defaults: Record<string, string[]>;
  customised: Record<string, boolean>;
}

/** Route every request through the shared, active-client-aware apiFetch. */
export function useFormOptionsApi() {
  const { activeClientId } = useAuth();
  return async function call<T = any>(path: string, opts?: RequestInit): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const suffix = activeClientId ? `${sep}clientId=${activeClientId}` : "";
    const res = await apiFetch(`/form-options${path}${suffix}`, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error ?? `Request failed (${res.status})`);
    }
    if (res.status === 204) return null as T;
    return res.json();
  };
}

export function useFormOptions() {
  const { activeClientId } = useAuth();
  const call = useFormOptionsApi();
  return useQuery<FormOptionsResponse>({
    queryKey: ["form-options", activeClientId],
    queryFn: () => call(""),
    enabled: !!activeClientId,
  });
}

/** Convenience accessor for one list; falls back to an empty array while loading. */
export function pickOptions(data: FormOptionsResponse | undefined, key: FormOptionKey): string[] {
  return data?.options?.[key] ?? [];
}
