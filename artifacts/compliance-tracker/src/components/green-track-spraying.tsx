import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  AlertTriangle, Archive, ArchiveRestore, Download, History, Minus, Package, Pencil, Plus, SprayCan, Trash2, Truck, ClipboardList,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StaffPerformerSelect } from "@/components/staff-performer-select";
import { useToast } from "@/hooks/use-toast";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useAuth } from "@/context/auth-context";
import { getApiErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useFocusNewRow } from "@/hooks/use-focus-new-row";
import { sortByLabel, sortedEntries } from "@/lib/sort-options";

// GreenTrack spraying book and stock. Products (pesticides, fertiliser, top
// dressing...) have stock worked out by the server from deliveries, counts,
// write-offs, quantities used and the spraying records that use them.

export const PRODUCT_CATEGORY_LABELS: Record<string, string> = {
  pesticide: "Pesticide (plant protection product)",
  fertiliser: "Fertiliser",
  top_dressing: "Top dressing",
  seed: "Seed",
  wetting_agent: "Wetting agent",
  other: "Other",
};
const PRODUCT_CATEGORY_SHORT: Record<string, string> = {
  pesticide: "Pesticide", fertiliser: "Fertiliser", top_dressing: "Top dressing",
  seed: "Seed", wetting_agent: "Wetting agent", other: "Other",
};
const UNIT_LABELS: Record<string, string> = {
  L: "litres (L)", kg: "kilograms (kg)", t: "tonnes (t)", bag: "bags", unit: "units (each)",
};
const METHOD_LABELS: Record<string, string> = {
  spray: "Sprayed", granular: "Spread (granular)", top_dressing: "Top dressing", other: "Other",
};
const AREA_LABELS: Record<string, string> = {
  greens: "Greens", tees: "Tees", fairways: "Fairways", approaches: "Approaches", surrounds: "Surrounds",
  bunkers: "Bunkers", rough: "Rough", practice: "Practice area", other: "Other",
};
const MOVEMENT_LABELS: Record<string, string> = {
  delivery: "Delivery", count: "Stock count", write_off: "Write-off", use: "Used", application: "Applied",
};

/** Stock records other than spraying records. "use" is refused for pesticides. */
type MovementKind = "delivery" | "count" | "write_off" | "use";

export interface GreenProduct {
  id: number;
  name: string;
  category: string;
  unit: string;
  mappNumber: string | null;
  activeIngredient: string | null;
  supplier: string | null;
  reorderLevel: number | null;
  notes: string | null;
  active: boolean;
  stockOnHand: number;
  lowStock: boolean;
  lastDeliveryDate: string | null;
  lastCountDate: string | null;
}

interface LedgerEntry {
  key: string;
  kind: MovementKind | "application";
  date: string;
  change: number;
  balance: number;
  countedQuantity: number | null;
  movementId: number | null;
  applicationId: number | null;
  detail: string | null;
  recordedBy: string | null;
}

interface StockMovement {
  id: number;
  productId: number;
  movementDate: string;
  kind: MovementKind;
  quantity: number;
  countedQuantity: number | null;
  supplier: string | null;
  batchNumber: string | null;
  reference: string | null;
  recordedBy: string | null;
  recordedByRosterId: number | null;
  notes: string | null;
}

interface ApplicationProduct {
  productId: number;
  productName: string;
  category: string;
  unit: string;
  mappNumber: string | null;
  ratePerHectare: number | null;
  quantityUsed: number;
}

export interface GreenApplication {
  id: number;
  applicationDate: string;
  startTime: string | null;
  endTime: string | null;
  method: string;
  machineId: number | null;
  machineName: string | null;
  areas: string[];
  areaDetails: string | null;
  areaHectares: number | null;
  waterVolumeLitres: number | null;
  nozzle: string | null;
  reason: string | null;
  operatorName: string | null;
  operatorRosterId: number | null;
  operatorCertificate: string | null;
  weather: string | null;
  wind: string | null;
  temperatureC: number | null;
  notes: string | null;
  products: ApplicationProduct[];
}

interface StockWarning { productId: number; productName: string; unit: string; stockOnHand: number }

interface MachineOption { id: number; name: string; type: string; active: boolean }

function fmt(d: string | null | undefined) {
  if (!d) return "—";
  try { return format(new Date(`${d.slice(0, 10)}T12:00:00`), "dd/MM/yyyy"); } catch { return d; }
}

/** A quantity in its unit, e.g. "12.5 L", "3 bags". */
export function qty(value: number | null | undefined, unit: string) {
  if (value == null) return "—";
  const n = Number(value).toLocaleString("en-GB", { maximumFractionDigits: 3 });
  if (unit === "bag") return `${n} ${Math.abs(value) === 1 ? "bag" : "bags"}`;
  if (unit === "unit") return `${n} ${Math.abs(value) === 1 ? "unit" : "units"}`;
  return `${n} ${unit}`;
}

