import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
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
import {
  ArrowLeft,
  Plus,
  CheckCircle2,
  XCircle,
  Trash2,
  Pencil,
  FlameKindling,
  MapPin,
  Calendar,
  User,
} from "lucide-react";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";

type Site = {
  id: number;
  name: string;
  address: string | null;
  active: boolean;
};

type FireAlarmTest = {
  id: number;
  siteId: number;
  clientId: number;
  weekOf: string;
  testedBy: string;
  result: "pass" | "fail";
  alarmActivated: boolean;
  allCallPointsTested: boolean;
  faultFound: string | null;
  actionTaken: string | null;
  notes: string | null;
  createdAt: string;
};

function buildUrl(base: string, path: string, clientId?: number | null) {
  const url = `${base}api${path}`;
  return clientId ? `${url}?clientId=${clientId}` : url;
}

function formatWeek(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function getMonday(d: Date) {
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

function todayWeekOf() {
  const monday = getMonday(new Date());
  return monday.toISOString().split("T")[0];
}

type TestFormData = {
  weekOf: string;
  testedBy: string;
  result: "pass" | "fail";
  alarmActivated: boolean;
  allCallPointsTested: boolean;
  faultFound: string;
  actionTaken: string;
  notes: string;
};

const emptyForm = (): TestFormData => ({
  weekOf: todayWeekOf(),
  testedBy: "",
  result: "pass",
  alarmActivated: true,
  allCallPointsTested: true,
  faultFound: "",
  actionTaken: "",
  notes: "",
});

export default function SiteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const siteId = parseInt(id);
  const [, navigate] = useLocation();
  const { activeClientId, user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const base = import.meta.env.BASE_URL;

  const [showForm, setShowForm] = useState(false);
  const [editTest, setEditTest] = useState<FireAlarmTest | null>(null);
  const [deleteTest, setDeleteTest] = useState<FireAlarmTest | null>(null);
  const [form, setForm] = useState<TestFormData>(emptyForm());

  const { data: site, isLoading: siteLoading } = useQuery<Site>({
    queryKey: ["site", siteId, activeClientId],
    queryFn: async () => {
      const res = await fetch(buildUrl(base, `/sites/${siteId}`, activeClientId), { credentials: "include" });
      if (!res.ok) throw new Error("Site not found");
      return res.json();
    },
    enabled: !isNaN(siteId),
  });

  const { data: tests = [], isLoading: testsLoading } = useQuery<FireAlarmTest[]>({
    queryKey: ["fire-alarm-tests", siteId, activeClientId],
    queryFn: async () => {
      const res = await fetch(buildUrl(base, `/sites/${siteId}/fire-alarm-tests`, activeClientId), {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load tests");
      return res.json();
    },
    enabled: !isNaN(siteId),
  });

  const createMutation = useMutation({
    mutationFn: async (data: TestFormData) => {
      const res = await fetch(buildUrl(base, `/sites/${siteId}/fire-alarm-tests`, activeClientId), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          faultFound: data.faultFound || null,
          actionTaken: data.actionTaken || null,
          notes: data.notes || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to save test");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fire-alarm-tests", siteId] });
      queryClient.invalidateQueries({ queryKey: ["sites-latest-tests"] });
      setShowForm(false);
      setForm(emptyForm());
      toast({ title: "Test recorded" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: TestFormData & { id: number }) => {
      const res = await fetch(buildUrl(base, `/sites/${siteId}/fire-alarm-tests/${data.id}`, activeClientId), {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekOf: data.weekOf,
          testedBy: data.testedBy,
          result: data.result,
          alarmActivated: data.alarmActivated,
          allCallPointsTested: data.allCallPointsTested,
          faultFound: data.faultFound || null,
          actionTaken: data.actionTaken || null,
          notes: data.notes || null,
        }),
      });
      if (!res.ok) throw new Error("Failed to update test");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fire-alarm-tests", siteId] });
      queryClient.invalidateQueries({ queryKey: ["sites-latest-tests"] });
      setEditTest(null);
      setForm(emptyForm());
      toast({ title: "Test updated" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (testId: number) => {
      const res = await fetch(buildUrl(base, `/sites/${siteId}/fire-alarm-tests/${testId}`, activeClientId), {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete test");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fire-alarm-tests", siteId] });
      queryClient.invalidateQueries({ queryKey: ["sites-latest-tests"] });
      setDeleteTest(null);
      toast({ title: "Test deleted" });
    },
  });

  function openAdd() {
    const f = emptyForm();
    f.testedBy = user?.name ?? "";
    setForm(f);
    setShowForm(true);
  }

  function openEdit(test: FireAlarmTest) {
    setEditTest(test);
    setForm({
      weekOf: test.weekOf,
      testedBy: test.testedBy,
      result: test.result,
      alarmActivated: test.alarmActivated,
      allCallPointsTested: test.allCallPointsTested,
      faultFound: test.faultFound ?? "",
      actionTaken: test.actionTaken ?? "",
      notes: test.notes ?? "",
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editTest) {
      updateMutation.mutate({ ...form, id: editTest.id });
    } else {
      createMutation.mutate(form);
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;
  const showFaultFields = form.result === "fail" || !form.alarmActivated || !form.allCallPointsTested;

  if (siteLoading) {
    return (
      <AppLayout title="Site">
        <div className="animate-pulse h-8 w-48 bg-muted rounded-lg" />
      </AppLayout>
    );
  }

  if (!site) {
    return (
      <AppLayout title="Site Not Found">
        <div className="text-center py-20 text-muted-foreground">
          <p>This site could not be found.</p>
          <Button className="mt-4" variant="outline" onClick={() => navigate("/sites")}>Back to Sites</Button>
        </div>
      </AppLayout>
    );
  }

  const passCount = tests.filter((t) => t.result === "pass").length;
  const failCount = tests.filter((t) => t.result === "fail").length;

  return (
    <AppLayout title={site.name}>
      {/* Back + header */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={() => navigate("/sites")} className="gap-1.5 -ml-2">
          <ArrowLeft className="w-4 h-4" /> Sites
        </Button>
      </div>

      {/* Site info card */}
      <div className="bg-card border border-border rounded-2xl p-6 mb-6 flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="p-3 rounded-xl bg-orange-50 border border-orange-100 self-start">
          <FlameKindling className="w-6 h-6 text-orange-500" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-bold text-foreground">{site.name}</h2>
          {site.address && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground mt-1">
              <MapPin className="w-3.5 h-3.5" />
              {site.address}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 sm:self-auto self-start">
          <div className="text-center px-4 py-2 bg-green-50 border border-green-100 rounded-xl">
            <div className="text-2xl font-bold text-green-600">{passCount}</div>
            <div className="text-xs text-green-600 font-medium">Passed</div>
          </div>
          <div className="text-center px-4 py-2 bg-red-50 border border-red-100 rounded-xl">
            <div className="text-2xl font-bold text-red-600">{failCount}</div>
            <div className="text-xs text-red-600 font-medium">Failed</div>
          </div>
          <Button onClick={openAdd} className="gap-2 ml-2">
            <Plus className="w-4 h-4" /> Record Test
          </Button>
        </div>
      </div>

      {/* Test history */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Test History
        </h3>

        {testsLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <div key={i} className="h-20 rounded-xl bg-muted animate-pulse" />)}
          </div>
        ) : tests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground border border-dashed border-border rounded-2xl">
            <FlameKindling className="w-10 h-10 mb-3 opacity-30" />
            <p className="font-medium">No tests recorded yet</p>
            <p className="text-sm mt-1">Record the first weekly fire alarm test for this site.</p>
            <Button onClick={openAdd} className="mt-5 gap-2" size="sm">
              <Plus className="w-4 h-4" /> Record Test
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {tests.map((test, i) => (
              <motion.div
                key={test.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className="group bg-card border border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-start gap-4"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {test.result === "pass" ? (
                    <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-semibold text-foreground">Week of {formatWeek(test.weekOf)}</span>
                      <Badge
                        variant={test.result === "pass" ? "default" : "destructive"}
                        className={test.result === "pass" ? "bg-green-500 hover:bg-green-600 text-white text-xs" : "text-xs"}
                      >
                        {test.result === "pass" ? "Pass" : "Fail"}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <User className="w-3 h-3" /> {test.testedBy}
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {new Date(test.createdAt).toLocaleDateString("en-GB")}
                      </span>
                      <span>Alarm activated: <strong>{test.alarmActivated ? "Yes" : "No"}</strong></span>
                      <span>All call points tested: <strong>{test.allCallPointsTested ? "Yes" : "No"}</strong></span>
                    </div>
                    {test.faultFound && (
                      <div className="mt-2 text-xs bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                        <span className="font-medium text-red-700">Fault: </span>
                        <span className="text-red-600">{test.faultFound}</span>
                        {test.actionTaken && (
                          <span className="text-red-600"> — Action: {test.actionTaken}</span>
                        )}
                      </div>
                    )}
                    {test.notes && (
                      <p className="mt-1.5 text-xs text-muted-foreground italic">{test.notes}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <button
                    onClick={() => openEdit(test)}
                    className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setDeleteTest(test)}
                    className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Record / Edit Test Dialog */}
      <Dialog
        open={showForm || !!editTest}
        onOpenChange={(open) => {
          if (!open) { setShowForm(false); setEditTest(null); }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editTest ? "Edit Fire Alarm Test" : "Record Weekly Fire Alarm Test"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-5 pt-1">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="week-of">Week of *</Label>
                <Input
                  id="week-of"
                  type="date"
                  value={form.weekOf}
                  onChange={(e) => setForm({ ...form, weekOf: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tested-by">Tested by *</Label>
                <Input
                  id="tested-by"
                  value={form.testedBy}
                  onChange={(e) => setForm({ ...form, testedBy: e.target.value })}
                  placeholder="Name of tester"
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Result *</Label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, result: "pass" })}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all ${
                    form.result === "pass"
                      ? "border-green-500 bg-green-50 text-green-700"
                      : "border-border bg-card text-muted-foreground hover:border-green-300"
                  }`}
                >
                  <CheckCircle2 className="w-4 h-4" /> Pass
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, result: "fail" })}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all ${
                    form.result === "fail"
                      ? "border-red-500 bg-red-50 text-red-700"
                      : "border-border bg-card text-muted-foreground hover:border-red-300"
                  }`}
                >
                  <XCircle className="w-4 h-4" /> Fail
                </button>
              </div>
            </div>

            <div className="space-y-3 bg-muted/30 rounded-xl px-4 py-3 border border-border/50">
              <div className="flex items-center justify-between">
                <Label htmlFor="alarm-activated" className="cursor-pointer">Alarm activated?</Label>
                <Switch
                  id="alarm-activated"
                  checked={form.alarmActivated}
                  onCheckedChange={(v) => setForm({ ...form, alarmActivated: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="call-points" className="cursor-pointer">All call points tested?</Label>
                <Switch
                  id="call-points"
                  checked={form.allCallPointsTested}
                  onCheckedChange={(v) => setForm({ ...form, allCallPointsTested: v })}
                />
              </div>
            </div>

            {showFaultFields && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="space-y-3"
              >
                <div className="space-y-1.5">
                  <Label htmlFor="fault-found">Fault description</Label>
                  <Textarea
                    id="fault-found"
                    value={form.faultFound}
                    onChange={(e) => setForm({ ...form, faultFound: e.target.value })}
                    placeholder="Describe the fault or issue found..."
                    rows={2}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="action-taken">Action taken</Label>
                  <Textarea
                    id="action-taken"
                    value={form.actionTaken}
                    onChange={(e) => setForm({ ...form, actionTaken: e.target.value })}
                    placeholder="What steps were taken to resolve the issue?"
                    rows={2}
                  />
                </div>
              </motion.div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Any additional notes..."
                rows={2}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setShowForm(false); setEditTest(null); }}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending || !form.weekOf || !form.testedBy.trim()}>
                {isPending ? "Saving..." : editTest ? "Save Changes" : "Record Test"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTest} onOpenChange={(open) => { if (!open) setDeleteTest(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this test record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the fire alarm test record for week of{" "}
              <strong>{deleteTest ? formatWeek(deleteTest.weekOf) : ""}</strong>. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deleteTest && deleteMutation.mutate(deleteTest.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
