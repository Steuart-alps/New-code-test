import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { setRecordSignatureHandler, type RecordSignatureRequest } from "@workspace/api-client-react";
import { apiFetch, getApiErrorMessage, setApiFetchRecordSignatureHandler } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RECORD_SIGNATURES_KEY, SIGNATURE_BOX, type SignatureStrokes } from "@/components/record-signature";

type Pending = RecordSignatureRequest & { resolve: (token: string | null) => void };

/** Canvas pixels per signature-box unit, so lines stay sharp on phones. */
const SCALE = 2;

/**
 * Asks for a drawn signature (finger, pen or mouse) when a recorded check is
 * saved. Registered once for the generated API client and `apiFetch`: the API
 * answers an unsigned save with 428 SIGNATURE_REQUIRED, this box stores the
 * drawing (POST /record-signatures) and the save is sent again with its
 * token. Cancelling leaves the save unsent. Saves that need a signature at the
 * same time are asked about one after another.
 */
export function RecordSignatureDialog() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState<Pending | null>(null);
  const queue = useRef<Pending[]>([]);
  const currentRef = useRef<Pending | null>(null);

  useEffect(() => {
    const showNext = () => {
      const next = queue.current.shift() ?? null;
      currentRef.current = next;
      setCurrent(next);
    };
    let mounted = true;
    const handler = (info: RecordSignatureRequest) => new Promise<string | null>((resolve) => {
      let settled = false;
      const pending: Pending = {
        ...info,
        resolve: (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
          if (mounted && currentRef.current === pending) showNext();
        },
      };
      queue.current.push(pending);
      if (!currentRef.current) showNext();
    });
    setRecordSignatureHandler(handler);
    setApiFetchRecordSignatureHandler(handler);
    return () => {
      mounted = false;
      setRecordSignatureHandler(null);
      setApiFetchRecordSignatureHandler(null);
      // Never leave a save waiting on a box that is gone.
      const waiting = [currentRef.current, ...queue.current.splice(0)];
      currentRef.current = null;
      for (const pending of waiting) pending?.resolve(null);
    };
  }, []);

  return (
    <Dialog open={current !== null} onOpenChange={(open) => { if (!open) current?.resolve(null); }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg rounded-sm">
        {current && (
          <SignatureForm
            key={`${current.method} ${current.url}`}
            message={current.message}
            signer={current.signedBy ?? user?.name ?? null}
            onCancel={() => current.resolve(null)}
            onSigned={(token) => {
              current.resolve(token);
              // The save goes again with the token; then show its signature in history.
              setTimeout(() => void queryClient.invalidateQueries({ queryKey: [RECORD_SIGNATURES_KEY] }), 2000);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SignatureForm({ message, signer, onCancel, onSigned }: {
  message: string;
  signer: string | null;
  onCancel: () => void;
  onSigned: (token: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<SignatureStrokes>([]);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    strokes.current = [];
    setHasInk(false);
    setError(null);
  }, []);

  function point(event: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.round(((event.clientX - bounds.left) / bounds.width) * SIGNATURE_BOX.width);
    const y = Math.round(((event.clientY - bounds.top) / bounds.height) * SIGNATURE_BOX.height);
    return [
      Math.min(SIGNATURE_BOX.width, Math.max(0, x)),
      Math.min(SIGNATURE_BOX.height, Math.max(0, y)),
    ];
  }

  function context() {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return null;
    ctx.lineWidth = 2.5 * SCALE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#162D42";
    return ctx;
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (saving) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const [x, y] = point(event);
    strokes.current.push([x, y]);
    const ctx = context();
    ctx?.beginPath();
    ctx?.moveTo(x * SCALE, y * SCALE);
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const stroke = strokes.current[strokes.current.length - 1];
    const [x, y] = point(event);
    // Skip points closer than 2 units to the last: keeps the stored signature small.
    if (Math.hypot(x - stroke[stroke.length - 2], y - stroke[stroke.length - 1]) < 2) return;
    stroke.push(x, y);
    const ctx = context();
    ctx?.lineTo(x * SCALE, y * SCALE);
    ctx?.stroke();
    setHasInk(true);
  }

  function stop(event: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function sign() {
    if (!hasInk || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await apiFetch("/record-signatures", {
        method: "POST",
        body: JSON.stringify({ strokes: strokes.current.filter(stroke => stroke.length >= 2) }),
      });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Your signature could not be saved. Please try again."));
      const { token } = await response.json() as { token: string };
      onSigned(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your signature could not be saved. Please try again.");
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>Sign to save</DialogTitle>
        <DialogDescription>
          {message === "Sign to save this record." ? "Every recorded check is signed." : message} Sign with your
          finger or mouse. Your signature is kept with this record, with your name and the time.
        </DialogDescription>
      </DialogHeader>
      {signer && <p className="text-sm">Signing as <strong>{signer}</strong></p>}
      <div className="relative">
        <canvas
          ref={canvasRef}
          width={SIGNATURE_BOX.width * SCALE}
          height={SIGNATURE_BOX.height * SCALE}
          aria-label="Draw your signature"
          data-testid="record-signature-canvas"
          className="block aspect-[3/1] w-full touch-none cursor-crosshair rounded-sm border-2 border-dashed border-border bg-white"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={stop}
          onPointerCancel={stop}
        />
        {!hasInk && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground/60 select-none">
            Sign here
          </span>
        )}
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <DialogFooter className="gap-2 sm:gap-0">
        <Button type="button" variant="ghost" disabled={saving || !hasInk} onClick={clear}>Clear</Button>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button type="button" disabled={saving || !hasInk} onClick={() => void sign()}>
          {saving ? "Saving…" : "Sign and save"}
        </Button>
      </DialogFooter>
    </div>
  );
}
