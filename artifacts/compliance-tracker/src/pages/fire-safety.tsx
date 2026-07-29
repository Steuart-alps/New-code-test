import { useState } from "react";
import { AppLayout } from "@/components/layout";
import {
  useListFireSafetyChecks,
  getListFireSafetyChecksQueryKey,
  useGetFireSafetyStatus,
  getGetFireSafetyStatusQueryKey,
  useCreateFireSafetyCheck,
  useUpdateFireSafetyCheck,
  useDeleteFireSafetyCheck,
  useListSites,
  FireCheckType,
  FireSafetyCheck,
  FireSafetyStatus as FireSafetyStatusType,
  CreateFireSafetyCheckRequest,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Flame, Plus, AlertTriangle, CheckCircle2, Clock, CalendarX, Filter, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

const CHECK_TYPE_LABELS: Record<FireCheckType, string> = {
  alarm: "Weekly fire alarm test",
  emergency_lights: "Monthly emergency lighting test",
  extinguishers: "Weekly extinguisher visual check",
  fire_doors: "Fire door check",
  fire_drill: "Fire drill / evacuation",
};

function StatusBadge({ status }: { status: "ok" | "due_soon" | "overdue" | "never" }) {
  if (status === "ok") {
    return (
      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
        <CheckCircle2 className="w-3 h-3 mr-1" />
        OK
      </Badge>
    );
  }
  if (status === "due_soon") {
    return (
      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
        <Clock className="w-3 h-3 mr-1" />
        Due Soon
      </Badge>
    );
  }
  if (status === "overdue") {
    return (
      <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
        <AlertTriangle className="w-3 h-3 mr-1" />
        Overdue
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-200">
      <CalendarX className="w-3 h-3 mr-1" />
      Never
    </Badge>
  );
}

function RecordCheckDialog({ siteId }: { siteId?: number }) {
  const [open, setOpen] = useState(false);
  const [checkType, setCheckType] = useState<FireCheckType>("alarm");
  const [checkDate, setCheckDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [result, setResult] = useState<"pass" | "fail">("pass");
  const [location, setLocation] = useState("");
  const [performedBy, setPerformedBy] = useState("");
  const [notes, setNotes] = useState("");

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createCheck = useCreateFireSafetyCheck();
  const { data: sites } = useListSites();
  const [selectedSite, setSelectedSite] = useState<number | undefined>(siteId);

  const handleSubmit = async () => {
    const data: CreateFireSafetyCheckRequest = {
      checkType,
      checkDate,
      result,
      siteId: selectedSite,
      location: location || undefined,
      performedBy: performedBy || undefined,
      notes: notes || undefined,
    };

    createCheck.mutate(
      { data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListFireSafetyChecksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetFireSafetyStatusQueryKey() });
          toast({ title: "Check recorded", description: "Fire safety check saved successfully." });
          setOpen(false);
          setLocation("");
          setPerformedBy("");
          setNotes("");
          setCheckDate(format(new Date(), "yyyy-MM-dd"));
        },
        onError: (error: any) => {
          toast({
            title: "Failed to record check",
            description: error.message || "An error occurred.",
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="shadow-lg shadow-primary/20">
          <Plus className="w-4 h-4 mr-2" />
          Record Check
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Record Fire Safety Check</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-1.5">
            <Label>Check Type</Label>
            <Select value={checkType} onValueChange={(v) => setCheckType(v as FireCheckType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CHECK_TYPE_LABELS) as FireCheckType[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {CHECK_TYPE_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>Result</Label>
            <Select value={result} onValueChange={(v) => setResult(v as "pass" | "fail")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pass">Pass</SelectItem>
                <SelectItem value="fail">Fail</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {sites && sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site (optional)</Label>
              <Select
                value={selectedSite ? String(selectedSite) : "none"}
                onValueChange={(v) => setSelectedSite(v === "none" ? undefined : Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All sites" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific site</SelectItem>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Location / Call Point</Label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Ground floor near kitchen"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Performed By</Label>
            <Input value={performedBy} onChange={(e) => setPerformedBy(e.target.value)} placeholder="Name" />
          </div>

          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createCheck.isPending}>
            {createCheck.isPending ? "Saving..." : "Record Check"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditCheckDialog({ check, siteId }: { check: FireSafetyCheck; siteId?: number }) {
  const [open, setOpen] = useState(false);
  const [checkDate, setCheckDate] = useState(check.checkDate);
  const [result, setResult] = useState<"pass" | "fail">(check.result);
  const [location, setLocation] = useState(check.location || "");
  const [performedBy, setPerformedBy] = useState(check.performedBy || "");
  const [notes, setNotes] = useState(check.notes || "");

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateCheck = useUpdateFireSafetyCheck();
  const { data: sites } = useListSites();
  const [selectedSite, setSelectedSite] = useState<number | undefined>(check.siteId || undefined);

  const handleSubmit = async () => {
    updateCheck.mutate(
      {
        id: check.id,
        data: {
          checkDate,
          result,
          siteId: selectedSite,
          location: location || undefined,
          performedBy: performedBy || undefined,
          notes: notes || undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListFireSafetyChecksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetFireSafetyStatusQueryKey() });
          toast({ title: "Check updated" });
          setOpen(false);
        },
        onError: (error: any) => {
          toast({ title: "Failed to update check", description: error.message, variant: "destructive" });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Pencil className="w-3.5 h-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Edit Check</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>Result</Label>
            <Select value={result} onValueChange={(v) => setResult(v as "pass" | "fail")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pass">Pass</SelectItem>
                <SelectItem value="fail">Fail</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {sites && sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site (optional)</Label>
              <Select
                value={selectedSite ? String(selectedSite) : "none"}
                onValueChange={(v) => setSelectedSite(v === "none" ? undefined : Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All sites" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific site</SelectItem>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Location / Call Point</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>Performed By</Label>
            <Input value={performedBy} onChange={(e) => setPerformedBy(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={updateCheck.isPending}>
            {updateCheck.isPending ? "Saving..." : "Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function FireSafetyPage() {
  const [filterType, setFilterType] = useState<FireCheckType | "">("");
  const [filterSite, setFilterSite] = useState<number | undefined>(undefined);

  const { data: status, isLoading: statusLoading } = useGetFireSafetyStatus({
    siteId: filterSite,
  });
  const { data: checks, isLoading: checksLoading } = useListFireSafetyChecks({
    checkType: filterType || undefined,
    siteId: filterSite,
  });
  const { data: sites } = useListSites();

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const deleteCheck = useDeleteFireSafetyCheck();

  const handleDelete = (id: number) => {
    if (!confirm("Delete this check record?")) return;
    deleteCheck.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListFireSafetyChecksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetFireSafetyStatusQueryKey() });
          toast({ title: "Check deleted" });
        },
        onError: (error: any) => {
          toast({ title: "Failed to delete", description: error.message, variant: "destructive" });
        },
      }
    );
  };

  const overdueStatuses = status?.filter((s) => s.status === "overdue") || [];
  const dueSoonStatuses = status?.filter((s) => s.status === "due_soon") || [];

  return (
    <AppLayout title="FireTrack — Fire Safety Logbook">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10">
              <Flame className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                Digital fire safety logbook — record checks, track compliance status
              </p>
            </div>
          </div>
          <RecordCheckDialog siteId={filterSite} />
        </div>

        {/* Status Overview */}
        {statusLoading ? (
          <Card>
            <CardContent className="p-12 flex justify-center">
              <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {status?.map((item) => (
              <Card
                key={item.checkType}
                className={cn(
                  "border-l-4 transition-all hover:shadow-md",
                  item.status === "overdue"
                    ? "border-l-rose-500 bg-rose-50/50"
                    : item.status === "due_soon"
                    ? "border-l-amber-500 bg-amber-50/50"
                    : item.status === "never"
                    ? "border-l-slate-400 bg-slate-50/50"
                    : "border-l-emerald-500 bg-emerald-50/50"
                )}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-sm font-medium leading-tight">
                      {CHECK_TYPE_LABELS[item.checkType]}
                    </CardTitle>
                    <StatusBadge status={item.status} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium">Frequency:</span> Every {item.frequencyDays} days
                  </div>
                  {item.lastDate && (
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium">Last check:</span>{" "}
                      {format(new Date(item.lastDate), "dd/MM/yyyy")}
                    </div>
                  )}
                  {item.dueDate && (
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium">Next due:</span>{" "}
                      {format(new Date(item.dueDate), "dd/MM/yyyy")}
                    </div>
                  )}
                  {item.status === "never" && (
                    <div className="text-xs text-muted-foreground italic">No checks recorded yet</div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {(overdueStatuses.length > 0 || dueSoonStatuses.length > 0) && (
          <div className="space-y-3">
            {overdueStatuses.length > 0 && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> Overdue checks
                </div>
                <div className="text-xs">
                  {overdueStatuses.map((s) => CHECK_TYPE_LABELS[s.checkType]).join(", ")} — action required.
                </div>
              </div>
            )}
            {dueSoonStatuses.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5">
                  <Clock className="w-4 h-4" /> Due soon
                </div>
                <div className="text-xs">
                  {dueSoonStatuses.map((s) => CHECK_TYPE_LABELS[s.checkType]).join(", ")} — schedule soon.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Filters */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-4">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base font-display">Filter History</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Check Type</Label>
                <Select value={filterType || "all"} onValueChange={(v) => setFilterType(v === "all" ? "" : (v as FireCheckType | ""))}>
                  <SelectTrigger>
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    {(Object.keys(CHECK_TYPE_LABELS) as FireCheckType[]).map((key) => (
                      <SelectItem key={key} value={key}>
                        {CHECK_TYPE_LABELS[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {sites && sites.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Site</Label>
                  <Select
                    value={filterSite ? String(filterSite) : "all"}
                    onValueChange={(v) => setFilterSite(v === "all" ? undefined : Number(v))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All sites" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All sites</SelectItem>
                      {sites.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Check History */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-4">
            <CardTitle className="font-display">Check History</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {checksLoading ? (
              <div className="p-12 flex justify-center">
                <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
              </div>
            ) : !checks || checks.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                <Flame className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm">No checks recorded yet. Record your first check above.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {checks.map((check) => {
                  const site = sites?.find((s) => s.id === check.siteId);
                  return (
                    <div key={check.id} className="p-4 hover:bg-muted/20 transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{CHECK_TYPE_LABELS[check.checkType]}</span>
                            <Badge
                              variant="outline"
                              className={cn(
                                check.result === "pass"
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                  : "bg-rose-50 text-rose-700 border-rose-200"
                              )}
                            >
                              {check.result === "pass" ? "Pass" : "Fail"}
                            </Badge>
                            {site && (
                              <Badge variant="outline" className="text-xs">
                                {site.name}
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground space-y-0.5">
                            <div>
                              <span className="font-medium">Date:</span> {format(new Date(check.checkDate), "dd/MM/yyyy")}
                            </div>
                            {check.location && (
                              <div>
                                <span className="font-medium">Location:</span> {check.location}
                              </div>
                            )}
                            {check.performedBy && (
                              <div>
                                <span className="font-medium">Performed by:</span> {check.performedBy}
                              </div>
                            )}
                            {check.notes && (
                              <div>
                                <span className="font-medium">Notes:</span> {check.notes}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <EditCheckDialog check={check} siteId={filterSite} />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(check.id)}
                            className="text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
