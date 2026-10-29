import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLocation } from "wouter";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VoiceLogDialog } from "@/components/voice-log-dialog";
import { useAuth } from "@/context/auth-context";
import { actionTracks, trackForPath } from "@/lib/voice-actions";
import { cn } from "@/lib/utils";

// The site a page is showing, so Say it in the top bar starts on it.
let pageSite: number | null = null;
const siteListeners = new Set<() => void>();
const setPageSite = (siteId: number | null) => {
  if (pageSite === siteId) return;
  pageSite = siteId;
  siteListeners.forEach((listener) => listener());
};
const subscribeSite = (listener: () => void) => {
  siteListeners.add(listener);
  return () => { siteListeners.delete(listener); };
};

/** Tell Say it which site this page is showing (null for all sites). */
export function useSayItSite(siteId: number | null | undefined) {
  useEffect(() => {
    setPageSite(siteId ?? null);
    return () => setPageSite(null);
  }, [siteId]);
}

/**
 * "Say it" button: speak a reading (fridge, cooking temperature, call point
 * test, water outlet temperature) or something that needs doing on the
 * page's track, and check it on a card before it is saved. Shown to anyone
 * who can record on at least one track; viewers are read-only and never see it.
 */
export function SayItButton({ siteId, className, compact = false }: {
  siteId?: number | null;
  className?: string;
  /** The small top-bar version. */
  compact?: boolean;
}) {
  const { user, hasService } = useAuth();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const shownSite = useSyncExternalStore(subscribeSite, () => pageSite);
  const pageTrack = trackForPath(location);
  const canAct = useMemo(() => actionTracks(hasService, user?.role).length > 0, [hasService, user?.role]);
  const anyTrack = canAct || hasService("kitchentrack") || hasService("firetrack") || hasService("legionellatrack");
  if (!user || user.role === "client_viewer" || !anyTrack) return null;
  return (
    <>
      <Button type="button" variant="outline" size={compact ? "sm" : "default"}
        className={cn("gap-2", compact && "h-9 gap-1.5 border-[#162D42]/30 px-2.5 text-[#162D42]", className)}
        onClick={() => setOpen(true)} data-testid="say-it-button" title="Say a reading or something that needs doing">
        <Mic className="h-4 w-4" />Say it
      </Button>
      <VoiceLogDialog open={open} onClose={() => setOpen(false)} defaultSiteId={siteId === undefined ? shownSite : siteId} pageTrack={pageTrack} />
    </>
  );
}
