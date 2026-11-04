import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { PenLine } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Signature strokes: [x, y, x, y, ...] per stroke, inside SIGNATURE_BOX (matches the API). */
export type SignatureStrokes = number[][];
export const SIGNATURE_BOX = { width: 600, height: 200 } as const;

/** The record types the API asks a signature for (api-server lib/recordSignatures.ts). */
export type SignedRecordType =
  | "fire_safety_check" | "legionella_check" | "hot_tub_check" | "pool_check" | "tree_inspection"
  | "premises_inspection" | "room_check" | "coshh_check" | "pat_test" | "pest_visit"
  | "bike_service" | "bike_hire" | "bike_return"
  | "green_pre_use_check" | "green_service_record" | "green_puwer_inspection" | "green_application"
  | "swim_session" | "swim_surveillance_check" | "swim_first_aid_check"
  | "kitchen_weekly_review" | "kitchen_probe_check" | "kitchen_cleaning_log"
  | "daily_checklist" | "daily_manager_signoff" | "food_safety_record" | "daily_checklist_submission"
  | "compliance_item_completion";

export type RecordSignature = {
  recordType: SignedRecordType;
  recordId: number;
  signerName: string;
  signedAt: string;
  strokes: SignatureStrokes;
};

export const RECORD_SIGNATURES_KEY = "record-signatures";

function svgPath(strokes: SignatureStrokes): string {
  return strokes.map(stroke => {
    let d = `M${stroke[0]} ${stroke[1]}`;
    for (let i = 2; i < stroke.length; i += 2) d += `L${stroke[i]} ${stroke[i + 1]}`;
    return stroke.length === 2 ? `${d}L${stroke[0] + 1} ${stroke[1]}` : d;
  }).join("");
}

/** A drawn signature at any size (it keeps the 3:1 box). */
export function SignatureImage({ strokes, label, className }: { strokes: SignatureStrokes; label: string; className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${SIGNATURE_BOX.width} ${SIGNATURE_BOX.height}`}
      role="img"
      aria-label={label}
      className={cn("aspect-[3/1] rounded-sm border bg-white", className)}
    >
      <path d={svgPath(strokes)} fill="none" stroke="#162D42" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Rows on a page ask for their own signature; asks made together go to the
// API as one request per record type (at most 200 ids each).
type Waiter = { resolve: (rows: RecordSignature[]) => void; reject: (err: unknown) => void };
const batches = new Map<string, Map<number, Waiter[]>>();

function loadSignatures(recordType: SignedRecordType, recordId: number): Promise<RecordSignature[]> {
  return new Promise((resolve, reject) => {
    let batch = batches.get(recordType);
    if (!batch) {
      batch = new Map();
      batches.set(recordType, batch);
      setTimeout(() => void flush(recordType), 10);
    }
    const waiters = batch.get(recordId) ?? [];
    waiters.push({ resolve, reject });
    batch.set(recordId, waiters);
  });
}

async function flush(recordType: SignedRecordType) {
  const batch = batches.get(recordType);
  batches.delete(recordType);
  if (!batch) return;
  const ids = [...batch.keys()];
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200);
    try {
      const response = await apiFetch(`/record-signatures?recordType=${recordType}&ids=${chunk.join(",")}`);
      if (!response.ok) throw new Error(`Signatures could not be loaded (${response.status})`);
      const rows = await response.json() as RecordSignature[];
      for (const id of chunk) {
        const mine = rows.filter(row => row.recordId === id);
        for (const waiter of batch.get(id) ?? []) waiter.resolve(mine);
      }
    } catch (err) {
      for (const id of chunk) for (const waiter of batch.get(id) ?? []) waiter.reject(err);
    }
  }
}

export function useRecordSignatures(recordType: SignedRecordType, recordId: number | null | undefined) {
  const { activeClientId } = useAuth();
  return useQuery({
    queryKey: [RECORD_SIGNATURES_KEY, activeClientId, recordType, recordId],
    queryFn: () => loadSignatures(recordType, recordId!),
    enabled: typeof recordId === "number" && recordId > 0,
    staleTime: 30_000,
  });
}

/**
 * Who signed a recorded check, when, and their drawn signature. `compact` is
 * for table cells: the drawing alone, with the name and time as its tooltip.
 * `latest` shows only the newest, for records signed each time they are done.
 * Shows nothing for records saved before signatures were asked for.
 */
export function RecordSignedBy({ recordType, recordId, compact = false, latest = false, className }: {
  recordType: SignedRecordType;
  recordId: number | null | undefined;
  compact?: boolean;
  latest?: boolean;
  className?: string;
}) {
  const { data: all } = useRecordSignatures(recordType, recordId);
  if (!all || all.length === 0) return null;
  const data = latest ? all.slice(-1) : all;
  const describe = (signature: RecordSignature) =>
    `Signed by ${signature.signerName} on ${format(new Date(signature.signedAt), "d MMM yyyy 'at' HH:mm")}`;
  if (compact) {
    return (
      <span className={cn("inline-flex gap-1", className)} data-testid="record-signed-by">
        {data.map(signature => (
          <span key={`${signature.signedAt}-${signature.signerName}`} title={describe(signature)}>
            <SignatureImage strokes={signature.strokes} label={describe(signature)} className="h-7" />
          </span>
        ))}
      </span>
    );
  }
  return (
    <div className={cn("flex flex-wrap gap-3", className)} data-testid="record-signed-by">
      {data.map(signature => (
        <div key={`${signature.signedAt}-${signature.signerName}`} className="flex items-center gap-2 text-xs text-muted-foreground">
          <SignatureImage strokes={signature.strokes} label={`Signature of ${signature.signerName}`} className="h-10" />
          <span>
            <PenLine className="mr-1 inline h-3 w-3" aria-hidden="true" />
            Signed by <strong className="text-foreground">{signature.signerName}</strong>
            {" "}on {format(new Date(signature.signedAt), "d MMM yyyy 'at' HH:mm")}
          </span>
        </div>
      ))}
    </div>
  );
}
