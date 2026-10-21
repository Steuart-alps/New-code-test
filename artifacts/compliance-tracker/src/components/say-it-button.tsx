import { useState } from "react";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VoiceLogDialog } from "@/components/voice-log-dialog";
import { useAuth } from "@/context/auth-context";
import { cn } from "@/lib/utils";

/**
 * "Say it" button: speak a reading (fridge, cooking temperature, call point
 * test, water outlet temperature) and check it on a card before it is saved.
 * Shown to anyone who can record checks in KitchenTrack, FireTrack or
 * Legionella; viewers are read-only and never see it.
 */
export function SayItButton({ siteId, className }: { siteId?: number | null; className?: string }) {
  const { user, hasService } = useAuth();
  const [open, setOpen] = useState(false);
  const anyTrack = hasService("kitchentrack") || hasService("firetrack") || hasService("legionellatrack");
  if (!user || user.role === "client_viewer" || !anyTrack) return null;
  return (
    <>
      <Button type="button" variant="outline" className={cn("gap-2", className)} onClick={() => setOpen(true)} data-testid="say-it-button">
        <Mic className="h-4 w-4" />Say it
      </Button>
      <VoiceLogDialog open={open} onClose={() => setOpen(false)} defaultSiteId={siteId} />
    </>
  );
}