function signed(value: number, unit: string) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${qty(Math.abs(value), unit)}`;
}

function areaText(a: Pick<GreenApplication, "areas" | "areaDetails">) {
  const named = a.areas.map(x => AREA_LABELS[x] ?? x).join(", ");
  return [named, a.areaDetails].filter(Boolean).join(" — ") || "—";
}

function useJsonApi() {
  const request = useActiveClientApi();
  return useCallback(async <T = any,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await request(path, init);
    if (!response.ok) throw new Error(await getApiErrorMessage(response, `Request failed: ${response.status}`));
    return response.json() as Promise<T>;
  }, [request]);
}

function useInvalidateSpraying() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ["green-products", "green-applications", "green-product-history", "green-status"]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

function useProducts() {
  const { activeClientId } = useAuth();
  const api = useJsonApi();
  return useQuery({
    queryKey: ["green-products", activeClientId],
    queryFn: () => api<GreenProduct[]>("/green-track/products"),
  });
}

const today = () => new Date().toISOString().split("T")[0];

// ─── Product dialog ───────────────────────────────────────────────────────────

function ProductDialog({ open, onClose, product }: { open: boolean; onClose: () => void; product: GreenProduct | null }) {
  const { toast } = useToast();
  const api = useJsonApi();
  const invalidate = useInvalidateSpraying();
  const blank = { name: "", category: "pesticide", unit: "L", mappNumber: "", activeIngredient: "", supplier: "", reorderLevel: "", notes: "", openingStock: "" };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const reset = () => setForm(product ? {
    name: product.name, category: product.category, unit: product.unit, mappNumber: product.mappNumber ?? "",
    activeIngredient: product.activeIngredient ?? "", supplier: product.supplier ?? "",
    reorderLevel: product.reorderLevel == null ? "" : String(product.reorderLevel), notes: product.notes ?? "", openingStock: "",
  } : blank);

  const save = async () => {
    if (!form.name.trim()) { toast({ title: "Enter the product name", variant: "destructive" }); return; }
    if (!product && form.openingStock.trim() !== "" && !(Number(form.openingStock) >= 0)) {
      toast({ title: "Enter the amount in stock now as a number", variant: "destructive" }); return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(), category: form.category, unit: form.unit,
        mappNumber: form.mappNumber.trim() || null, activeIngredient: form.activeIngredient.trim() || null,
        supplier: form.supplier.trim() || null, reorderLevel: form.reorderLevel === "" ? null : Number(form.reorderLevel),
        notes: form.notes.trim() || null,
        // Saved as today's stock count, so use comes off it from the start.
        ...(!product && form.openingStock.trim() !== "" ? { openingStock: Number(form.openingStock) } : {}),
      };
      await api(product ? `/green-track/products/${product.id}` : "/green-track/products", {
        method: product ? "PUT" : "POST", body: JSON.stringify(body),
      });
      toast({ title: product ? "Product updated" : "Product added" });
      invalidate(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={() => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader><DialogTitle>{product ? "Edit Product" : "Add Product"}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <Label>Product name *</Label>
            <Input className="mt-1 rounded-sm" value={form.name} data-testid="input-product-name"
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Heritage Maxx" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Type</Label>
              <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                <SelectTrigger className="mt-1 rounded-sm" data-testid="select-product-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {sortedEntries(PRODUCT_CATEGORY_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Stock kept in</Label>
              <Select value={form.unit} onValueChange={v => setForm(f => ({ ...f, unit: v }))}>
                <SelectTrigger className="mt-1 rounded-sm" data-testid="select-product-unit"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {sortedEntries(UNIT_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.category === "pesticide" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>MAPP number</Label>
                <Input className="mt-1 rounded-sm" value={form.mappNumber} placeholder="e.g. 17654"
                  onChange={e => setForm(f => ({ ...f, mappNumber: e.target.value }))} />
              </div>
              <div>
                <Label>Active ingredient</Label>
                <Input className="mt-1 rounded-sm" value={form.activeIngredient}
                  onChange={e => setForm(f => ({ ...f, activeIngredient: e.target.value }))} />
              </div>
            </div>
          )}
          {!product && (
            <div>
              <Label>Amount in stock now <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" min="0" step="any" inputMode="decimal" className="mt-1 rounded-sm" value={form.openingStock}
                data-testid="input-opening-stock" placeholder={`in ${form.unit}`}
                onChange={e => setForm(f => ({ ...f, openingStock: e.target.value }))} />
              <p className="text-xs text-muted-foreground mt-1">What you have on the shelf today. Spraying records and quantities used come off it.</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Supplier <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.supplier}
                onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))} />
            </div>
            <div>
              <Label>Re-order level <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" min="0" step="any" inputMode="decimal" className="mt-1 rounded-sm" value={form.reorderLevel}
                data-testid="input-reorder-level"
                onChange={e => setForm(f => ({ ...f, reorderLevel: e.target.value }))} placeholder={`in ${form.unit}`} />
            </div>
          </div>
          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" rows={2} value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : product ? "Save changes" : "Add product"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delivery / stock count / write-off / used dialog ─────────────────────────

function StockMovementDialog({ open, onClose, kind, products, presetProductId, movement }: {
  open: boolean; onClose: () => void;
  kind: MovementKind;
  products: GreenProduct[];
  presetProductId?: number;
  movement?: StockMovement | null;
}) {
  const { toast } = useToast();
  const api = useJsonApi();
  const invalidate = useInvalidateSpraying();
  const blank = { productId: "", movementDate: today(), quantity: "", supplier: "", batchNumber: "", reference: "", recordedBy: "", recordedByRosterId: null as number | null, notes: "" };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const product = products.find(p => String(p.id) === form.productId);
  const reset = () => setForm(movement ? {
    productId: String(movement.productId), movementDate: movement.movementDate,
    quantity: String(movement.kind === "count" ? movement.countedQuantity ?? "" : Math.abs(movement.quantity)),
    supplier: movement.supplier ?? "", batchNumber: movement.batchNumber ?? "", reference: movement.reference ?? "",
    recordedBy: movement.recordedBy ?? "", recordedByRosterId: movement.recordedByRosterId, notes: movement.notes ?? "",
  } : { ...blank, productId: presetProductId ? String(presetProductId) : "" });

  const title = { delivery: "Log Delivery", count: "Stock Count", write_off: "Write Off Stock", use: "Log Quantity Used" }[kind];
  const save = async () => {
    if (!form.productId) { toast({ title: "Select a product", variant: "destructive" }); return; }
    const amount = Number(form.quantity);
    if (form.quantity.trim() === "" || !(amount >= 0) || (kind !== "count" && amount <= 0)) {
      toast({ title: kind === "count" ? "Enter the quantity counted" : "Enter a quantity above 0", variant: "destructive" }); return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        movementDate: form.movementDate,
        ...(kind === "count" ? { countedQuantity: amount } : { quantity: amount }),
        supplier: form.supplier.trim() || null, batchNumber: form.batchNumber.trim() || null,
        reference: form.reference.trim() || null, recordedBy: form.recordedBy.trim() || null,
        recordedByRosterId: form.recordedByRosterId, notes: form.notes.trim() || null,
      };
      if (!movement) Object.assign(body, { productId: Number(form.productId), kind });
      await api(movement ? `/green-track/stock-movements/${movement.id}` : "/green-track/stock-movements", {
        method: movement ? "PUT" : "POST", body: JSON.stringify(body),
      });
      toast({ title: { delivery: "Delivery logged", count: "Stock count saved", write_off: "Stock written off", use: "Taken off stock" }[kind] });
      invalidate(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={() => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader><DialogTitle>{movement ? `Edit ${MOVEMENT_LABELS[kind]}` : title}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <Label>Product *</Label>
            <Select value={form.productId || "_none"} disabled={!!movement} onValueChange={v => setForm(f => ({ ...f, productId: v === "_none" ? "" : v }))}>
              <SelectTrigger className="mt-1 rounded-sm" data-testid="select-stock-product"><SelectValue placeholder="Select product" /></SelectTrigger>
              <SelectContent>
                {sortByLabel(products.filter(p => (p.active && !(kind === "use" && p.category === "pesticide")) || String(p.id) === form.productId), p => p.name).map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {product && !movement && (
              <p className="text-xs text-muted-foreground mt-1" data-testid="text-stock-now">In stock now: {qty(product.stockOnHand, product.unit)}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.movementDate}
                onChange={e => setForm(f => ({ ...f, movementDate: e.target.value }))} />
            </div>
            <div>
              <Label>{{ count: "Quantity counted *", delivery: "Quantity delivered *", write_off: "Quantity written off *", use: "Quantity used *" }[kind]}</Label>
              <Input type="number" min="0" step="any" inputMode="decimal" className="mt-1 rounded-sm" value={form.quantity}
                data-testid="input-stock-quantity" placeholder={product ? `in ${product.unit}` : ""}
                onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} />
            </div>
          </div>
          {kind === "delivery" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Supplier <span className="text-muted-foreground text-xs">optional</span></Label>
                  <Input className="mt-1 rounded-sm" value={form.supplier} placeholder={product?.supplier ?? ""}
                    onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))} />
                </div>
                <div>
                  <Label>Batch number <span className="text-muted-foreground text-xs">optional</span></Label>
                  <Input className="mt-1 rounded-sm" value={form.batchNumber}
                    onChange={e => setForm(f => ({ ...f, batchNumber: e.target.value }))} />
                </div>
              </div>
              <div>
                <Label>Delivery note or invoice <span className="text-muted-foreground text-xs">optional</span></Label>
                <Input className="mt-1 rounded-sm" value={form.reference}
                  onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} />
              </div>
            </>
          )}
          {kind === "count" && (
            <p className="text-xs text-muted-foreground">The count replaces the stock figure from that day on. Spraying and deliveries logged after it carry on from the counted figure.</p>
          )}
          <div>
            <StaffPerformerSelect label="Recorded by" value={form.recordedBy} optional
              onChange={v => setForm(f => ({ ...f, recordedBy: v }))}
              onRosterIdChange={v => setForm(f => ({ ...f, recordedByRosterId: v }))} />
          </div>
          <div>
            <Label>{kind === "write_off" ? "Reason" : kind === "use" ? "What it was used for" : "Notes"} <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" rows={2} value={form.notes}
              placeholder={kind === "write_off" ? "e.g. spilt, out of date, returned to supplier" : kind === "use" ? "e.g. divot mix on the tees, overseeding the 3rd green" : ""}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Product history ──────────────────────────────────────────────────────────

function ProductHistoryDialog({ product, onClose, canAdmin, onEditMovement }: {
  product: GreenProduct | null; onClose: () => void; canAdmin: boolean;
  onEditMovement: (movementId: number) => void;
}) {
  const { activeClientId } = useAuth();
  const api = useJsonApi();
  const { toast } = useToast();
  const invalidate = useInvalidateSpraying();
  const { data, isLoading } = useQuery({
    queryKey: ["green-product-history", activeClientId, product?.id],
    queryFn: () => api<{ product: GreenProduct; entries: LedgerEntry[] }>(`/green-track/products/${product!.id}/history`),
    enabled: !!product,
  });
  const remove = async (movementId: number) => {
    try {
      await api(`/green-track/stock-movements/${movementId}`, { method: "DELETE" });
      toast({ title: "Stock record deleted" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    }
  };
  const unit = product?.unit ?? "";
  return (
    <Dialog open={!!product} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{product?.name}: stock history</DialogTitle></DialogHeader>
        {data && (
          <p className="text-sm">In stock now: <span className="font-semibold" data-testid="text-history-stock">{qty(data.product.stockOnHand, unit)}</span></p>
        )}
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-6 text-center animate-pulse">Loading…</p>
        ) : !data?.entries.length ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No deliveries, counts or spraying records yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-stock-history">
              <thead>
                <tr className="border-b text-muted-foreground text-xs">
                  <th className="text-left font-medium py-2 pr-3">Date</th>
                  <th className="text-left font-medium py-2 pr-3">What</th>
                  <th className="text-right font-medium py-2 pr-3">Change</th>
                  <th className="text-right font-medium py-2 pr-3">Stock</th>
                  <th className="text-left font-medium py-2 pr-3 hidden sm:table-cell">Details</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {data.entries.map(e => (
                  <tr key={e.key} className="border-b last:border-0">
                    <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">{fmt(e.date)}</td>
                    <td className="py-1.5 pr-3">
                      {e.kind === "application" ? "Used (spraying book)" : MOVEMENT_LABELS[e.kind]}
                      {e.kind === "count" && e.countedQuantity != null && <span className="text-muted-foreground"> ({qty(e.countedQuantity, unit)})</span>}
                    </td>
                    <td className={cn("py-1.5 pr-3 text-right tabular-nums whitespace-nowrap", e.change < 0 ? "text-rose-700 dark:text-rose-400" : e.change > 0 ? "text-emerald-700 dark:text-emerald-400" : "")}>
                      {signed(e.change, unit)}
                    </td>
                    <td className={cn("py-1.5 pr-3 text-right tabular-nums whitespace-nowrap", e.balance < 0 && "text-destructive font-medium")}>{qty(e.balance, unit)}</td>
                    <td className="py-1.5 pr-3 text-xs text-muted-foreground hidden sm:table-cell">
                      {[e.detail, e.recordedBy].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      {e.movementId != null && (
                        <>
                          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Edit stock record" onClick={() => onEditMovement(e.movementId!)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          {canAdmin && (
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" aria-label="Delete stock record"
                              onClick={() => { if (window.confirm("Delete this stock record?")) void remove(e.movementId!); }}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Stock tab ────────────────────────────────────────────────────────────────

export function GreenStockTab({ q, canAdmin, onRecordSpraying }: {
  q: string; canAdmin: boolean;
  /** Pesticide use goes in the spraying book: opens a new spraying record for the product. */
  onRecordSpraying: (productId: number) => void;
}) {
  const { toast } = useToast();
  const api = useJsonApi();
  const invalidate = useInvalidateSpraying();
  const { data: products = [], isLoading } = useProducts();
  const [showArchived, setShowArchived] = useState(false);
  const [productDialog, setProductDialog] = useState(false);
  const [editProduct, setEditProduct] = useState<GreenProduct | null>(null);
  const [movementKind, setMovementKind] = useState<MovementKind | null>(null);
  const [movementProductId, setMovementProductId] = useState<number | undefined>();
  const [editMovement, setEditMovement] = useState<StockMovement | null>(null);
  const [historyProduct, setHistoryProduct] = useState<GreenProduct | null>(null);
  const [deleteProduct, setDeleteProduct] = useState<GreenProduct | null>(null);

  const shown = products.filter(p => (showArchived || p.active)
    && (p.name.toLowerCase().includes(q) || (p.mappNumber ?? "").toLowerCase().includes(q) || (p.supplier ?? "").toLowerCase().includes(q)));
  const archivedCount = products.filter(p => !p.active).length;

  const openMovement = (kind: MovementKind, productId?: number) => {
    setEditMovement(null); setMovementProductId(productId); setMovementKind(kind);
  };
  const editMovementById = async (movementId: number) => {
    try {
      const rows = await api<StockMovement[]>(`/green-track/stock-movements?productId=${historyProduct?.id ?? ""}&limit=1000`);
      const movement = rows.find(r => r.id === movementId);
      if (!movement) throw new Error("Stock record not found");
      setEditMovement(movement); setMovementKind(movement.kind);
    } catch (err: any) {
      toast({ title: "Could not open the record", description: err.message, variant: "destructive" });
    }
  };
  const setActive = async (p: GreenProduct, active: boolean) => {
    try {
      await api(`/green-track/products/${p.id}`, { method: "PUT", body: JSON.stringify({ active }) });
      toast({ title: active ? "Product restored" : "Product archived" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    }
  };
  const remove = async () => {
    if (!deleteProduct) return;
    try {
      await api(`/green-track/products/${deleteProduct.id}`, { method: "DELETE" });
      toast({ title: "Product deleted" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    } finally { setDeleteProduct(null); }
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground bg-muted/40 rounded-sm px-3 py-2 flex items-start gap-2 flex-1 min-w-[16rem]">
          <Package className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Log deliveries as they arrive and press Used to take off what was used (pesticides go in the spraying book). A stock count sets the figure to what is on the shelf.</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="rounded-sm gap-1.5 h-8" onClick={() => openMovement("count")} disabled={!products.length}>
            <ClipboardList className="w-3.5 h-3.5" /> Stock count
          </Button>
          <Button size="sm" variant="outline" className="rounded-sm gap-1.5 h-8" onClick={() => openMovement("delivery")} disabled={!products.length} data-testid="button-log-delivery">
            <Truck className="w-3.5 h-3.5" /> Log delivery
          </Button>
          <Button size="sm" className="rounded-sm gap-1.5 h-8" onClick={() => { setEditProduct(null); setProductDialog(true); }} data-testid="button-add-product">
            <Plus className="w-3.5 h-3.5" /> Add product
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading stock…</div>
      ) : shown.length === 0 ? (
        <div className="text-center py-10 border border-dashed rounded-sm">
          <Package className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground">No products yet. Add your pesticides, fertilisers and top dressings to keep track of stock.</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-border rounded-sm">
          <table className="w-full text-sm" data-testid="table-products">
            <thead className="bg-muted/40 border-b border-border">
              <tr className="text-muted-foreground text-xs">
                <th className="text-left font-medium px-3 py-2">Product</th>
                <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Type</th>
                <th className="text-right font-medium px-3 py-2">In stock</th>
                <th className="text-right font-medium px-3 py-2 hidden sm:table-cell">Re-order at</th>
                <th className="text-left font-medium px-3 py-2 hidden lg:table-cell">Last delivery</th>
                <th className="w-64" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map(p => (
                <tr key={p.id} className={cn(!p.active && "opacity-60")} data-testid={`product-row-${p.id}`}>
                  <td className="px-3 py-2">
                    <p className="font-medium">{p.name}{!p.active && <Badge variant="outline" className="ml-2 text-[10px]">Archived</Badge>}</p>
                    {p.mappNumber && <p className="text-xs text-muted-foreground">MAPP {p.mappNumber}{p.activeIngredient ? ` · ${p.activeIngredient}` : ""}</p>}
                  </td>
                  <td className="px-3 py-2 hidden md:table-cell text-muted-foreground">{PRODUCT_CATEGORY_SHORT[p.category] ?? p.category}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium",
                    p.stockOnHand < 0 ? "text-destructive" : p.lowStock ? "text-amber-600 dark:text-amber-400" : "")}
                    data-testid={`product-stock-${p.id}`}>
                    {(p.lowStock || p.stockOnHand < 0) && <AlertTriangle className="inline w-3 h-3 mr-1" />}
                    {qty(p.stockOnHand, p.unit)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell text-muted-foreground">{p.reorderLevel == null ? "—" : qty(p.reorderLevel, p.unit)}</td>
                  <td className="px-3 py-2 hidden lg:table-cell text-muted-foreground">{fmt(p.lastDeliveryDate)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {p.active && (
                      <>
                        <Button size="sm" variant="outline" className="h-7 text-xs rounded-sm mr-1" onClick={() => openMovement("delivery", p.id)}>Delivery</Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs rounded-sm mr-1" data-testid={`button-used-${p.id}`}
                          title={p.category === "pesticide" ? "Record the spray in the spraying book" : "Take the quantity used off stock"}
                          onClick={() => p.category === "pesticide" ? onRecordSpraying(p.id) : openMovement("use", p.id)}>Used</Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Write off stock" title="Write off (spilt, out of date)" onClick={() => openMovement("write_off", p.id)}>
                          <Minus className="w-3.5 h-3.5" />
                        </Button>
                      </>
                    )}
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Stock history" title="Stock history" onClick={() => setHistoryProduct(p)}>
                      <History className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Edit product" onClick={() => { setEditProduct(p); setProductDialog(true); }}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={p.active ? "Archive product" : "Restore product"}
                      title={p.active ? "Archive" : "Restore"} onClick={() => setActive(p, !p.active)}>
                      {p.active ? <Archive className="w-3.5 h-3.5" /> : <ArchiveRestore className="w-3.5 h-3.5" />}
                    </Button>
                    {canAdmin && (
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" aria-label="Delete product" onClick={() => setDeleteProduct(p)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {archivedCount > 0 && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} /> Show archived products ({archivedCount})
        </label>
      )}

      <ProductDialog open={productDialog} onClose={() => setProductDialog(false)} product={editProduct} />
      {movementKind && (
        <StockMovementDialog open={!!movementKind} kind={movementKind} products={products} presetProductId={movementProductId}
          movement={editMovement} onClose={() => { setMovementKind(null); setEditMovement(null); }} />
      )}
      <ProductHistoryDialog product={historyProduct} canAdmin={canAdmin} onClose={() => setHistoryProduct(null)} onEditMovement={editMovementById} />
      <AlertDialog open={!!deleteProduct} onOpenChange={v => !v && setDeleteProduct(null)}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteProduct?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Only a product with no deliveries or spraying records can be deleted. Archive it instead to keep its records.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Spraying record dialog ───────────────────────────────────────────────────

interface ProductLine { productId: string; rate: string; quantity: string }

function ApplicationDialog({ open, onClose, application, machines, products, recent, presetMachineId, presetProductId }: {
  open: boolean; onClose: () => void;
  application: GreenApplication | null;
  presetMachineId?: number;
  presetProductId?: number;
  machines: MachineOption[];
  products: GreenProduct[];
  recent: GreenApplication[];
}) {
  const { toast } = useToast();
  const request = useActiveClientApi();
  const invalidate = useInvalidateSpraying();
  const blank = {
    applicationDate: today(), startTime: "", endTime: "", method: "spray", machineId: "",
    areas: [] as string[], areaDetails: "", areaHectares: "", waterVolumeLitres: "", nozzle: "", reason: "",
    operatorName: "", operatorRosterId: null as number | null, operatorCertificate: "",
    weather: "", wind: "", temperatureC: "", notes: "",
  };
  const [form, setForm] = useState(blank);
  const [lines, setLines] = useState<ProductLine[]>([{ productId: "", rate: "", quantity: "" }]);
  const newRow = useFocusNewRow();
  const [saving, setSaving] = useState(false);
  const str = (v: number | null) => (v == null ? "" : String(v));

  const reset = () => {
    if (application) {
      setForm({
        applicationDate: application.applicationDate, startTime: application.startTime ?? "", endTime: application.endTime ?? "",
        method: application.method, machineId: application.machineId ? String(application.machineId) : "",
        areas: application.areas, areaDetails: application.areaDetails ?? "", areaHectares: str(application.areaHectares),
        waterVolumeLitres: str(application.waterVolumeLitres), nozzle: application.nozzle ?? "", reason: application.reason ?? "",
        operatorName: application.operatorName ?? "", operatorRosterId: application.operatorRosterId,
        operatorCertificate: application.operatorCertificate ?? "", weather: application.weather ?? "",
        wind: application.wind ?? "", temperatureC: str(application.temperatureC), notes: application.notes ?? "",
      });
      setLines(application.products.map(p => ({ productId: String(p.productId), rate: str(p.ratePerHectare), quantity: String(p.quantityUsed) })));
    } else {
      setForm({ ...blank, machineId: presetMachineId ? String(presetMachineId) : "" });
      setLines([{ productId: presetProductId ? String(presetProductId) : "", rate: "", quantity: "" }]);
    }
  };

  const hectares = Number(form.areaHectares);
  const setOperator = (name: string) => setForm(f => {
    // Fill in the operator's certificate from their last record.
    const last = recent.find(a => a.operatorName === name && a.operatorCertificate);
    return { ...f, operatorName: name, operatorCertificate: f.operatorCertificate || last?.operatorCertificate || "" };
  });
  const toggleArea = (area: string) => setForm(f => ({
    ...f, areas: f.areas.includes(area) ? f.areas.filter(a => a !== area) : [...f.areas, area],
  }));
  const updateLine = (i: number, patch: Partial<ProductLine>) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const usable = products.filter(p => p.active || lines.some(l => l.productId === String(p.id)));

  const save = async () => {
    const filled = lines.filter(l => l.productId);
    if (!filled.length) { toast({ title: "Add the products used", variant: "destructive" }); return; }
    if (filled.some(l => !(Number(l.quantity) > 0))) { toast({ title: "Enter the quantity used for each product", variant: "destructive" }); return; }
    if (!form.areas.length && !form.areaDetails.trim()) { toast({ title: "Say where it was applied", variant: "destructive" }); return; }
    if (!form.operatorName.trim()) { toast({ title: "Say who applied it", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const num = (v: string) => (v.trim() === "" ? null : Number(v));
      const body = {
        applicationDate: form.applicationDate, startTime: form.startTime || null, endTime: form.endTime || null,
        method: form.method, machineId: form.machineId ? Number(form.machineId) : null,
        areas: form.areas, areaDetails: form.areaDetails.trim() || null, areaHectares: num(form.areaHectares),
        waterVolumeLitres: num(form.waterVolumeLitres), nozzle: form.nozzle.trim() || null, reason: form.reason.trim() || null,
        operatorName: form.operatorName.trim(), operatorRosterId: form.operatorRosterId,
        operatorCertificate: form.operatorCertificate.trim() || null, weather: form.weather.trim() || null,
        wind: form.wind.trim() || null, temperatureC: num(form.temperatureC), notes: form.notes.trim() || null,
        products: filled.map(l => ({ productId: Number(l.productId), ratePerHectare: num(l.rate), quantityUsed: Number(l.quantity) })),
      };
      const response = await request(application ? `/green-track/applications/${application.id}` : "/green-track/applications", {
        method: application ? "PUT" : "POST", body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not save the record"));
      const saved = await response.json() as { stockWarnings?: StockWarning[] };
      const warnings = saved.stockWarnings ?? [];
      toast({
        title: application ? "Spraying record updated" : "Spraying record saved",
        description: warnings.length
          ? `Stock is now below zero for ${warnings.map(w => `${w.productName} (${qty(w.stockOnHand, w.unit)})`).join(", ")}. Log the delivery or a stock count.`
          : undefined,
        variant: warnings.length ? "destructive" : undefined,
      });
      invalidate(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const machineOptions = machines.filter(m => m.active || String(m.id) === form.machineId)
    .sort((a, b) => Number(b.type === "sprayer_spreader") - Number(a.type === "sprayer_spreader") || a.name.localeCompare(b.name));

  return (
    <Dialog open={open} onOpenChange={() => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-2xl rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader><DialogTitle>{application ? "Edit Spraying Record" : "Record Spraying"}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="col-span-2 sm:col-span-1">
              <Label>Date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.applicationDate}
                onChange={e => setForm(f => ({ ...f, applicationDate: e.target.value }))} />
            </div>
            <div>
              <Label>Start</Label>
              <Input type="time" className="mt-1 rounded-sm" value={form.startTime} onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))} />
            </div>
            <div>
              <Label>Finish</Label>
              <Input type="time" className="mt-1 rounded-sm" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))} />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <Label>Method</Label>
              <Select value={form.method} onValueChange={v => setForm(f => ({ ...f, method: v }))}>
                <SelectTrigger className="mt-1 rounded-sm" data-testid="select-application-method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {sortedEntries(METHOD_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Where *</Label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {Object.entries(AREA_LABELS).map(([k, v]) => (
                <button key={k} type="button" onClick={() => toggleArea(k)} data-testid={`area-${k}`}
                  className={cn("rounded-sm border px-2.5 py-1 text-xs transition-colors",
                    form.areas.includes(k) ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted")}>
                  {v}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3 mt-2">
              <Input className="col-span-2 rounded-sm" value={form.areaDetails} placeholder="Details, e.g. greens 1–9 and putting green"
                onChange={e => setForm(f => ({ ...f, areaDetails: e.target.value }))} />
              <Input type="number" min="0" step="any" inputMode="decimal" className="rounded-sm" value={form.areaHectares}
                placeholder="Area (ha)" aria-label="Area treated in hectares" data-testid="input-area-hectares"
                onChange={e => setForm(f => ({ ...f, areaHectares: e.target.value }))} />
            </div>
            <p className="text-xs text-muted-foreground mt-1">Area in hectares: 1 hectare is 10,000 m². A typical green is about 0.05 ha.</p>
          </div>

          <div>
            <Label>Products used *</Label>
            <div ref={newRow.ref} className="mt-1 space-y-2">
              {lines.map((line, i) => {
                const product = products.find(p => String(p.id) === line.productId);
                const suggested = product && Number(line.rate) > 0 && hectares > 0 ? Math.round(Number(line.rate) * hectares * 1000) / 1000 : null;
                return (
                  <div key={i} className="rounded-sm border p-2 space-y-1.5" data-testid={`product-line-${i}`}>
                    <div className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-12 sm:col-span-5">
                        <Select value={line.productId || "_none"} onValueChange={v => updateLine(i, { productId: v === "_none" ? "" : v })}>
                          <SelectTrigger className="rounded-sm" data-testid={`select-line-product-${i}`}><SelectValue placeholder="Select product" /></SelectTrigger>
                          <SelectContent>
                            {sortByLabel(usable, p => p.name).map(p => (
                              <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Input className="col-span-5 sm:col-span-3 rounded-sm" type="number" min="0" step="any" inputMode="decimal"
                        value={line.rate} placeholder={product ? `Rate ${product.unit}/ha` : "Rate per ha"} aria-label="Rate per hectare"
                        onChange={e => updateLine(i, { rate: e.target.value })} />
                      <Input className="col-span-5 sm:col-span-3 rounded-sm" type="number" min="0" step="any" inputMode="decimal"
                        value={line.quantity} placeholder={product ? `Used (${product.unit})` : "Quantity used"} aria-label="Quantity used"
                        data-testid={`input-line-quantity-${i}`}
                        onChange={e => updateLine(i, { quantity: e.target.value })} />
                      <Button type="button" size="icon" variant="ghost" className="col-span-2 sm:col-span-1 h-8 w-8" aria-label="Remove product"
                        disabled={lines.length === 1} onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    {product && (
                      <p className="text-xs text-muted-foreground">
                        {product.mappNumber ? `MAPP ${product.mappNumber} · ` : ""}In stock: {qty(product.stockOnHand, product.unit)}
                        {suggested != null && String(suggested) !== line.quantity && (
                          <> · <button type="button" className="underline" onClick={() => updateLine(i, { quantity: String(suggested) })}>
                            Use {qty(suggested, product.unit)} (rate × area)
                          </button></>
                        )}
                      </p>
                    )}
                  </div>
                );
              })}
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs rounded-sm gap-1"
                onClick={() => { newRow.expect(); setLines(ls => [...ls, { productId: "", rate: "", quantity: "" }]); }} disabled={lines.length >= 20}>
                <Plus className="w-3 h-3" /> Add another product (tank mix)
              </Button>
              {products.filter(p => p.active).length === 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400">Add your products on the Stock tab first.</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <StaffPerformerSelect label="Operator *" value={form.operatorName}
                onChange={setOperator}
                onRosterIdChange={v => setForm(f => ({ ...f, operatorRosterId: v }))} />
            </div>
            <div>
              <Label>Operator's certificate</Label>
              <Input className="mt-1 rounded-sm" value={form.operatorCertificate} placeholder="e.g. PA1, PA6 – NPTC number"
                onChange={e => setForm(f => ({ ...f, operatorCertificate: e.target.value }))} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label>Sprayer or spreader</Label>
              <Select value={form.machineId || "_none"} onValueChange={v => setForm(f => ({ ...f, machineId: v === "_none" ? "" : v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">— Not recorded —</SelectItem>
                  {machineOptions.map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Water volume (L)</Label>
              <Input type="number" min="0" step="any" inputMode="decimal" className="mt-1 rounded-sm" value={form.waterVolumeLitres}
                onChange={e => setForm(f => ({ ...f, waterVolumeLitres: e.target.value }))} />
            </div>
            <div>
              <Label>Nozzle</Label>
              <Input className="mt-1 rounded-sm" value={form.nozzle} placeholder="e.g. 03 air induction"
                onChange={e => setForm(f => ({ ...f, nozzle: e.target.value }))} />
            </div>
          </div>

          <div>
            <Label>Reason</Label>
            <Input className="mt-1 rounded-sm" value={form.reason} placeholder="e.g. fusarium patch, spring feed, worm casts"
              onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label>Weather</Label>
              <Input className="mt-1 rounded-sm" value={form.weather} placeholder="e.g. dry, overcast"
                onChange={e => setForm(f => ({ ...f, weather: e.target.value }))} />
            </div>
            <div>
              <Label>Wind</Label>
              <Input className="mt-1 rounded-sm" value={form.wind} placeholder="e.g. SW 5 mph"
                onChange={e => setForm(f => ({ ...f, wind: e.target.value }))} />
            </div>
            <div>
              <Label>Temperature (°C)</Label>
              <Input type="number" step="0.5" inputMode="decimal" className="mt-1 rounded-sm" value={form.temperatureC}
                onChange={e => setForm(f => ({ ...f, temperatureC: e.target.value }))} />
            </div>
          </div>

          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" rows={2} value={form.notes} placeholder="e.g. signs put out, buffer zone kept"
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving} data-testid="button-save-application">{saving ? "Saving…" : application ? "Save changes" : "Save record"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Spraying tab ─────────────────────────────────────────────────────────────

function csvCell(value: unknown) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadSprayingBook(applications: GreenApplication[]) {
  const header = [
    "Date", "Start", "Finish", "Method", "Areas", "Area (ha)", "Product", "MAPP number", "Rate per ha", "Quantity used", "Unit",
    "Water volume (L)", "Sprayer or spreader", "Nozzle", "Reason", "Operator", "Operator certificate", "Weather", "Wind", "Temperature (°C)", "Notes",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const a of applications) {
    for (const p of a.products) {
      lines.push([
        a.applicationDate, a.startTime, a.endTime, METHOD_LABELS[a.method] ?? a.method, areaText(a), a.areaHectares,
        p.productName, p.mappNumber, p.ratePerHectare, p.quantityUsed, p.unit, a.waterVolumeLitres, a.machineName,
        a.nozzle, a.reason, a.operatorName, a.operatorCertificate, a.weather, a.wind, a.temperatureC, a.notes,
      ].map(csvCell).join(","));
    }
  }
  const blob = new Blob([`${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `spraying-book-${today()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function GreenSprayingTab({ q, canAdmin, machines, openNew, onOpenNewHandled }: {
  q: string; canAdmin: boolean; machines: MachineOption[];
  /** A machine chosen from a QR label scan, or a product's Used button on the Stock tab; opens a new record for it. */
  openNew?: { machineId?: number; productId?: number } | null;
  onOpenNewHandled?: () => void;
}) {
  const { activeClientId } = useAuth();
  const api = useJsonApi();
  const { toast } = useToast();
  const invalidate = useInvalidateSpraying();
  const { data: products = [] } = useProducts();
  const { data: applications = [], isLoading } = useQuery({
    queryKey: ["green-applications", activeClientId],
    queryFn: () => api<GreenApplication[]>("/green-track/applications?limit=1000"),
  });
  const [dialog, setDialog] = useState(false);
  const [editing, setEditing] = useState<GreenApplication | null>(null);
  const [deleting, setDeleting] = useState<GreenApplication | null>(null);
  const [presetMachine, setPresetMachine] = useState<number | undefined>();
  const [presetProduct, setPresetProduct] = useState<number | undefined>();

  useEffect(() => {
    if (!openNew) return;
    setEditing(null); setPresetMachine(openNew.machineId); setPresetProduct(openNew.productId); setDialog(true); onOpenNewHandled?.();
  }, [openNew]);

  const shown = useMemo(() => applications.filter(a =>
    !q
    || (a.operatorName ?? "").toLowerCase().includes(q)
    || (a.reason ?? "").toLowerCase().includes(q)
    || areaText(a).toLowerCase().includes(q)
    || a.products.some(p => p.productName.toLowerCase().includes(q) || (p.mappNumber ?? "").toLowerCase().includes(q)),
  ), [applications, q]);

  const remove = async () => {
    if (!deleting) return;
    try {
      await api(`/green-track/applications/${deleting.id}`, { method: "DELETE" });
      toast({ title: "Spraying record deleted", description: "The products went back on stock." });
      invalidate();
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    } finally { setDeleting(null); }
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground bg-muted/40 rounded-sm px-3 py-2 flex items-start gap-2 flex-1 min-w-[16rem]">
          <SprayCan className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Keep a record of every pesticide spray (keep them for at least 3 years), plus fertiliser and top dressing. The quantities used come off stock.</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="rounded-sm gap-1.5 h-8" disabled={!shown.length} onClick={() => downloadSprayingBook(shown)}>
            <Download className="w-3.5 h-3.5" /> Download
          </Button>
          <Button size="sm" className="rounded-sm gap-1.5 h-8" onClick={() => { setEditing(null); setPresetMachine(undefined); setPresetProduct(undefined); setDialog(true); }} data-testid="button-record-spraying">
            <Plus className="w-3.5 h-3.5" /> Record spraying
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading spraying book…</div>
      ) : shown.length === 0 ? (
        <div className="text-center py-10 border border-dashed rounded-sm">
          <SprayCan className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground">No spraying records yet.</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-border rounded-sm">
          <table className="w-full text-sm" data-testid="table-applications">
            <thead className="bg-muted/40 border-b border-border">
              <tr className="text-muted-foreground text-xs">
                <th className="text-left font-medium px-3 py-2">Date</th>
                <th className="text-left font-medium px-3 py-2">Where</th>
                <th className="text-left font-medium px-3 py-2">Products</th>
                <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Operator</th>
                <th className="text-left font-medium px-3 py-2 hidden lg:table-cell">Reason</th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map(a => (
                <tr key={a.id} data-testid={`application-row-${a.id}`}>
                  <td className="px-3 py-2 whitespace-nowrap align-top">
                    <p className="tabular-nums">{fmt(a.applicationDate)}</p>
                    <p className="text-xs text-muted-foreground">{[a.startTime && a.endTime ? `${a.startTime}–${a.endTime}` : a.startTime, METHOD_LABELS[a.method]].filter(Boolean).join(" · ")}</p>
                  </td>
                  <td className="px-3 py-2 align-top">
                    {areaText(a)}
                    {a.areaHectares != null && <span className="text-xs text-muted-foreground"> ({a.areaHectares} ha)</span>}
                  </td>
                  <td className="px-3 py-2 align-top">
                    {a.products.map(p => (
                      <p key={p.productId} className="whitespace-nowrap">
                        {p.productName} <span className="text-muted-foreground tabular-nums">{qty(p.quantityUsed, p.unit)}</span>
                      </p>
                    ))}
                  </td>
                  <td className="px-3 py-2 hidden md:table-cell align-top">
                    {a.operatorName ?? "—"}
                    {a.operatorCertificate && <p className="text-xs text-muted-foreground">{a.operatorCertificate}</p>}
                  </td>
                  <td className="px-3 py-2 hidden lg:table-cell text-muted-foreground align-top">{a.reason ?? "—"}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap align-top">
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Edit spraying record" onClick={() => { setEditing(a); setDialog(true); }}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    {canAdmin && (
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" aria-label="Delete spraying record" onClick={() => setDeleting(a)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ApplicationDialog open={dialog} onClose={() => { setDialog(false); setEditing(null); setPresetMachine(undefined); setPresetProduct(undefined); }}
        application={editing} presetMachineId={presetMachine} presetProductId={presetProduct} machines={machines} products={products} recent={applications} />
      <AlertDialog open={!!deleting} onOpenChange={v => !v && setDeleting(null)}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this spraying record?</AlertDialogTitle>
            <AlertDialogDescription>The products it used go back on stock. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
