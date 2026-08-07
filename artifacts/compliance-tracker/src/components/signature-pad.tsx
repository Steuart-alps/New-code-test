import { useRef, useEffect, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

interface SignaturePadProps {
  value?: string | null;          // existing base64 data URL
  onChange: (dataUrl: string | null) => void;
  label?: string;
  className?: string;
}

export function SignaturePad({ value, onChange, label = "Signature", className }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const [isEmpty, setIsEmpty] = useState(true);

  // Draw existing signature into canvas when value changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (value) {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0); };
      img.src = value;
      setIsEmpty(false);
    } else {
      setIsEmpty(true);
    }
  }, [value]);

  // Resize observer so canvas matches display size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      // Preserve content across resize
      const dataUrl = isEmpty ? null : canvas.toDataURL();
      const dpr = window.devicePixelRatio || 1;
      canvas.width  = canvas.offsetWidth  * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = "#162D42";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (dataUrl) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, canvas.offsetWidth, canvas.offsetHeight);
        img.src = dataUrl;
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [isEmpty]);

  function getPos(canvas: HTMLCanvasElement, e: MouseEvent | Touch) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function setupCtx(ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = "#162D42";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  function startDraw(pos: { x: number; y: number }) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawing.current = true;
    lastPos.current = pos;
    setupCtx(ctx);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 1, 0, Math.PI * 2);
    ctx.fillStyle = "#162D42";
    ctx.fill();
  }

  function moveDraw(pos: { x: number; y: number }) {
    if (!drawing.current || !lastPos.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    setupCtx(ctx);
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  }

  function endDraw() {
    if (!drawing.current) return;
    drawing.current = false;
    lastPos.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setIsEmpty(false);
    onChange(canvas.toDataURL("image/png"));
  }

  // Mouse handlers
  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    startDraw(getPos(e.currentTarget, e.nativeEvent));
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    moveDraw(getPos(e.currentTarget, e.nativeEvent));
  }, []);

  const onMouseUp = useCallback(() => endDraw(), []);

  // Touch handlers
  const onTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault(); // prevent scroll while signing
    const touch = e.touches[0];
    startDraw(getPos(e.currentTarget, touch as unknown as Touch));
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const touch = e.touches[0];
    moveDraw(getPos(e.currentTarget, touch as unknown as Touch));
  }, []);

  const onTouchEnd = useCallback(() => endDraw(), []);

  function clear() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setIsEmpty(true);
    onChange(null);
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {!isEmpty && (
          <Button type="button" variant="ghost" size="sm" onClick={clear}
            className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive gap-1">
            <RotateCcw className="w-3 h-3" /> Clear
          </Button>
        )}
      </div>
      <div className={cn(
        "relative rounded-sm border-2 transition-colors bg-white touch-none",
        isEmpty ? "border-dashed border-border" : "border-border"
      )}>
        <canvas
          ref={canvasRef}
          className="w-full rounded-sm cursor-crosshair"
          style={{ height: 120, display: "block" }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        />
        {isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-xs text-muted-foreground/50 select-none">Sign here with your finger or mouse</span>
          </div>
        )}
      </div>
    </div>
  );
}
