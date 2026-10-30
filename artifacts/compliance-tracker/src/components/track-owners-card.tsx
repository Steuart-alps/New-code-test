import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, ChevronRight } from "lucide-react";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { roleLabel } from "@/lib/roles";

interface TrackOwner {
  id: number;
  module: string;
  siteId: number | null;
  userId: number;
  userName: string;
  eligible: boolean;
}

interface TrackOwnersResponse {
  modules: { key: string; label: string; enabled: boolean }[];
  owners: TrackOwner[];
  sites: { id: number; name: string }[];
  users: { id: number; name: string; email: string; role: string }[];
  defaultRecipients: { id: number; name: string }[];
}

const DEFAULT = "default";

/**
 * Settings card: who owns each track. The owner receives that track's in-app
 * reminders (bell pop-up and mobile push, never email); a site can have its
 * own owner. Unassigned tracks fall back to the business's Owners.
 */
export function TrackOwnersCard() {
  const { toast } = useToast();
  const canAdmin = useCanAdmin();
  const { user, activeClientId } = useAuth();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);
  const queryKey = ["track-owners", user?.id ?? null, activeClientId ?? null];

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: async (): Promise<TrackOwnersResponse> => {
      const response = await apiFetch("/track-owners");
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Couldn't load track owners"));
      return response.json();
    },
  });

  const ownerFor = (module: string, siteId: number | null) =>
    data?.owners.find((owner) => owner.module === module && owner.siteId === siteId);

  const save = async (module: string, siteId: number | null, value: string) => {
    const key = `${module}:${siteId ?? "all"}`;
    const existing = ownerFor(module, siteId);
    setSaving(key);
    try {
      let response: Response | null = null;
      if (value === DEFAULT) {
        if (existing) response = await apiFetch(`/track-owners/${existing.id}`, { method: "DELETE" });
      } else {
        response = await apiFetch("/track-owners", {
          method: "PUT",
          body: JSON.stringify({ module, siteId, userId: Number(value) }),
        });
      }
      if (response && !response.ok) throw new Error(await getApiErrorMessage(response, "Couldn't save the track owner"));
      await queryClient.invalidateQueries({ queryKey });
      toast({ title: "Track owner saved" });
    } catch (err) {
      toast({ title: "Couldn't save the track owner", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  const enabledModules = data?.modules.filter((module) => module.enabled) ?? [];
  const defaultNames = data?.defaultRecipients.map((recipient) => recipient.name).join(", ") || "the business's admins";

  const ownerSelect = (module: string, siteId: number | null, emptyLabel: string) => {
    const owner = ownerFor(module, siteId);
    const key = `${module}:${siteId ?? "all"}`;
    const users = data?.users ?? [];
    // Keep a no-longer-eligible owner visible so the admin can see and replace them.
    const showStale = owner && !users.some((candidate) => candidate.id === owner.userId);
    return (
      <Select
        value={owner ? String(owner.userId) : DEFAULT}
        onValueChange={(value) => void save(module, siteId, value)}
        disabled={!canAdmin || saving !== null}
      >
        <SelectTrigger className="h-9 w-full sm:w-64" data-testid={`select-track-owner-${key}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>{emptyLabel}</SelectItem>
          {showStale && (
            <SelectItem value={String(owner.userId)} disabled>{owner.userName} (inactive)</SelectItem>
          )}
          {users.map((candidate) => (
            <SelectItem key={candidate.id} value={String(candidate.id)}>
              {candidate.name} · {roleLabel(candidate.role, user?.role === "consultant")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };

  return (
    <Card className="shadow-lg border-border/50 bg-card">
      <CardHeader className="bg-muted/20 border-b border-border/50 pb-4">
        <div className="flex items-center gap-2">
          <BellRing className="w-5 h-5 text-amber-600" />
          <CardTitle className="font-display font-bold">Track Owners</CardTitle>
        </div>
        <CardDescription>
          The owner of a track gets its reminders in the app (a pop-up under the bell, and a phone notification in the
          mobile app) — never by email. Reminders cover the AM and PM checklists once each site's due time has passed
          (06:00 and 18:00 unless changed on the AM or PM page), the kitchen diary (21:00), and overdue checks and
          actions (09:00), on your account's timezone. Without an owner, reminders go
          to {defaultNames}. A site can have its own owner.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : enabledModules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tracks are enabled for this business yet.</p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {enabledModules.map((module) => {
              const owner = ownerFor(module.key, null);
              const overrides = data!.owners.filter((row) => row.module === module.key && row.siteId !== null).length;
              return (
                <div key={module.key} className="px-4 py-3" data-testid={`track-owner-row-${module.key}`}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{module.label}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {owner ? (owner.eligible ? `Owner: ${owner.userName}` : `${owner.userName} is inactive — admins get reminders`) : "Admins get reminders"}
                        {overrides > 0 ? ` · ${overrides} site override${overrides === 1 ? "" : "s"}` : ""}
                      </p>
                    </div>
                    {ownerSelect(module.key, null, "No owner (admins)")}
                  </div>
                  {data!.sites.length > 1 && (
                    <details className="group mt-2">
                      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                        Per-site owners
                      </summary>
                      <div className="mt-2 space-y-2 border-l border-border pl-4">
                        {data!.sites.map((site) => (
                          <div key={site.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-sm min-w-0 break-words">{site.name}</span>
                            {ownerSelect(module.key, site.id, "Same as track owner")}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
