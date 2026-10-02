import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "@/lib/api";

export function KitchenActionAudit({ actionId }: { actionId: string | number }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, refetch } = useQuery({
    enabled: open,
    queryKey: ["kitchen-action-audit", actionId], refetchInterval: 30_000,
    queryFn: async () => {
      const response = await apiFetch(`/audit-events?entityType=track_action&entityId=${actionId}`);
      if (!response.ok) throw new Error("The action history could not be loaded");
      return response.json() as Promise<{ id: number; actorName: string; action: string; createdAt: string; after?: { ownerName?: string; status?: string } }[]>;
    },
  });
  return <details className="my-2 text-xs" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer font-medium">Action audit history</summary>
    {isLoading ? <p>Loading history…</p> : isError ? <button type="button" onClick={() => void refetch()}>History could not be loaded — retry</button>
      : data?.map(event => <p key={event.id} className="py-1">{new Date(event.createdAt).toLocaleString("en-GB")} · {event.actorName || "Account no longer available"} · {event.action.replaceAll("_", " ")}{event.after?.ownerName ? ` · assigned to ${event.after.ownerName}` : ""}</p>)}
  </details>;
}