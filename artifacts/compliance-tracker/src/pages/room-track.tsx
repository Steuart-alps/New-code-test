import { useCallback, useEffect, useState } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useListSites } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { BedDouble, CheckCircle2, CheckSquare, ClipboardCheck, Loader2, Pencil, Plus, Archive, AlertCircle, Square } from "lucide-react";
import { cn } from "@/lib/utils";

type CheckValues = { clean: boolean; tidy: boolean; toStandard: boolean };

interface Room {
  id: number;
  roomNumber?: string | null;
  room_number?: string | null;
  name?: string | null;
  floor?: string | null;
  siteId?: number | null;
  site_id?: number | null;
  notes?: string | null;
  archived?: boolean;
  isArchived?: boolean;
}

interface RoomCheck {
  id: number;
  roomId?: number;
  room_id?: number;
  checkDate?: string;
  check_date?: string;
  clean: boolean;
  tidy: boolean;
  toStandard?: boolean;
  to_standard?: boolean;
  notes?: string | null;
  checkedBy?: string | null;
  checked_by?: string | null;
}

const OUTCOMES: { key: keyof CheckValues; label: string; className: string }[] = [
  { key: "clean", label: "Clean", className: "border-emerald-300 bg-emerald-50 text-emerald-800" },
  { key: "tidy", label: "Tidy", className: "border-sky-300 bg-sky-50 text-sky-800" },
  { key: "toStandard", label: "To standard", className: "border-violet-300 bg-violet-50 text-violet-800" },
];

const today = () => new Date().toISOString().slice(0, 10);
const roomNumber = (room: Room) => room.roomNumber ?? room.room_number ?? "";
const roomSiteId = (room: Room) => room.siteId ?? room.site_id ?? null;
const checkRoomId = (check: RoomCheck) => check.roomId ?? check.room_id;
const checkBy = (check: RoomCheck) => check.checkedBy ?? check.checked_by;
const checkValues = (check?: RoomCheck): CheckValues => ({
  clean: check?.clean ?? false,
  tidy: check?.tidy ?? false,
  toStandard: check?.toStandard ?? check?.to_standard ?? false,
});

