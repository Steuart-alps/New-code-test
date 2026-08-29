import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { AlertTriangle, Plus, Pencil, Trash2, GraduationCap, CheckCircle2, Clock } from "lucide-react";

interface TrainingRecord {
  id: number;
  userId: number | null;
  staffName: string;
  courseName: string;
  issuedAt: string | null;
  expiresAt: string | null;
  notes: string | null;
  createdAt: string;
}

interface ExpiryData {
  expired: TrainingRecord[];
  expiringSoon: TrainingRecord[];
  total: number;
}

function daysUntil(isoDate: string | null | undefined): number | null {
  if (!isoDate) return null;
  const diff = new Date(isoDate).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function ExpiryBadge({ expiresAt }: { expiresAt: string | null }) {
  const days = daysUntil(expiresAt);
  if (days === null) return <span className="text-xs text-muted-foreground">No expiry</span>;

  if (days < 0) {
    return (
      <Badge variant="outline" className="text-xs border-red-300 text-red-700 bg-red-50 gap-1">
        <AlertTriangle className="w-3 h-3" />
        Expired {Math.abs(days)}d ago
      </Badge>
    );
  }
  if (days <= 30) {
    return (
      <Badge variant="outline" className="text-xs border-amber-300 text-amber-700 bg-amber-50 gap-1">
        <Clock className="w-3 h-3" />
        Expires in {days}d
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs border-emerald-200 text-emerald-700 bg-emerald-50 gap-1">
      <CheckCircle2 className="w-3 h-3" />
      Valid · {days}d left
    </Badge>
  );
}

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ── Record form ───────────────────────────────────────────────────────────────

interface FormState {
  staffName: string;
  courseName: string;
  issuedAt: string;
  expiresAt: string;
  notes: string;
}

const EMPTY: FormState = { staffName: "", courseName: "", issuedAt: "", expiresAt: "", notes: "" };

function RecordDialog({
  record,
  onClose,
  onSaved,
}: {
  record: TrainingRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!record;
  const [form, setForm] = useState<FormState>(
    record
      ? {
          staffName: record.staffName,
          courseName: record.courseName,
          issuedAt: record.issuedAt ? record.issuedAt.slice(0, 10) : "",
          expiresAt: record.expiresAt ? record.expiresAt.slice(0, 10) : "",
          notes: record.notes ?? "",
        }
      : EMPTY,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body = {
        staffName: form.staffName,
        courseName: form.courseName,
        issuedAt: form.issuedAt || null,
        expiresAt: form.expiresAt || null,
        notes: form.notes || null,
      };
      const res = isEdit
        ? await apiFetch(`/staff-training/${record!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        : await apiFetch("/staff-training", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? "Failed to save");
        return;
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit training record" : "Add training record"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label>Staff member *</Label>
            <Input value={form.staffName} onChange={set("staffName")} placeholder="Full name" required />
          </div>
          <div className="space-y-1.5">
            <Label>Course / certificate name *</Label>
            <Input value={form.courseName} onChange={set("courseName")} placeholder="e.g. Food Hygiene Level 2" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Issue date</Label>
              <Input type="date" value={form.issuedAt} onChange={set("issuedAt")} />
            </div>
            <div className="space-y-1.5">
              <Label>Expiry date</Label>
              <Input type="date" value={form.expiresAt} onChange={set("expiresAt")} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={set("notes")} rows={2} placeholder="Optional" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StaffTrainingPage() {
  const { user } = useAuth();
  const canAdmin = user?.role === "consultant" || user?.role === "client_admin";

  const [records, setRecords] = useState<TrainingRecord[]>([]);
  const [expiry, setExpiry] = useState<ExpiryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [editRecord, setEditRecord] = useState<TrainingRecord | null | undefined>(undefined); // undefined = closed, null = new
  const [deleteRecord, setDeleteRecord] = useState<TrainingRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rRes, eRes] = await Promise.all([
        apiFetch("/staff-training"),
        apiFetch("/staff-training/expiring?within=30"),
      ]);
      if (rRes.ok) setRecords(await rRes.json());
      if (eRes.ok) setExpiry(await eRes.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async () => {
    if (!deleteRecord) return;
    setDeleting(true);
    try {
      await apiFetch(`/staff-training/${deleteRecord.id}`, { method: "DELETE" });
      await load();
    } finally {
      setDeleting(false);
      setDeleteRecord(null);
    }
  };

  const alertCount = (expiry?.expired.length ?? 0) + (expiry?.expiringSoon.length ?? 0);

  return (
    <AppLayout title="Staff Training Records">
      {/* Edit/create dialog */}
      {editRecord !== undefined && (
        <RecordDialog
          record={editRecord}
          onClose={() => setEditRecord(undefined)}
          onSaved={load}
        />
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteRecord} onOpenChange={open => { if (!open) setDeleteRecord(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete training record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the training record for <strong>{deleteRecord?.staffName}</strong> — <em>{deleteRecord?.courseName}</em>. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="space-y-5">
        {/* Alert banner when certs are expiring/expired */}
        {!loading && alertCount > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-800 text-sm">
                {expiry!.expired.length > 0 && `${expiry!.expired.length} certificate${expiry!.expired.length !== 1 ? "s" : ""} have expired`}
                {expiry!.expired.length > 0 && expiry!.expiringSoon.length > 0 && " · "}
                {expiry!.expiringSoon.length > 0 && `${expiry!.expiringSoon.length} expiring within 30 days`}
              </p>
              {expiry!.expired.length > 0 && (
                <ul className="text-xs text-amber-700 mt-1.5 space-y-0.5">
                  {expiry!.expired.map(r => (
                    <li key={r.id}>• {r.staffName} — {r.courseName} (expired {fmt(r.expiresAt)})</li>
                  ))}
                </ul>
              )}
              {expiry!.expiringSoon.length > 0 && (
                <ul className="text-xs text-amber-700 mt-1.5 space-y-0.5">
                  {expiry!.expiringSoon.map(r => (
                    <li key={r.id}>• {r.staffName} — {r.courseName} (expires {fmt(r.expiresAt)})</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Header + add button */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{records.length} record{records.length !== 1 ? "s" : ""}</p>
          {canAdmin && (
            <Button size="sm" className="gap-1.5" onClick={() => setEditRecord(null)}>
              <Plus className="w-4 h-4" /> Add record
            </Button>
          )}
        </div>

        {/* Table */}
        {loading ? (
          <div className="text-center py-16 text-muted-foreground text-sm">Loading…</div>
        ) : records.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-border rounded-xl">
            <GraduationCap className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No training records yet.</p>
            {canAdmin && (
              <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={() => setEditRecord(null)}>
                <Plus className="w-3.5 h-3.5" /> Add first record
              </Button>
            )}
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground">Staff member</th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground">Course / Certificate</th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground hidden sm:table-cell">Issued</th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground">Status</th>
                  {canAdmin && <th className="w-20 px-3 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {records.map(r => (
                  <tr key={r.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3 text-sm font-medium">{r.staffName}</td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{r.courseName}</td>
                    <td className="px-5 py-3 text-sm text-muted-foreground hidden sm:table-cell">{fmt(r.issuedAt)}</td>
                    <td className="px-5 py-3">
                      <ExpiryBadge expiresAt={r.expiresAt} />
                    </td>
                    {canAdmin && (
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditRecord(r)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteRecord(r)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
