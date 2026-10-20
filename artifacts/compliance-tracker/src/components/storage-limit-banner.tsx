import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useGetStorageStatus } from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";

const DISMISS_KEY = "complytrack.storageNearlyFullDismissed";

function formatGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${Number(gb.toFixed(gb >= 10 ? 0 : 1))} GB`;
}

function readDismissed(clientId: number | null): boolean {
  try {
    return clientId !== null && window.sessionStorage.getItem(DISMISS_KEY) === String(clientId);
  } catch {
    return false;
  }
}

/**
 * Tells people when the business's storage is full (uploads have stopped) or,
 * for owners, nearly full. Staff only see the full state, with who to ask;
 * owners can hide the nearly-full notice for the rest of the session. Nothing
 * shows while automatic top-up is on and storage is merely nearly full.
 */
export function StorageLimitBanner() {
  const { activeClientId } = useAuth();
  const [dismissed, setDismissed] = useState(() => readDismissed(activeClientId));
  const statusQuery = useGetStorageStatus({
    query: {
      queryKey: ["/api/storage/status", activeClientId],
      enabled: activeClientId !== null,
      retry: false,
      staleTime: 60_000,
      refetchInterval: 5 * 60_000,
    },
  });
  const status = statusQuery.data;
  if (!status || activeClientId === null) return null;

  if (status.state === "full") {
    return (
      <div role="status" data-testid="storage-limit-banner" className="flex flex-col gap-3 rounded-md border border-red-300 bg-red-50 p-4 text-red-950 sm:flex-row sm:items-center sm:justify-between dark:border-red-800 dark:bg-red-950/40 dark:text-red-100">
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="text-sm">
            <strong>Storage is full, so new photos and documents can't be uploaded.</strong>{" "}
            {status.canManage
              ? "Nothing has been deleted. Add storage, or switch on automatic top-up, to start uploading again."
              : "Nothing has been deleted. Please ask an owner of this business to add more storage."}
          </p>
        </div>
        {status.canManage && (
          <a href="/settings#storage" className="shrink-0 text-sm font-semibold underline underline-offset-2">
            Add storage
          </a>
        )}
      </div>
    );
  }

  if (status.state !== "nearly_full" || !status.canManage || status.autoTopUp || dismissed) return null;
  const figures = status.usedBytes != null && status.capacityBytes != null
    ? ` You're using ${formatGb(status.usedBytes)} of ${formatGb(status.capacityBytes)}.`
    : "";
  const dismiss = () => {
    setDismissed(true);
    try { window.sessionStorage.setItem(DISMISS_KEY, String(activeClientId)); } catch { /* private mode */ }
  };
  return (
    <div role="status" data-testid="storage-limit-banner" className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:flex-row sm:items-center sm:justify-between dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        <p className="text-sm">
          <strong>Storage is nearly full.</strong>{figures} When it's full, new uploads will stop until storage is added.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <a href="/settings#storage" className="text-sm font-semibold underline underline-offset-2">
          Manage storage
        </a>
        <button type="button" onClick={dismiss} aria-label="Hide until next time" className="rounded p-1 hover:bg-amber-100 dark:hover:bg-amber-900/40">
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
