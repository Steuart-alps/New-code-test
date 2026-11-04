import { Snowflake } from "lucide-react";
import { getGetFrostWarningsQueryKey, useGetFrostWarnings } from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";

function temperature(celsius: number): string {
  const rounded = Math.round(celsius);
  return `${rounded < 0 ? "−" : ""}${Math.abs(rounded)}°C`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * "Frost tonight": shown from the afternoon forecast check until midday the
 * next day for sites whose overnight low is below 4°C. Not tied to a track.
 */
export function FrostWarningCard({ siteId }: { siteId: number | null }) {
  const { activeClientId } = useAuth();
  const params = siteId == null ? undefined : { siteId };
  const { data } = useGetFrostWarnings(params, {
    query: { retry: false, staleTime: 10 * 60_000, queryKey: [...getGetFrostWarningsQueryKey(params), activeClientId] },
  });
  const warnings = data?.warnings ?? [];
  if (!data || !warnings.length) return null;
  return (
    <div role="status" className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
      <div className="flex items-start gap-3">
        <Snowflake className="h-5 w-5 mt-0.5 shrink-0 text-sky-600 dark:text-sky-300" aria-hidden="true" />
        <div className="min-w-0 space-y-1.5">
          <p className="font-semibold text-sm">
            Frost tonight{warnings.length === 1 ? ` at ${warnings[0]!.siteName}` : ""}: grit and de-ice
          </p>
          {warnings.length > 1 ? (
            <ul className="text-sm space-y-0.5">
              {warnings.map((warning) => (
                <li key={warning.siteId}>
                  <span className="font-medium">{warning.siteName}</span>: down to {temperature(warning.lowestC)}
                  {warning.coldestAt ? ` around ${time(warning.coldestAt)}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">
              The forecast drops to {temperature(warnings[0]!.lowestC)}
              {warnings[0]!.coldestAt ? ` around ${time(warnings[0]!.coldestAt)}` : ""}.
            </p>
          )}
          <p className="text-sm">
            Grit paths, steps, ramps, entrances and the car park before you finish, and check again first thing.
          </p>
          <p className="text-xs text-sky-800/70 dark:text-sky-200/70">{data.credit}</p>
        </div>
      </div>
    </div>
  );
}
