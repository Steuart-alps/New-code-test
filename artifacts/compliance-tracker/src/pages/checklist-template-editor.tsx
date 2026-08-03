import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronUp, ChevronDown, Trash2, Plus, RotateCcw, Loader2, Save } from "lucide-react";

export interface TemplateItem {
  label: string;
  section?: string;
  checked?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: string;
  typeLabel: string;
  siteId: number | null;
  siteName?: string;
  defaultItems: TemplateItem[];
  onSaved: (items: TemplateItem[]) => void;
}

const NEW_SECTION = "__new__";

export function ChecklistTemplateEditor({
  open, onOpenChange, type, typeLabel, siteId, siteName, defaultItems, onSaved,
}: Props) {
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isCustom, setIsCustom] = useState(false);

  // Add-item form state
  const [newLabel, setNewLabel] = useState("");
  const [newSection, setNewSection] = useState("");
  const [newSectionCustom, setNewSectionCustom] = useState("");

  useEffect(() => {
    if (!open) return;
    (async () => {
      setLoading(true);
      const params = new URLSearchParams({ type });
      if (siteId) params.set("siteId", String(siteId));
      const r = await apiFetch(`/checklist-templates?${params}`);
      if (r.ok) {
        const data = await r.json();
        if (data.items) {
          setItems(data.items.map((i: TemplateItem) => ({ ...i, checked: false })));
          setIsCustom(true);
        } else {
          setItems(defaultItems.map(i => ({ ...i, checked: false })));
          setIsCustom(false);
        }
      } else {
        setItems(defaultItems.map(i => ({ ...i, checked: false })));
        setIsCustom(false);
      }
      setLoading(false);
    })();
  }, [open, type, siteId]);

  // Derived section list for the dropdown
  const sections = Array.from(new Set(items.map(i => i.section).filter(Boolean))) as string[];

  const moveUp = (i: number) => {
    if (i === 0) return;
    setItems(prev => {
      const next = [...prev];
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });
  };

  const moveDown = (i: number) => {
    setItems(prev => {
      if (i >= prev.length - 1) return prev;
      const next = [...prev];
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      return next;
    });
  };

  const remove = (i: number) => setItems(prev => prev.filter((_, idx) => idx !== i));

  const addItem = () => {
    const label = newLabel.trim();
    if (!label) return;
    const section = newSection === NEW_SECTION
      ? newSectionCustom.trim() || undefined
      : newSection || undefined;
    setItems(prev => [...prev, { label, section, checked: false }]);
    setNewLabel("");
  };

  const resetToDefault = () => {
    setItems(defaultItems.map(i => ({ ...i, checked: false })));
    setIsCustom(false);
  };

  async function save() {
    setSaving(true);
    try {
      const r = await apiFetch("/checklist-templates", {
        method: "PUT",
        body: JSON.stringify({ type, siteId: siteId ?? null, items }),
      });
      if (r.ok) {
        const data = await r.json();
        onSaved(data.items ?? items);
        onOpenChange(false);
      }
    } finally {
      setSaving(false);
    }
  }

  async function resetAndSave() {
    setSaving(true);
    try {
      const params = new URLSearchParams({ type });
      if (siteId) params.set("siteId", String(siteId));
      const r = await apiFetch(`/checklist-templates?${params}`, { method: "DELETE" });
      if (r.ok) {
        onSaved(defaultItems);
        onOpenChange(false);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b shrink-0">
          <SheetTitle className="font-display">Customise checklist</SheetTitle>
          <SheetDescription>
            <span className="font-medium text-foreground">{typeLabel}</span>
            {siteName ? <> · {siteName}</> : <> · all sites</>}
            {isCustom && <Badge variant="secondary" className="ml-2 text-[10px]">Custom</Badge>}
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Item list */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1.5">
              {items.map((item, i) => (
                <div key={i}>
                  {item.section && (item.section !== items[i - 1]?.section) && (
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70 mt-3 mb-1 px-1">
                      {item.section}
                    </p>
                  )}
                  <div className="flex items-center gap-1 border rounded-lg px-3 py-2 bg-card">
                    <span className="flex-1 text-sm">{item.label}</span>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveUp(i)} disabled={i === 0}>
                        <ChevronUp className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveDown(i)} disabled={i === items.length - 1}>
                        <ChevronDown className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => remove(i)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              {items.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">No items — add one below.</p>
              )}
            </div>

            {/* Add item form */}
            <div className="px-6 py-4 border-t bg-muted/30 space-y-3 shrink-0">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Add item</p>
              <div className="space-y-2">
                <div className="space-y-1">
                  <Label className="text-xs">Section</Label>
                  <Select value={newSection} onValueChange={setNewSection}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="No section / same as above" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No section</SelectItem>
                      {sections.map(s => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                      <SelectItem value={NEW_SECTION}>+ New section…</SelectItem>
                    </SelectContent>
                  </Select>
                  {newSection === NEW_SECTION && (
                    <Input
                      value={newSectionCustom}
                      onChange={e => setNewSectionCustom(e.target.value)}
                      placeholder="Section name"
                      className="h-8 text-sm mt-1"
                    />
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Check item *</Label>
                  <div className="flex gap-2">
                    <Input
                      value={newLabel}
                      onChange={e => setNewLabel(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }}
                      placeholder="e.g. Fire walk completed"
                      className="h-8 text-sm flex-1"
                    />
                    <Button size="sm" variant="outline" className="h-8 gap-1" onClick={addItem} disabled={!newLabel.trim()}>
                      <Plus className="w-3.5 h-3.5" /> Add
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer actions */}
            <div className="px-6 py-4 border-t flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={resetAndSave} disabled={saving || !isCustom}>
                <RotateCcw className="w-3.5 h-3.5" /> Reset to default
              </Button>
              <div className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button size="sm" className="gap-1.5" onClick={save} disabled={saving || items.length === 0}>
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