function RoomDialog({ room, sites, open, onOpenChange, onSaved }: {
  room: Room | null;
  sites: { id: number; name: string }[];
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({
    roomNumber: room ? roomNumber(room) : "",
    name: room?.name ?? "",
    floor: room?.floor ?? "",
    siteId: room && roomSiteId(room) ? String(roomSiteId(room)) : "__none__",
    notes: room?.notes ?? "",
  }));
  const update = (key: keyof typeof form, value: string) => setForm(current => ({ ...current, [key]: value }));

  const save = async () => {
    if (!form.roomNumber.trim()) {
      toast({ title: "Room number is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        roomNumber: form.roomNumber.trim() || null,
        name: form.name.trim() || null,
        floor: form.floor.trim() || null,
        siteId: form.siteId === "__none__" ? null : Number(form.siteId),
        notes: form.notes.trim() || null,
      };
      const response = await apiFetch(room ? `/room-track/rooms/${room.id}` : "/room-track/rooms", {
        method: room ? "PUT" : "POST", body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Unable to save room");
      toast({ title: room ? "Room updated" : "Room added" });
      onSaved();
      onOpenChange(false);
    } catch (error: any) {
      toast({ title: "Couldn't save room", description: error.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={value => !saving && onOpenChange(value)}>
      <DialogContent className="max-w-lg rounded-sm">
        <DialogHeader>
          <DialogTitle>{room ? "Edit room" : "Add room"}</DialogTitle>
          <DialogDescription>
            Record the room details used for daily housekeeping checks.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="room-number">Room number</Label><Input id="room-number" value={form.roomNumber} onChange={e => update("roomNumber", e.target.value)} placeholder="e.g. 204" /></div>
          <div className="space-y-1.5"><Label htmlFor="room-name">Room name</Label><Input id="room-name" value={form.name} onChange={e => update("name", e.target.value)} placeholder="e.g. Bluebell suite" /></div>
          <div className="space-y-1.5"><Label htmlFor="room-floor">Floor</Label><Input id="room-floor" value={form.floor} onChange={e => update("floor", e.target.value)} placeholder="e.g. First floor" /></div>
          <div className="space-y-1.5">
            <Label>Site</Label>
            <Select value={form.siteId} onValueChange={value => update("siteId", value)}>
              <SelectTrigger aria-label="Room site"><SelectValue placeholder="No site assigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No site assigned</SelectItem>
                {sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="room-notes">Room notes</Label><Textarea id="room-notes" value={form.notes} onChange={e => update("notes", e.target.value)} placeholder="Access, equipment or housekeeping notes" rows={3} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button><Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save room"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function RoomTrackPage() {
  const { user } = useAuth();
  const canAdmin = useCanAdmin();
  const { toast } = useToast();
  const { data: sites = [] } = useListSites();
  const [date, setDate] = useState(today);
  const [siteId, setSiteId] = useState("__all__");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [checks, setChecks] = useState<RoomCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (siteId !== "__all__") params.set("siteId", siteId);
      params.set("active", "true");
      const [roomsResponse, checksResponse] = await Promise.all([
        apiFetch(`/room-track/rooms?${params}`),
        apiFetch(`/room-track/checks?date=${encodeURIComponent(date)}`),
      ]);
      if (!roomsResponse.ok) throw new Error((await roomsResponse.json().catch(() => ({}))).error ?? "Unable to load rooms");
      if (!checksResponse.ok) throw new Error((await checksResponse.json().catch(() => ({}))).error ?? "Unable to load room checks");
      const [roomData, checkData] = await Promise.all([roomsResponse.json(), checksResponse.json()]);
      setRooms(roomData);
      setChecks(checkData);
    } catch (error: any) {
      toast({ title: "Couldn't load RoomTrack", description: error.message, variant: "destructive" });
    } finally { setLoading(false); }
  }, [date, siteId, toast]);

  useEffect(() => { load(); }, [load]);

  const activeRooms = rooms.filter(room => !room.archived && !room.isArchived && (siteId === "__all__" || roomSiteId(room) === Number(siteId)));
  const saveCheck = async (room: Room, values: CheckValues, notes: string, checkedBy: string) => {
    setSavingId(room.id);
    try {
      const payload = { roomId: room.id, checkDate: date, siteId: roomSiteId(room), ...values, notes: notes.trim() || null, checkedBy: checkedBy.trim() || null };
      const existing = checks.find(check => checkRoomId(check) === room.id);
      const response = await apiFetch(existing ? `/room-track/checks/${existing.id}` : "/room-track/checks", { method: existing ? "PUT" : "POST", body: JSON.stringify(payload) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Unable to save check");
      const saved = await response.json();
      setChecks(current => [...current.filter(check => checkRoomId(check) !== room.id), saved]);
      toast({ title: `${roomNumber(room) || room.name} housekeeping check saved` });
    } catch (error: any) {
      toast({ title: "Couldn't save room check", description: error.message, variant: "destructive" });
    } finally { setSavingId(null); }
  };

  const archive = async (room: Room) => {
    if (!window.confirm(`Archive ${roomNumber(room) || room.name}? It will remain in historic checks.`)) return;
    try {
      const response = await apiFetch(`/room-track/rooms/${room.id}`, {
        method: "PUT",
        body: JSON.stringify({ roomNumber: roomNumber(room), name: room.name ?? null, floor: room.floor ?? null, siteId: roomSiteId(room), notes: room.notes ?? null, active: false }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Unable to archive room");
      toast({ title: "Room archived" }); load();
    } catch (error: any) { toast({ title: "Couldn't archive room", description: error.message, variant: "destructive" }); }
  };

  return (
    <AppLayout title="RoomTrack">
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-sm border border-sky-200 bg-sky-50"><BedDouble className="h-4 w-4 text-sky-700" /></div><div><h1 className="text-lg font-semibold">RoomTrack</h1><p className="text-xs text-muted-foreground">Daily room housekeeping checks</p></div></div>
          {canAdmin && <Button size="sm" className="gap-1.5 rounded-sm" onClick={() => { setEditingRoom(null); setDialogOpen(true); }}><Plus className="h-3.5 w-3.5" />Add room</Button>}
        </div>
        <p className="rounded-sm border border-sky-200 bg-sky-50 px-4 py-2.5 text-xs text-sky-900">Clean, Tidy and To standard are all housekeeping outcomes. Use notes to capture anything needing attention.</p>
        <Card className="grid gap-3 rounded-sm p-4 sm:grid-cols-[minmax(140px,1fr)_minmax(180px,1fr)_auto]">
          <div className="space-y-1"><Label htmlFor="check-date" className="text-xs">Check date</Label><Input id="check-date" type="date" value={date} onChange={e => setDate(e.target.value)} className="h-9" /></div>
          <div className="space-y-1"><Label className="text-xs">Site</Label><Select value={siteId} onValueChange={setSiteId}><SelectTrigger className="h-9" aria-label="Filter rooms by site"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">All sites</SelectItem>{sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="flex items-end"><Button variant="outline" className="h-9" onClick={load}>Refresh</Button></div>
        </Card>
        {loading ? <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div> : activeRooms.length === 0 ? (
          <div className="rounded-sm border border-dashed p-12 text-center"><BedDouble className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" /><p className="text-sm font-medium text-muted-foreground">No active rooms for this selection</p>{canAdmin && <Button variant="outline" size="sm" className="mt-4" onClick={() => { setEditingRoom(null); setDialogOpen(true); }}>Add the first room</Button>}</div>
        ) : <div className="grid gap-4 lg:grid-cols-2">{activeRooms.map(room => {
          const check = checks.find(item => checkRoomId(item) === room.id);
          return <RoomCheckCard key={room.id} room={room} check={check} disabled={savingId === room.id} defaultCheckedBy={user?.name ?? ""} canAdmin={canAdmin} onSave={saveCheck} onEdit={() => { setEditingRoom(room); setDialogOpen(true); }} onArchive={() => archive(room)} />;
        })}</div>}
        {canAdmin && activeRooms.length > 0 && <section className="rounded-sm border border-border"><div className="border-b bg-muted/30 px-4 py-3"><h2 className="text-sm font-semibold">Active room register</h2><p className="text-xs text-muted-foreground">Edit room details or archive rooms no longer in use.</p></div><div className="divide-y">{activeRooms.map(room => <div key={room.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"><span className="font-medium">{roomNumber(room) || room.name}</span>{room.name && roomNumber(room) && <span className="text-muted-foreground">{room.name}</span>}<span className="text-xs text-muted-foreground">{room.floor || "No floor"}</span><span className="ml-auto flex gap-1"><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditingRoom(room); setDialogOpen(true); }} aria-label={`Edit ${roomNumber(room) || room.name}`}><Pencil className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => archive(room)} aria-label={`Archive ${roomNumber(room) || room.name}`}><Archive className="h-3.5 w-3.5" /></Button></span></div>)}</div></section>}
      </div>
      {dialogOpen && <RoomDialog key={editingRoom?.id ?? "new"} room={editingRoom} sites={sites} open={dialogOpen} onOpenChange={setDialogOpen} onSaved={load} />}
    </AppLayout>
  );
}

function RoomCheckCard({ room, check, defaultCheckedBy, disabled, canAdmin, onSave, onEdit, onArchive }: {
  room: Room; check?: RoomCheck; defaultCheckedBy: string; disabled: boolean; canAdmin: boolean;
  onSave: (room: Room, values: CheckValues, notes: string, checkedBy: string) => void; onEdit: () => void; onArchive: () => void;
}) {
  const [values, setValues] = useState<CheckValues>(() => checkValues(check));
  const [notes, setNotes] = useState(check?.notes ?? "");
  const [checkedBy, setCheckedBy] = useState(check ? checkBy(check) ?? "" : defaultCheckedBy);
  useEffect(() => { setValues(checkValues(check)); setNotes(check?.notes ?? ""); setCheckedBy(check ? checkBy(check) ?? "" : defaultCheckedBy); }, [check, defaultCheckedBy]);
  const completeCount = Object.values(values).filter(Boolean).length;
  const isComplete = completeCount === OUTCOMES.length;
  return <Card className={cn("rounded-sm border-l-4 p-4", isComplete ? "border-l-emerald-500" : "border-l-amber-400 bg-amber-50/40")}>
    <div className="mb-3 flex items-start justify-between gap-3"><div><h2 className="font-semibold">{roomNumber(room) || room.name}</h2>{room.name && roomNumber(room) && <p className="text-xs text-muted-foreground">{room.name}</p>}<p className="mt-1 text-xs text-muted-foreground">{room.floor || "Floor not recorded"}{room.notes ? ` · ${room.notes}` : ""}</p></div>{isComplete ? <Badge variant="outline" className="rounded-sm border-emerald-300 bg-emerald-50 text-emerald-800"><CheckCircle2 className="mr-1 h-3 w-3" />Complete · 3/3</Badge> : <Badge variant="outline" className="rounded-sm border-amber-300 bg-amber-50 text-amber-800"><AlertCircle className="mr-1 h-3 w-3" />Requires attention · {completeCount}/3</Badge>}</div>
    <fieldset className="mb-3"><legend className="mb-1.5 text-xs font-medium">Housekeeping checks ({completeCount}/3)</legend><div className="grid gap-2 sm:grid-cols-3">{OUTCOMES.map(outcome => <button key={outcome.key} type="button" disabled={disabled} aria-pressed={values[outcome.key]} onClick={() => setValues(current => ({ ...current, [outcome.key]: !current[outcome.key] }))} className={cn("flex items-center justify-center gap-2 rounded-sm border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60", values[outcome.key] ? outcome.className : "border-border bg-background text-muted-foreground hover:bg-muted/40")}>{values[outcome.key] ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}{outcome.label}</button>)}</div></fieldset>
    <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor={`checked-by-${room.id}`} className="text-xs">Checked by</Label><Input id={`checked-by-${room.id}`} value={checkedBy} onChange={e => setCheckedBy(e.target.value)} placeholder="Name (optional)" className="h-8 text-xs" disabled={disabled} /></div><div className="space-y-1 sm:col-span-2"><Label htmlFor={`notes-${room.id}`} className="text-xs">Notes</Label><Textarea id={`notes-${room.id}`} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything needing attention (optional)" rows={2} className="text-xs" disabled={disabled} /></div></div>
    <div className="mt-3 flex items-center gap-2"><Button size="sm" className="gap-1.5" onClick={() => onSave(room, values, notes, checkedBy)} disabled={disabled}>{disabled ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}{check ? "Update check" : "Save check"}</Button>{canAdmin && <><Button variant="ghost" size="sm" onClick={onEdit}>Edit room</Button><Button variant="ghost" size="sm" onClick={onArchive} className="text-muted-foreground">Archive</Button></>}</div>
  </Card>;
}