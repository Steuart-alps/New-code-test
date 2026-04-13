import { useState } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/auth-context";
import { Building2, Plus, MapPin, ChevronRight, Pencil, Trash2, FlameKindling } from "lucide-react";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";

type Site = {
  id: number;
  name: string;
  address: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type FireAlarmTest = {
  id: number;
  siteId: number;
  weekOf: string;
  result: "pass" | "fail";
};

function buildUrl(base: string, path: string, clientId?: number | null) {
  const url = `${base}api${path}`;
  return clientId ? `${url}?clientId=${clientId}` : url;
}

function useSites() {
  const { activeClientId } = useAuth();
  const base = import.meta.env.BASE_URL;
  return useQuery<Site[]>({
    queryKey: ["sites", activeClientId],
    queryFn: async () => {
      const res = await fetch(buildUrl(base, "/sites", activeClientId), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load sites");
      return res.json();
    },
  });
}

function useLatestTests(siteIds: number[]) {
  const { activeClientId } = useAuth();
  const base = import.meta.env.BASE_URL;
  return useQuery<Record<number, FireAlarmTest | null>>({
    queryKey: ["sites-latest-tests", siteIds, activeClientId],
    queryFn: async () => {
      if (siteIds.length === 0) return {};
      const results = await Promise.all(
        siteIds.map(async (siteId) => {
          const res = await fetch(buildUrl(base, `/sites/${siteId}/fire-alarm-tests`, activeClientId), {
            credentials: "include",
          });
          if (!res.ok) return [siteId, null] as [number, null];
          const tests: FireAlarmTest[] = await res.json();
          return [siteId, tests[0] ?? null] as [number, FireAlarmTest | null];
        }),
      );
      return Object.fromEntries(results);
    },
    enabled: siteIds.length > 0,
  });
}

export default function SitesPage() {
  const [, navigate] = useLocation();
  const { activeClientId } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const base = import.meta.env.BASE_URL;

  const { data: sites = [], isLoading } = useSites();
  const siteIds = sites.map((s) => s.id);
  const { data: latestTests = {} } = useLatestTests(siteIds);

  const [showAdd, setShowAdd] = useState(false);
  const [editSite, setEditSite] = useState<Site | null>(null);
  const [deleteSite, setDeleteSite] = useState<Site | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; address: string }) => {
      const res = await fetch(buildUrl(base, "/sites", activeClientId), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create site");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      setShowAdd(false);
      setName("");
      setAddress("");
      toast({ title: "Site added" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: { id: number; name: string; address: string }) => {
      const res = await fetch(buildUrl(base, `/sites/${data.id}`, activeClientId), {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: data.name, address: data.address }),
      });
      if (!res.ok) throw new Error("Failed to update site");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      setEditSite(null);
      setName("");
      setAddress("");
      toast({ title: "Site updated" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(buildUrl(base, `/sites/${id}`, activeClientId), {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete site");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      setDeleteSite(null);
      toast({ title: "Site deleted" });
    },
  });

  function openAdd() {
    setName("");
    setAddress("");
    setShowAdd(true);
  }

  function openEdit(site: Site, e: React.MouseEvent) {
    e.stopPropagation();
    setEditSite(site);
    setName(site.name);
    setAddress(site.address ?? "");
  }

  function openDelete(site: Site, e: React.MouseEvent) {
    e.stopPropagation();
    setDeleteSite(site);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editSite) {
      updateMutation.mutate({ id: editSite.id, name, address });
    } else {
      createMutation.mutate({ name, address });
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <AppLayout title="Sites">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-muted-foreground">
          All physical locations registered for your organisation.
        </p>
        <Button onClick={openAdd} size="sm" className="gap-2">
          <Plus className="w-4 h-4" /> Add Site
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-36 rounded-2xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : sites.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground">
          <Building2 className="w-12 h-12 mb-4 opacity-30" />
          <p className="text-lg font-medium">No sites yet</p>
          <p className="text-sm mt-1">Add your first site to start recording fire alarm tests.</p>
          <Button onClick={openAdd} className="mt-6 gap-2">
            <Plus className="w-4 h-4" /> Add Site
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
          {sites.map((site, i) => {
            const latest = latestTests[site.id];
            return (
              <motion.div
                key={site.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                onClick={() => navigate(`/sites/${site.id}`)}
                className="group relative bg-card border border-border rounded-2xl p-5 cursor-pointer hover:shadow-md hover:border-primary/30 transition-all"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="p-2 rounded-xl bg-orange-50 border border-orange-100">
                    <FlameKindling className="w-5 h-5 text-orange-500" />
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => openEdit(site, e)}
                      className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => openDelete(site, e)}
                      className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <h3 className="font-semibold text-foreground text-base leading-tight mb-1">{site.name}</h3>
                {site.address && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground mb-3">
                    <MapPin className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">{site.address}</span>
                  </div>
                )}

                <div className="flex items-center justify-between mt-auto pt-3 border-t border-border/50">
                  <div>
                    {latest ? (
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={latest.result === "pass" ? "default" : "destructive"}
                          className={latest.result === "pass" ? "bg-green-500 hover:bg-green-600 text-white" : ""}
                        >
                          {latest.result === "pass" ? "Last: Pass" : "Last: Fail"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(latest.weekOf).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">No tests recorded</span>
                    )}
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Dialog */}
      <Dialog open={showAdd || !!editSite} onOpenChange={(open) => { if (!open) { setShowAdd(false); setEditSite(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editSite ? "Edit Site" : "Add Site"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 pt-1">
            <div className="space-y-1.5">
              <Label htmlFor="site-name">Site Name *</Label>
              <Input
                id="site-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Head Office, Warehouse A"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="site-address">Address</Label>
              <Input
                id="site-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="e.g. 123 High Street, London, EC1A 1BB"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setShowAdd(false); setEditSite(null); }}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending || !name.trim()}>
                {isPending ? "Saving..." : editSite ? "Save Changes" : "Add Site"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteSite} onOpenChange={(open) => { if (!open) setDeleteSite(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete site?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{deleteSite?.name}</strong> and all its fire alarm test records. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deleteSite && deleteMutation.mutate(deleteSite.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
